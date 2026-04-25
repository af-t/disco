import WebSocket from 'ws';
import v8 from 'node:v8';
import { serialize, deserialize } from 'node:v8';

const ACTION   = Object.freeze({ CLEAR: 0, SET: 1, GET: 2, DELETE: 3, HAS: 4, METADATA: 5, ATTR_SET: 6, ATTR_GET: 7 });
const LOCATION = Object.freeze({ MEMORY: 0, SERVER: 1 });

class StoreClient {
  onDelete   = null;
  _notifier  = null;
  _metadata  = new Map();
  _data      = new Map();
  _queues    = [];
  _active    = false;

  // Rolling queue-length accumulators for avgQueueLength
  _queueLenSum     = 0;
  _queueLenSamples = 0;

  _stats = this._makeStats();

  _ws = null;
  _msgId = 0;
  _pendingRequests = new Map();
  _reconnect = true;
  _connecting = false;

  constructor(config = {}) {
    this.url = config?.url || 'ws://localhost:3000';
    this.config = config;

    // Use ?? instead of || so that an explicit 0 is not silently replaced by default.
    this.memoryTTL = this._validateInt(config.memoryTTL) ?? 300_000;
    this.serverTTL = this._validateInt(config.serverTTL) ?? 1_200_000;

    const heapLimit = v8.getHeapStatistics().heap_size_limit;
    this.maxMemory = this._validateInt(config.maxMemory) ?? Math.floor(heapLimit * 0.3);
    this.logger    = config.logger?.createLogger?.('DB_CLIENT');
  }

  async ready() {
    if (this._active) return;

    this._active = true;
    this._log('info', 'starting up');
    this._startQueueWorker();
    this._startMaintainer();

    // Try to connect in the background, don't block the bot startup
    this.connect().catch(err => {
      this._log('warn', `initial server connection failed: ${err.message}, will retry in background`);
    });

    this._log('info', 'startup completed (memory-first mode)');
  }

  async close() {
    if (!this._active) return false;
    this._log('info', 'shutting down');

    this._active = false;
    this._reconnect = false;
    this._notifier?.(); // wake the sleeping worker so it can exit

    // Drain remaining queued tasks before demoting
    while (this._queues.length) {
      const task = this._queues.shift();
      try { await task(); } catch { /* already logged inside tasks */ }
    }

    await this._demoteAll();

    if (this._ws) {
      try { await this._send('close'); } catch { /* ignore */ }
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

  async getStats() {
    let itemsInMemory = 0;
    let itemsOnServer = 0;
    let dataBytes     = 0;
    for (const m of this._metadata.values()) {
      if (m.location === LOCATION.MEMORY) {
        itemsInMemory++;
        if (m.dataSizeV8 > 0) dataBytes += m.dataSizeV8;
      } else {
        itemsOnServer++;
      }
    }

    const metaBytes  = this._metadata.size > 0 ? serialize(this._metadata).length : 0;
    const totalBytes = dataBytes + metaBytes;

    const totalCacheOps = this._stats.cache.hits + this._stats.cache.misses;
    const hitRate = totalCacheOps > 0
      ? (this._stats.cache.hits / totalCacheOps * 100).toFixed(2)
      : '0.00';

    const uptime = Date.now() - this._stats.lifecycle.startTime;

    return {
      uptime:    this._formatDuration(uptime),
      uptimeMs:  uptime,
      connected: this._ws?.readyState === WebSocket.OPEN,
      operations: {
        ...this._stats.operations,
        total: Object.values(this._stats.operations).reduce((a, b) => a + b, 0),
      },
      cache: {
        ...this._stats.cache,
        hitRate:        `${hitRate}%`,
        hitRateNumeric: parseFloat(hitRate),
      },
      storage: {
        totalItems:    this._metadata.size,
        itemsInMemory,
        itemsOnServer,
        memoryUsage: {
          metadata: this._formatBytes(metaBytes),
          data:     this._formatBytes(dataBytes),
          total:    this._formatBytes(totalBytes),
        },
        memoryUsageBytes:   { metadata: metaBytes, data: dataBytes, total: totalBytes },
        maxMemory:          this._formatBytes(this.maxMemory),
        memoryUtilization:  `${((totalBytes / this.maxMemory) * 100).toFixed(2)}%`,
      },
      queue: {
        current: this._queues.length,
        avg:     this._queueLenSamples > 0
          ? (this._queueLenSum / this._queueLenSamples).toFixed(2)
          : '0.00',
        max: this._stats.performance.maxQueueLength,
      },
      maintenance: {
        cycles:       this._stats.performance.maintenanceCycles,
        lastDuration: `${this._stats.performance.lastMaintenanceDuration}ms`,
      },
      errors: {
        ...this._stats.errors,
        total: Object.values(this._stats.errors).reduce((a, b) => a + b, 0),
      },
    };
  }

  async resetStats() {
    this._stats          = this._makeStats();
    this._queueLenSum    = 0;
    this._queueLenSamples = 0;
    this._log('info', 'stats have been reset');
  }

  _makeStats() {
    return {
      operations:  { get: 0, set: 0, delete: 0, clear: 0 },
      cache:       { hits: 0, misses: 0, promotions: 0, demotions: 0 },
      errors:      { serverRead: 0, serverWrite: 0, serialize: 0, queue: 0 },
      performance: { maxQueueLength: 0, maintenanceCycles: 0, lastMaintenanceDuration: 0 },
      lifecycle:   { startTime: Date.now() },
    };
  }

  _log(level, ...args) {
    this.logger?.[level]?.(...args);
  }

  _validateInt(input) {
    if (input === null || input === undefined) return null;
    const n = Number(input);
    if (!Number.isInteger(n)) return null;
    return n;
  }

  _addAction(action, key, data, options) {
    if (!this._active && action !== ACTION.ATTR_SET && action !== ACTION.ATTR_GET) return Promise.resolve();

    return new Promise((resolve) => {
      let task;

      switch (action) {
        case ACTION.CLEAR:
          task = async () => {
            if (this.onDelete) {
              for (const [k, m] of this._metadata.entries()) {
                try { await this.onDelete(k, m); } catch { /* ignore */ }
              }
            }
            this._metadata.clear();
            this._data.clear();
            try { await this._send('clear'); } catch { /* server might be down, ignore */ }
            resolve();
          };
          break;

        case ACTION.SET:
          task = async () => {
            const isCache = typeof options === 'boolean' ? options : !!options?.isCache;
            const customTTL = (typeof options === 'object' && typeof options?.ttl === 'number') ? options.ttl : null;

            const existing = this._metadata.get(key);
            const meta = existing ?? {
              created:      Date.now(),
              isCache:      !!isCache,
              customTTL:    customTTL,
              lastAccess:   Date.now(),
              accessCount:  0,
              location:     LOCATION.MEMORY,
              dataSizeV8:   0,
              expired:      customTTL ? (Date.now() + customTTL) : (Date.now() + this.memoryTTL),
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
              resolve();
              return;
            }

            meta.lastAccess = Date.now();
            if (customTTL === null) {
              meta.expired = Date.now() + this.memoryTTL;
            }
            this._data.set(key, data);
            this._metadata.set(key, meta);
            resolve();
          };
          break;

        case ACTION.GET:
          task = async () => {
            const meta = this._metadata.get(key);

            // Check TTL before refreshing or promoting
            if (meta && Date.now() > meta.expired) {
              this._stats.cache.misses++;
              await this._delete(key);
              resolve();
              return;
            }

            // 1. Check memory first
            if (meta?.location === LOCATION.MEMORY) {
              meta.accessCount++;
              meta.lastAccess = Date.now();
              meta.expired = meta.customTTL ? (Date.now() + meta.customTTL) : (Date.now() + this.memoryTTL);
              this._stats.cache.hits++;
              resolve(this._data.get(key));
              return;
            }

            // 2. Check server (if we know it's there OR we don't know it's NOT there)
            // If we don't have meta, we check server to support cold-start / persistent server data.
            if (!meta || meta.location === LOCATION.SERVER) {
              this._stats.cache.promotions++;
              try {
                const value = await this._send('get', [key]);
                if (value !== undefined && value !== null) {
                  const newMeta = meta ?? {
                    created:      Date.now(),
                    isCache:      true,
                    customTTL:    null,
                    lastAccess:   Date.now(),
                    accessCount:  0,
                    location:     LOCATION.MEMORY,
                    dataSizeV8:   0,
                    expired:      Date.now() + this.memoryTTL,
                  };

                  newMeta.location = LOCATION.MEMORY;
                  newMeta.lastAccess = Date.now();
                  newMeta.expired = newMeta.customTTL ? (Date.now() + newMeta.customTTL) : (Date.now() + this.memoryTTL);
                  newMeta.accessCount++;
                  try { newMeta.dataSizeV8 = serialize(value).length; } catch { /* ignore */ }

                  this._data.set(key, value);
                  this._metadata.set(key, newMeta);
                  this._stats.cache.hits++;
                  resolve(value);
                } else {
                  this._stats.cache.misses++;
                  resolve();
                }
              } catch (err) {
                this._stats.errors.serverRead++;
                this._stats.cache.misses++;
                // If server is down, we can't confirm it's not there, so we just return undefined
                resolve();
              }
              return;
            }

            resolve();
          };
          break;

        case ACTION.DELETE:
          task = async () => {
            await this._delete(key);
            resolve();
          };
          break;
        case ACTION.HAS:
          task = async () => resolve(this._metadata.has(key));
          break;
        case ACTION.METADATA:
          task = async () => resolve(Object.assign({}, this._metadata.get(key) || {}));
          break;
        case ACTION.ATTR_SET:
          task = async () => {
            try { 
              await this._send('set-attr', [key, data]);
              resolve(true);
            } catch {
              resolve(false);
            }
          };
          break;
        case ACTION.ATTR_GET:
          task = async () => {
            try {
              const res = await this._send('get-attr', [key]);
              resolve(res);
            } catch {
              resolve();
            }
          };
          break;
      }

      this._queues.push(task);

      const len = this._queues.length;
      this._queueLenSum += len;
      this._queueLenSamples++;
      if (len > this._stats.performance.maxQueueLength) {
        this._stats.performance.maxQueueLength = len;
      }

      this._notifier?.();
    });
  }

  async _startQueueWorker() {
    while (this._active) {
      // Process all pending tasks
      while (this._queues.length && this._active) {
        const task = this._queues.shift();
        try {
          await task();
        } catch (err) {
          this._stats.errors.queue++;
          this._log('error', 'queue task failed', err);
        }
      }

      if (!this._active) break;

      // Wait for new tasks
      await new Promise((resolve) => {
        this._notifier = resolve;
        // Check again in case a task was added after the loop but before setting notifier
        if (this._queues.length > 0) resolve();
      });
      this._notifier = null;
    }
  }

  async _startMaintainer() {
    while (this._active) {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      if (!this._active) break;

      const maintenanceTask = async () => {
        const startTime = Date.now();
        let memTotal = serialize(this._metadata).length;

        for (const [key] of this._metadata) {
          if (!this._metadata.has(key)) continue;
          const m = this._metadata.get(key);

          if (Date.now() > m.expired) {
            if (m.location === LOCATION.MEMORY) {
              await this._demote(key);
            } else {
              await this._delete(key);
            }
            continue;
          }

          if (m.location === LOCATION.MEMORY && m.dataSizeV8 > 0) {
            memTotal += m.dataSizeV8;
          }
        }

        if (memTotal > this.maxMemory) {
          const candidates = Array.from(this._metadata.entries())
            .filter(([, m]) => m.location === LOCATION.MEMORY && m.dataSizeV8 > 0)
            .sort(([, a], [, b]) => a.lastAccess - b.lastAccess)
            .slice(0, Math.ceil(this._metadata.size * 0.2));

          for (const [key] of candidates) {
            await this._demote(key);
          }
        }

        this._stats.performance.maintenanceCycles++;
        this._stats.performance.lastMaintenanceDuration = Date.now() - startTime;
      };

      this._queues.push(maintenanceTask);
      this._notifier?.();
    }
  }

  async _delete(key) {
    const meta = this._metadata.get(key);
    if (!meta) return;

    if (this.onDelete) {
      try {
        await this.onDelete(key, meta);
      } catch (err) {
        this._log('error', 'onDelete hook failed for key', key, err);
      }
    }

    if (meta.location === LOCATION.SERVER) {
      try { await this._send('delete', [key]); } catch { /* ignore */ }
    }

    this._metadata.delete(key);
    this._data.delete(key);
    this._log('debug', 'deleted key:', key);
  }

  async _demote(key) {
    const meta = this._metadata.get(key);
    if (!meta || meta.dataSizeV8 < 1) return;

    try {
      const data = this._data.get(key);
      const options = { isCache: meta.isCache, ttl: meta.customTTL };
      await this._send('set', [key, data, options]);

      meta.location = LOCATION.SERVER;
      meta.expired  = meta.isCache ? (Date.now() + this.serverTTL) : Infinity;
      if (meta.customTTL) meta.expired = Date.now() + meta.customTTL;
      
      this._data.delete(key);
      this._metadata.set(key, meta);
      this._stats.cache.demotions++;
      this._log('debug', 'demoted to server:', key);
    } catch (err) {
      meta.location = LOCATION.MEMORY;
      meta.expired  = meta.customTTL ? (Date.now() + meta.customTTL) : (Date.now() + this.memoryTTL);
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

  async connect() {
    if (!this._reconnect || this._connecting) return;
    this._connecting = true;

    return new Promise((resolve) => {
      this._log('info', `connecting to storage server at ${this.url}`);
      this._ws = new WebSocket(this.url);

      this._ws.on('open', async () => {
        this._connecting = false;
        try {
          this._ws._socket.setNoDelay(true);
          await this._send('new', [this.config]);
          await this._send('ready');
          this._log('info', 'connected to storage server');
        } catch (err) {
          this._log('error', 'failed to initialize server session', err.message);
        }
        resolve();
      });

      this._ws.on('error', (err) => {
        this._connecting = false;
        if (this._ws) {
          this._ws.removeAllListeners();
          this._ws.terminate();
          this._ws = null;
        }
        this._log('warn', `server connection error: ${err.message}, retrying in 5s...`);
        if (this._reconnect) {
          setTimeout(() => this.connect().then(resolve), 5000);
        } else {
          resolve();
        }
      });

      this._ws.on('message', (buffer) => {
        try {
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

      this._ws.on('close', () => {
        this._connecting = false;
        if (this._ws) {
          this._ws.removeAllListeners();
          this._ws = null;
        }
        if (this._reconnect) {
          this._log('info', 'server connection closed, reconnecting in 5s...');
          setTimeout(() => this.connect().then(resolve), 5000);
        } else {
          resolve();
        }
      });
    });
  }

  _send(op, args = []) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket not connected'));
    }

    return new Promise((resolve, reject) => {
      const id = ++this._msgId;
      this._pendingRequests.set(id, { resolve, reject });

      const payload = JSON.stringify({ op, id, args });
      this._ws.send(payload, (err) => {
        if (err) {
          this._pendingRequests.delete(id);
          reject(err);
        }
      });

      // Safety timeout
      setTimeout(() => {
        if (this._pendingRequests.has(id)) {
          const { reject: timeoutReject } = this._pendingRequests.get(id);
          this._pendingRequests.delete(id);
          timeoutReject(new Error('Request timed out'));
        }
      }, 30000);
    });
  }

  _formatBytes(bytes) {
    if (bytes === 0)        return '0 B';
    if (bytes === Infinity) return '∞';
    const k     = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i     = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  }

  _formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours   = Math.floor(minutes / 60);
    const days    = Math.floor(hours / 24);
    if (days    > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours   > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }
}

export default StoreClient;
