import { serialize, deserialize } from 'node:v8';
import StoreBase, { ACTION, LOCATION } from './base.js';
import utility from '../lib/utility.js';

const { unrefTimeout } = utility;

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

  async setAttr(key, value) {
    return this._addAction(ACTION.ATTR_SET, key, value);
  }

  async getAttr(key) {
    return this._addAction(ACTION.ATTR_GET, key);
  }

  // --- Stats (client-specific: uses itemsOnServer + connected) ---

  async getStats() {
    const stats = await super.getStats();
    stats.connected = this._ws?.readyState === this._WebSocketImpl.OPEN;
    stats.storage.itemsOnServer = stats.storage.itemsOnBackend;
    delete stats.storage.itemsOnBackend;
    return stats;
  }

  // --- Stats factory (client-specific error fields) ---

  _makeStats() {
    const stats = super._makeStats();
    stats.errors.serverRead = 0;
    stats.errors.serverWrite = 0;
    stats.errors.serialize = 0;
    return stats;
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
          await this._executeClear();
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

          this._updateMemoryMeta(key, data, meta, customTTL);
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
              const response = await this._send('getWithMetadata', [key]);
              // real value+metadata shape, vs. a legacy plain-value response
              const hasMetadataShape =
                response && typeof response === 'object' && !Array.isArray(response) && 'value' in response;
              const value = hasMetadataShape ? response.value : response;
              const serverMeta = hasMetadataShape ? response.metadata : null;

              if (value !== undefined && value !== null) {
                this._stats.cache.promotions++;
                const newMeta = meta ?? {
                  created: Date.now(),
                  // an old server with no metadata endpoint: guess cache (legacy behavior)
                  isCache: serverMeta ? !!serverMeta.isCache : true,
                  customTTL: serverMeta ? (serverMeta.customTTL ?? null) : null,
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

      default:
        return super._createTask(action, key, data, options);

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
    this._idleTimer = unrefTimeout(() => this._disconnectIdle(), StoreClient.IDLE_DISCONNECT_MS);
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
        timeoutId = unrefTimeout(() => resolve(false), timeoutMs);
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
      timeoutId = unrefTimeout(resolve, timeoutMs);
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
    this._retryTimer = unrefTimeout(() => {
      this._retryTimer = null;
      this.connect().then(resolve);
    }, delay);
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
      timeout = unrefTimeout(() => {
        if (this._pendingRequests.has(id)) {
          settle(reject, new Error('Request timed out'));
        }
      }, 30000);

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
