import { serialize, deserialize } from 'node:v8';
import StoreBase from './base.js';

const ACTION = Object.freeze({ CLEAR: 0, SET: 1, GET: 2, DELETE: 3, HAS: 4, METADATA: 5, ATTR_SET: 6, ATTR_GET: 7 });
const LOCATION = Object.freeze({ MEMORY: 0, SERVER: 1 });

class StoreClient extends StoreBase {
  // WebSocket-specific state
  _ws = null;
  _msgId = 0;
  _pendingRequests = new Map();
  _reconnect = true;
  _connecting = false;
  _retryAttempt = 0;
  _retryTimer = null;

  // connect-on-demand state
  _idleTimer = null;
  _connectPromise = null;
  _intentionalClose = false;

  // Exponential backoff constants (fixes B3)
  static RETRY_BASE_DELAY = 1000;
  static RETRY_MAX_DELAY = 300_000; // 5 minutes cap
  static IDLE_DISCONNECT_MS = 90_000; // disconnect after 90s of inactivity
  static CONNECT_TIMEOUT_MS = 10_000; // cap a single _send connect wait

  constructor(config = {}) {
    super(config);

    this.url = config?.url || 'ws://localhost:3000';
    this.config = config;
    this._WebSocketImpl = config?.webSocketImpl ?? globalThis.WebSocket;

    this.serverTTL = this._validateInt(config.serverTTL) ?? 1_200_000;
    this.connectTimeoutMs = this._validateInt(config.connectTimeoutMs) ?? StoreClient.CONNECT_TIMEOUT_MS;
  }

  async ready() {
    if (this._active) return;

    this._active = true;
    this._log('info', 'starting up');
    this._workerLoop = this._startQueueWorker();
    this._startMaintainer();
    this._log('info', 'startup completed (connect-on-demand mode)');
  }

  async close() {
    if (!this._active) return false;
    this._log('info', 'shutting down');

    clearTimeout(this._idleTimer);
    this._idleTimer = null;

    // Stop the worker before draining so they never run tasks concurrently
    await this._drainAndStopWorker();

    // Try to reach the server for a clean demote (keeps _reconnect=true so connect() works)
    const connected = await this._connectForShutdown(30_000);
    this._reconnect = false;
    clearTimeout(this._retryTimer);

    if (connected) {
      await this._demoteAll();
    } else {
      const unpersisted = [...this._metadata.values()].filter((m) => m.location === 0 && m.dataSizeV8 > 0).length;
      if (unpersisted > 0) {
        this._log('warn', `shutdown: server unreachable, ${unpersisted} items not persisted`);
      }
    }

    if (this._ws) {
      try {
        await this._send('close');
      } catch {
        // ignore
      }
      this._ws.close();
      this._ws = null;
    }

    return true;
  }

  // --- API StoreClient ---

  /**
   * Store a value.
   * @param {string}  key
   * @param {*}       data
   * @param {boolean|object} [options=false]  true → item gets serverTTL when demoted;
   *                                          false → item lives on server until deleted;
   *                                          object → { isCache: boolean, ttl: number }
   */
  async set(key, data, options = false) {
    if (typeof key !== 'string') throw new TypeError('key must be a string');
    this._stats.operations.set++;
    return this._addAction(ACTION.SET, key, data, options);
  }

  async get(key) {
    if (typeof key !== 'string') throw new TypeError('key must be a string');
    this._stats.operations.get++;
    return this._addAction(ACTION.GET, key);
  }

  async delete(key) {
    if (typeof key !== 'string') throw new TypeError('key must be a string');
    this._stats.operations.delete++;
    return this._addAction(ACTION.DELETE, key);
  }

  async clear() {
    this._stats.operations.clear++;
    return this._addAction(ACTION.CLEAR);
  }

  async has(key) {
    if (typeof key !== 'string') throw new TypeError('key must be a string');
    return this._addAction(ACTION.HAS, key);
  }

  async metadata(key) {
    if (typeof key !== 'string') throw new TypeError('key must be a string');
    return this._addAction(ACTION.METADATA, key);
  }

  async setAttr(key, value) {
    return this._addAction(ACTION.ATTR_SET, key, value);
  }

  async getAttr(key) {
    return this._addAction(ACTION.ATTR_GET, key);
  }

  // --- Stats (client-specific: uses itemsOnServer + connected) ---

  async getStats() {
    let itemsInMemory = 0;
    let itemsOnServer = 0;
    let dataBytes = 0;
    for (const m of this._metadata.values()) {
      if (m.location === LOCATION.MEMORY) {
        itemsInMemory++;
        if (m.dataSizeV8 > 0) dataBytes += m.dataSizeV8;
      } else {
        itemsOnServer++;
      }
    }

    const metaBytes = this._metadata.size > 0 ? serialize(this._metadata).length : 0;
    const totalBytes = dataBytes + metaBytes;

    const totalCacheOps = this._stats.cache.hits + this._stats.cache.misses;
    const hitRate = totalCacheOps > 0 ? ((this._stats.cache.hits / totalCacheOps) * 100).toFixed(2) : '0.00';

    const uptime = Date.now() - this._stats.lifecycle.startTime;

    return {
      uptime: this._formatDuration(uptime),
      uptimeMs: uptime,
      connected: this._ws?.readyState === this._WebSocketImpl.OPEN,
      operations: {
        ...this._stats.operations,
        total: Object.values(this._stats.operations).reduce((a, b) => a + b, 0),
      },
      cache: {
        ...this._stats.cache,
        hitRate: `${hitRate}%`,
        hitRateNumeric: parseFloat(hitRate),
      },
      storage: {
        totalItems: this._metadata.size,
        itemsInMemory,
        itemsOnServer,
        memoryUsage: {
          metadata: this._formatBytes(metaBytes),
          data: this._formatBytes(dataBytes),
          total: this._formatBytes(totalBytes),
        },
        memoryUsageBytes: { metadata: metaBytes, data: dataBytes, total: totalBytes },
        maxMemory: this._formatBytes(this.maxMemory),
        memoryUtilization: `${((totalBytes / this.maxMemory) * 100).toFixed(2)}%`,
      },
      queue: {
        current: this._queues.length,
        avg: this._queueLenSamples > 0 ? (this._queueLenSum / this._queueLenSamples).toFixed(2) : '0.00',
        max: this._stats.performance.maxQueueLength,
      },
      maintenance: {
        cycles: this._stats.performance.maintenanceCycles,
        lastDuration: `${this._stats.performance.lastMaintenanceDuration}ms`,
      },
      errors: {
        ...this._stats.errors,
        total: Object.values(this._stats.errors).reduce((a, b) => a + b, 0),
      },
    };
  }

  // --- Stats factory (client-specific error fields) ---

  _makeStats() {
    return {
      operations: { get: 0, set: 0, delete: 0, clear: 0 },
      cache: { hits: 0, misses: 0, promotions: 0, demotions: 0 },
      errors: { serverRead: 0, serverWrite: 0, serialize: 0, queue: 0 },
      performance: { maxQueueLength: 0, maintenanceCycles: 0, lastMaintenanceDuration: 0 },
      lifecycle: { startTime: Date.now() },
    };
  }

  // --- Allow ATTR actions even when store is inactive ---

  _isAlwaysAllowed(action) {
    return action === ACTION.ATTR_SET || action === ACTION.ATTR_GET;
  }

  // --- Task factory (client-specific: WebSocket I/O) ---

  /**
   * Create a task function for a given action.
   * @param {number} action
   * @param {string} [key]
   * @param {*} [data]
   * @param {*} [options]
   * @returns {() => Promise} async function returning the result value
   */
  _createTask(action, key, data, options) {
    switch (action) {
      case ACTION.CLEAR:
        return async () => {
          if (this.onDelete) {
            for (const [k, m] of this._metadata.entries()) {
              try {
                await this.onDelete(k, m);
              } catch {
                // ignore
              }
            }
          }
          this._metadata.clear();
          this._data.clear();
          try {
            await this._send('clear');
          } catch {
            // server might be down, ignore
          }
        };

      case ACTION.SET:
        return async () => {
          const isCache = typeof options === 'boolean' ? options : !!options?.isCache;
          const customTTL = typeof options === 'object' && typeof options?.ttl === 'number' ? options.ttl : null;

          const existing = this._metadata.get(key);
          const meta = existing ?? {
            created: Date.now(),
            isCache: !!isCache,
            customTTL: customTTL,
            lastAccess: Date.now(),
            accessCount: 0,
            location: LOCATION.MEMORY,
            dataSizeV8: 0,
            expired: customTTL ? Date.now() + customTTL : Date.now() + this.memoryTTL,
          };

          meta.accessCount = 0;
          meta.location = LOCATION.MEMORY;
          if (customTTL !== null) {
            meta.customTTL = customTTL;
            meta.expired = Date.now() + customTTL;
          }

          try {
            meta.dataSizeV8 = serialize(data).length;
          } catch (err) {
            this._stats.errors.serialize++;
            this._log('error', 'serialize failed for key', key, err);
            return;
          }

          meta.lastAccess = Date.now();
          if (customTTL === null) {
            meta.expired = Date.now() + this.memoryTTL;
          }
          this._data.set(key, data);
          this._metadata.set(key, meta);
        };

      case ACTION.GET:
        return async () => {
          const meta = this._metadata.get(key);

          // Check TTL before refreshing or promoting
          if (meta && Date.now() > meta.expired) {
            this._stats.cache.misses++;
            await this._delete(key);
            return;
          }

          // 1. Check memory first
          if (meta?.location === LOCATION.MEMORY) {
            meta.accessCount++;
            meta.lastAccess = Date.now();
            meta.expired = meta.customTTL ? Date.now() + meta.customTTL : Date.now() + this.memoryTTL;
            this._stats.cache.hits++;
            return this._data.get(key);
          }

          // fall back to server when memory missed
          if (!meta || meta.location === LOCATION.SERVER) {
            try {
              const value = await this._send('get', [key]);
              if (value !== undefined && value !== null) {
                this._stats.cache.promotions++;
                const newMeta = meta ?? {
                  created: Date.now(),
                  isCache: true,
                  customTTL: null,
                  lastAccess: Date.now(),
                  accessCount: 0,
                  location: LOCATION.MEMORY,
                  dataSizeV8: 0,
                  expired: Date.now() + this.memoryTTL,
                };

                newMeta.location = LOCATION.MEMORY;
                newMeta.lastAccess = Date.now();
                newMeta.expired = newMeta.customTTL ? Date.now() + newMeta.customTTL : Date.now() + this.memoryTTL;
                newMeta.accessCount++;
                try {
                  newMeta.dataSizeV8 = serialize(value).length;
                } catch {
                  // ignore
                }

                this._data.set(key, value);
                this._metadata.set(key, newMeta);
                this._stats.cache.hits++;
                return value;
              } else {
                this._stats.cache.misses++;
                return;
              }
            } catch (_err) {
              this._stats.errors.serverRead++;
              this._stats.cache.misses++;
              return;
            }
          }

          return;
        };

      case ACTION.DELETE:
        return async () => {
          await this._delete(key);
        };

      case ACTION.HAS:
        return async () => {
          return this._metadata.has(key);
        };

      case ACTION.METADATA:
        return async () => {
          return Object.assign({}, this._metadata.get(key) || {});
        };

      case ACTION.ATTR_SET:
        return async () => {
          try {
            await this._send('set-attr', [key, data]);
            return true;
          } catch {
            return false;
          }
        };

      case ACTION.ATTR_GET:
        return async () => {
          try {
            return await this._send('get-attr', [key]);
          } catch {
            return;
          }
        };

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  // --- Backend-specific delete ---

  async _deleteFromBackend(_key, meta) {
    if (meta.location === LOCATION.SERVER) {
      try {
        await this._send('delete', [_key]);
      } catch {
        // ignore
      }
    }
  }

  // --- Demote (memory → server) ---

  async _demote(key) {
    const meta = this._metadata.get(key);
    if (!meta || meta.dataSizeV8 < 1) return;

    try {
      const data = this._data.get(key);
      const options = { isCache: meta.isCache, ttl: meta.customTTL };
      await this._send('set', [key, data, options]);

      meta.location = LOCATION.SERVER;
      meta.expired = meta.isCache ? Date.now() + this.serverTTL : Infinity;
      if (meta.customTTL) meta.expired = Date.now() + meta.customTTL;

      this._data.delete(key);
      this._metadata.set(key, meta);
      this._stats.cache.demotions++;
      this._log('debug', 'demoted to server:', key);
    } catch (err) {
      meta.location = LOCATION.MEMORY;
      meta.expired = meta.customTTL ? Date.now() + meta.customTTL : Date.now() + this.memoryTTL;
      this._metadata.set(key, meta);
      this._stats.errors.serverWrite++;
      this._log('error', 'failed to demote key', key, err.message);
    }
  }

  async _demoteAll() {
    for (const [key, meta] of this._metadata.entries()) {
      if (meta.location === LOCATION.MEMORY && meta.dataSizeV8 > 0) {
        await this._demote(key);
      }
    }
  }

  // --- WebSocket connection ---

  _resetIdleTimer() {
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => this._disconnectIdle(), StoreClient.IDLE_DISCONNECT_MS).unref();
  }

  _disconnectIdle() {
    if (!this._ws) return;
    this._intentionalClose = true;
    this._ws.close();
  }

  async _connectForShutdown(timeoutMs) {
    if (this._ws?.readyState === this._WebSocketImpl.OPEN) return true;
    let timeoutId;
    // reuse in-flight connectPromise to avoid starting a duplicate connect
    const connectWait = this._connectPromise ?? this.connect();
    const result = await Promise.race([
      Promise.resolve(connectWait)
        .then(() => this._ws?.readyState === this._WebSocketImpl.OPEN)
        .catch(() => false),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve(false), timeoutMs).unref();
      }),
    ]);
    clearTimeout(timeoutId);
    return result;
  }

  async _ensureConnected() {
    if (this._ws?.readyState === this._WebSocketImpl.OPEN) return;
    if (!this._connectPromise && !this._connecting) {
      this._retryAttempt = 0; // start on-demand connect without backoff delay
      this._connectPromise = this.connect().finally(() => {
        this._connectPromise = null;
      });
    }
    return this._connectPromise;
  }

  // Bounded connect wait so a permanently unreachable server cannot
  // freeze the sequential queue forever (background retries continue)
  async _awaitConnection(timeoutMs) {
    if (this._ws?.readyState === this._WebSocketImpl.OPEN) return;
    let timeoutId;
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(resolve, timeoutMs).unref();
    });
    try {
      await Promise.race([Promise.resolve(this._ensureConnected()).catch(() => {}), timeout]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Schedule a reconnect with exponential backoff + jitter (fixes B3).
   * Mirrors the pattern from level_1.js for consistency.
   */
  _scheduleRetry(resolve) {
    if (!this._reconnect) {
      resolve?.();
      return;
    }

    const baseDelay = StoreClient.RETRY_BASE_DELAY * Math.pow(2, this._retryAttempt);
    const jitter = Math.random() * 1000;
    const delay = Math.min(baseDelay + jitter, StoreClient.RETRY_MAX_DELAY);

    this._log('info', `reconnecting in ${Math.round(delay / 1000)}s (attempt ${this._retryAttempt + 1})...`);

    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this.connect().then(resolve);
    }, delay).unref();
  }

  async connect() {
    if (!this._reconnect || this._connecting) return;
    this._connecting = true;

    return new Promise((resolve) => {
      this._log('info', `connecting to storage server at ${this.url}`);
      this._lastErrorMessage = null;

      const ws = new this._WebSocketImpl(this.url);
      ws.binaryType = 'arraybuffer';
      this._ws = ws;

      const wsListeners = [];
      const on = (type, listener) => {
        ws.addEventListener(type, listener);
        wsListeners.push({ type, listener });
      };
      const removeAll = () => {
        for (const { type, listener } of wsListeners) ws.removeEventListener(type, listener);
        wsListeners.length = 0;
      };

      on('open', async () => {
        this._connecting = false;
        this._retryAttempt = 0;
        try {
          // server uses its own diskPath, not ours
          const serverConfig = { ...this.config };
          delete serverConfig.diskPath;
          await this._send('new', [serverConfig]);
          await this._send('ready');
          this._log('info', 'connected to storage server');
        } catch (err) {
          this._log('error', 'failed to initialize server session', err.message);
        }
        resolve();
      });

      on('error', (event) => {
        this._connecting = false;
        clearTimeout(this._idleTimer); // stale idle timer must not fire on a new connection
        if (this._ws) {
          removeAll();
          ws.close();
          this._ws = null;
        }
        const msg = event.message || event.error?.message || 'unknown';
        this._log('warn', `server connection error: ${msg}`);
        this._retryAttempt++;
        this._scheduleRetry(resolve);
      });

      on('message', (event) => {
        try {
          const buffer = Buffer.from(event.data);
          const response = deserialize(buffer);
          const { id, data } = response;

          if (this._pendingRequests.has(id)) {
            const { resolve } = this._pendingRequests.get(id);
            resolve(data);
            this._pendingRequests.delete(id);
          }
        } catch (err) {
          this._log('error', 'deserialize failed:', err);
        }
      });

      on('close', (_event) => {
        this._connecting = false;
        clearTimeout(this._idleTimer); // stale idle timer must not fire on a new connection
        if (this._ws) {
          removeAll();
          this._ws = null;
        }
        if (this._intentionalClose) {
          // idle-initiated close — don't retry, wait for next on-demand connect
          this._intentionalClose = false;
          resolve();
        } else if (this._reconnect) {
          this._log('info', 'server connection closed, reconnecting...');
          this._retryAttempt++;
          this._scheduleRetry(resolve);
        } else {
          resolve();
        }
      });
    });
  }

  async _send(op, args = []) {
    // fast path — avoid microtask yield when already connected
    if (!this._ws || this._ws.readyState !== this._WebSocketImpl.OPEN) {
      await this._awaitConnection(this.connectTimeoutMs);
    }

    if (!this._ws || this._ws.readyState !== this._WebSocketImpl.OPEN) {
      return Promise.reject(new Error('WebSocket not connected'));
    }

    return new Promise((resolve, reject) => {
      const id = ++this._msgId;
      let settled = false;
      let timeout = null;

      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        this._pendingRequests.delete(id);
        fn(value);
      };

      this._pendingRequests.set(id, {
        resolve: (v) => settle(resolve, v),
        reject: (e) => settle(reject, e),
      });

      // Arm the timeout before send so a synchronous send error still clears it
      timeout = setTimeout(() => {
        if (this._pendingRequests.has(id)) {
          settle(reject, new Error('Request timed out'));
        }
      }, 30000).unref();

      const payload = JSON.stringify({ op, id, args });
      try {
        this._ws.send(payload);
        // reset idle timer only while the store is active (not during shutdown)
        if (this._active) this._resetIdleTimer();
      } catch (err) {
        settle(reject, err);
      }
    });
  }
}

export default StoreClient;
