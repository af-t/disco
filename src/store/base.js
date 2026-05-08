import v8 from 'node:v8';
import { serialize } from 'node:v8';

/**
 * Abstract base class for StoreManager and StoreClient.
 * Contains shared queue processing, maintenance, stats, and utility methods.
 */
class StoreBase {
  onDelete = null;
  _notifier = null;
  _metadata = new Map();
  _data = new Map();
  _queues = [];
  _active = false;

  // Rolling queue-length accumulators
  _queueLenSum = 0;
  _queueLenSamples = 0;

  /** @type {ReturnType<typeof this._makeStats>} */
  _stats = this._makeStats();

  /**
   * @param {object} [config]
   * @param {number} [config.memoryTTL]  ms items live in memory
   * @param {number} [config.maxMemory]  byte budget for in-memory data
   * @param {object} [config.logger]     logger object
   */
  constructor(config = {}) {
    const heapLimit = v8.getHeapStatistics().heap_size_limit;

    this.memoryTTL = this._validateInt(config.memoryTTL) ?? 300_000;
    this.maxMemory = this._validateInt(config.maxMemory) ?? Math.floor(heapLimit * 0.3);
    this.logger = config.logger?.createLogger?.(this.constructor.name);
  }

  // --- Public API (implemented in subclasses) ---

  /** @abstract */
  async set(_key, _data, _options) {
    throw new Error('Not implemented');
  }
  /** @abstract */
  async get(_key) {
    throw new Error('Not implemented');
  }
  /** @abstract */
  async delete(_key) {
    throw new Error('Not implemented');
  }
  /** @abstract */
  async clear() {
    throw new Error('Not implemented');
  }

  async has(key) {
    if (typeof key !== 'string') throw new TypeError('key must be a string');
    return this._addAction('HAS', key);
  }

  async metadata(key) {
    if (typeof key !== 'string') throw new TypeError('key must be a string');
    return this._addAction('METADATA', key);
  }

  // --- Stats ---

  async getStats() {
    let itemsInMemory = 0;
    let itemsOnBackend = 0;
    let dataBytes = 0;
    for (const m of this._metadata.values()) {
      if (m.location === 0) {
        // LOCATION.MEMORY
        itemsInMemory++;
        if (m.dataSizeV8 > 0) dataBytes += m.dataSizeV8;
      } else {
        itemsOnBackend++;
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
        itemsOnBackend,
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

  async resetStats() {
    this._stats = this._makeStats();
    this._queueLenSum = 0;
    this._queueLenSamples = 0;
    this._log('info', 'stats have been reset');
  }

  // --- Internal helpers ---

  _makeStats() {
    return {
      operations: { get: 0, set: 0, delete: 0, clear: 0 },
      cache: { hits: 0, misses: 0, promotions: 0, demotions: 0 },
      errors: { queue: 0 },
      performance: { maxQueueLength: 0, maintenanceCycles: 0, lastMaintenanceDuration: 0 },
      lifecycle: { startTime: Date.now() },
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

  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    if (bytes === Infinity) return '∞';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  }

  _formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  _enqueueTask(task) {
    this._queues.push(task);
    const len = this._queues.length;
    this._queueLenSum += len;
    this._queueLenSamples++;
    if (len > this._stats.performance.maxQueueLength) {
      this._stats.performance.maxQueueLength = len;
    }
    this._notifier?.();
  }

  /**
   * Create a Promise-based action and enqueue it.
   * @param {string} action - Action name
   * @param {...*} args - Arguments for the task factory
   * @returns {Promise}
   */
  /**
   * Override in subclass to allow specific actions even when store is inactive.
   * @param {*} action
   * @returns {boolean}
   */
  _isAlwaysAllowed(_action) {
    return false;
  }

  _addAction(action, ...args) {
    if (!this._active && !this._isAlwaysAllowed(action)) return Promise.resolve();
    const task = this._createTask(action, ...args);
    return new Promise((resolve) => {
      this._enqueueTask(async () => {
        try {
          const result = await task();
          resolve(result);
        } catch (err) {
          this._stats.errors.queue++;
          this._log('error', 'queue task failed', err);
          resolve();
        }
      });
    });
  }

  /**
   * Override in subclass to create the actual work function for an action.
   * @param {string} action
   * @param {...*} args
   * @returns {() => Promise} function that resolves with the result value
   */
  _createTask(action, ..._args) {
    throw new Error(`_createTask not implemented for action: ${action}`);
  }

  // --- Queue Worker ---

  async _startQueueWorker() {
    while (this._active) {
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

      await new Promise((resolve) => {
        this._notifier = resolve;
        if (this._queues.length > 0) resolve();
      });
      this._notifier = null;
    }
  }

  // --- Maintainer ---

  async _startMaintainer() {
    while (this._active) {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      if (!this._active) break;

      let cycle = 0;
      let cachedMetaLen = 0;
      let isFirst = true;

      const self = this;
      const maintenanceTask = async () => {
        const startTime = Date.now();

        if (++cycle > 5 || isFirst) {
          cachedMetaLen = serialize(self._metadata).length;
          cycle = 0;
          isFirst = false;
        }

        let memTotal = cachedMetaLen;

        for (const [key] of self._metadata) {
          if (!self._metadata.has(key)) continue;
          const m = self._metadata.get(key);

          if (Date.now() > m.expired) {
            if (m.location === 0) {
              // MEMORY
              await self._demote(key);
            } else {
              await self._delete(key);
            }
            continue;
          }

          if (m.location === 0 && m.dataSizeV8 > 0) {
            memTotal += m.dataSizeV8;
          }
        }

        if (memTotal > self.maxMemory) {
          const candidates = Array.from(self._metadata.entries())
            .filter(([, m]) => m.location === 0 && m.dataSizeV8 > 0)
            .sort(([, a], [, b]) => a.lastAccess - b.lastAccess)
            .slice(0, Math.ceil(self._metadata.size * 0.2));

          for (const [key] of candidates) {
            await self._demote(key);
          }
        }

        self._stats.performance.maintenanceCycles++;
        self._stats.performance.lastMaintenanceDuration = Date.now() - startTime;
      };

      this._queues.push(maintenanceTask);
      this._notifier?.();
    }
  }

  // --- Delete & Demote (backend-specific parts in subclass) ---

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

    // Subclass handles backend cleanup
    await this._deleteFromBackend(key, meta);

    this._metadata.delete(key);
    this._data.delete(key);
    this._log('debug', 'deleted key:', key);
  }

  /** @abstract */
  async _deleteFromBackend(_key, _meta) {
    // Override in subclass
  }

  /** @abstract */
  async _demote(_key) {
    throw new Error('Not implemented');
  }

  /** @abstract */
  async _demoteAll() {
    throw new Error('Not implemented');
  }
}

export default StoreBase;
