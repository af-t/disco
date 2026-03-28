import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import v8 from 'node:v8';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { serialize, deserialize } from 'node:v8';

const ACTION = Object.freeze({ CLEAR: 0, SET: 1, GET: 2, DELETE: 3 });
const LOCATION = Object.freeze({ MEMORY: 0, DISK: 1 });

class StoreManager {
  _notifier  = null;
  _metadata  = new Map();
  _data      = new Map();
  _queues    = [];
  _active    = false;

  // Rolling queue-length accumulators for avgQueueLength
  _queueLenSum     = 0;
  _queueLenSamples = 0;

  /** @type {ReturnType<typeof this._makeStats>} */
  _stats = this._makeStats();

  /**
   * @param {object} [config]
   * @param {number} [config.memoryTTL]  ms items live in memory  (default 5 min)
   * @param {number} [config.diskTTL]    ms cache items live on disk (default 20 min)
   * @param {string} [config.diskPath]   directory for disk storage
   * @param {number} [config.maxMemory]  byte budget for in-memory data (default 30% of heap limit)
   * @param {object} [config.logger]     object with .info/.warn/.error/.debug methods
   */
  constructor(config = {}) {
    const heapLimit = v8.getHeapStatistics().heap_size_limit;

    // Use ?? instead of || so that an explicit 0 is not silently replaced by default.
    // _validateInt returns null for invalid input, triggering the ?? fallback.
    this.memoryTTL = this._validateInt(config.memoryTTL) ?? 300_000;
    this.diskTTL   = this._validateInt(config.diskTTL)   ?? 1_200_000;
    this.diskPath  = config.diskPath || join(process.cwd(), 'storage', 'db');
    this.maxMemory = this._validateInt(config.maxMemory) ?? Math.floor(heapLimit * 0.3);
    this.logger    = config.logger;
  }

  async ready() {
    if (this._active) return;

    this._active = true;
    this._log('info', 'starting up');
    this._startQueueWorker();
    this._startMaintainer();

    try {
      await fs.mkdir(this.diskPath, { recursive: true });
      await this._loadMetadataFromDisk();
      this._log('info', 'start completed');
    } catch {
      this._log('warn', 'disk unavailable, switching to memory-only mode');
      // Cap at heap limit rather than Infinity to avoid unbounded growth.
      this.maxMemory = v8.getHeapStatistics().heap_size_limit;
      this.memoryTTL = this.diskTTL;
      this.diskPath  = null;
    }
  }

  /**
   * Gracefully shut down: drain the queue, demote in-memory items to disk,
   * then persist metadata.  Returns a Promise so callers can await it.
   */
  async close() {
    if (!this._active) return false;
    this._log('info', 'shutting down');

    this._active = false;
    this._notifier?.(); // wake the sleeping worker so it can exit

    // Drain remaining queued tasks before demoting
    while (this._queues.length) {
      const task = this._queues.shift();
      try { await task(); } catch { /* already logged inside tasks */ }
    }

    await this._demoteAll();
    await this._saveMetadata();
    return true;
  }

  /**
   * Store a value.
   * @param {string}  key
   * @param {*}       data
   * @param {boolean} [isCache=false]  true → item gets diskTTL when demoted;
   *                                   false → item lives on disk until deleted
   */
  async set(key, data, isCache = false) {
    if (typeof key !== 'string') throw new TypeError('key must be a string');
    this._stats.operations.set++;
    return this._addAction(ACTION.SET, key, data, isCache);
  }

  /** Retrieve a value (or undefined if missing / expired). */
  async get(key) {
    if (typeof key !== 'string') throw new TypeError('key must be a string');
    this._stats.operations.get++;
    return this._addAction(ACTION.GET, key);
  }

  /** Delete a single key. */
  async delete(key) {
    if (typeof key !== 'string') throw new TypeError('key must be a string');
    this._stats.operations.delete++;
    return this._addAction(ACTION.DELETE, key);
  }

  /** Remove all keys and wipe the disk directory. */
  async clear() {
    this._stats.operations.clear++;
    return this._addAction(ACTION.CLEAR);
  }

  /** Returns true if the key exists (even if the value is on disk). */
  has(key) {
    return this._metadata.has(key);
  }

  /** Shallow copy of the metadata entry for `key`, or {} if not found. */
  metadata(key) {
    return Object.assign({}, this._metadata.get(key) ?? {});
  }

  getStats() {
    // Count memory / disk items without allocating intermediate arrays
    let itemsInMemory = 0;
    let itemsOnDisk   = 0;
    let dataBytes     = 0;
    for (const m of this._metadata.values()) {
      if (m.location === LOCATION.MEMORY) {
        itemsInMemory++;
        if (m.dataSizeV8 > 0) dataBytes += m.dataSizeV8;
      } else {
        itemsOnDisk++;
      }
    }

    // Metadata size is expensive to compute — only do it in getStats, not hot paths.
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
        itemsOnDisk,
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

  resetStats() {
    this._stats          = this._makeStats();
    this._queueLenSum    = 0;
    this._queueLenSamples = 0;
    this._log('info', 'stats have been reset');
  }

  _makeStats() {
    return {
      operations:  { get: 0, set: 0, delete: 0, clear: 0 },
      cache:       { hits: 0, misses: 0, promotions: 0, demotions: 0 },
      errors:      { diskRead: 0, diskWrite: 0, serialize: 0, queue: 0 },
      performance: { maxQueueLength: 0, maintenanceCycles: 0, lastMaintenanceDuration: 0 },
      lifecycle:   { startTime: Date.now() },
    };
  }

  _log(level, ...args) {
    this.logger?.[level]?.(...args);
  }

  /**
   * Parse an integer config value.  Returns null (not undefined/NaN) so that
   * callers can safely use the `??` nullish-coalescing operator.
   * Rejects strings like "100px" that parseInt would happily accept.
   */
  _validateInt(input) {
    if (input === null || input === undefined) return null;
    const n = Number(input);
    if (!Number.isInteger(n)) return null;
    return n;
  }

  _addAction(action, key, data, isCache) {
    if (!this._active) return Promise.resolve();

    return new Promise((resolve) => {
      let task;

      switch (action) {
        case ACTION.CLEAR:
          task = async () => {
            this._metadata.clear();
            this._data.clear();
            if (this.diskPath) {
              await fs.rm(this.diskPath, { force: true, recursive: true });
              await fs.mkdir(this.diskPath, { recursive: true });
            }
            resolve();
          };
          break;

        case ACTION.SET:
          task = async () => {
            const existing = this._metadata.get(key);
            const meta = existing ?? {
              created:      Date.now(),
              isCache:      !!isCache,
              lastAccess:   Date.now(),
              accessCount:  0,
              location:     LOCATION.MEMORY,
              locationFile: null,
              dataSizeV8:   0,
              expired:      Date.now() + this.memoryTTL,
            };

            meta.accessCount = 0;

            // Remove stale disk file if key was previously demoted
            if (meta.location === LOCATION.DISK) {
              try { await fs.rm(meta.locationFile); } catch { /* file may already be gone */ }
              meta.location = LOCATION.MEMORY;
            }

            try {
              meta.dataSizeV8 = serialize(data).length;
            } catch (err) {
              this._stats.errors.serialize++;
              this._log('error', 'serialize failed for key', key, err);
              // Data that cannot be serialized cannot be demoted to disk.
              // Refuse to store it so the caller is not silently misled.
              resolve();
              return;
            }

            meta.lastAccess = Date.now();
            meta.expired    = Date.now() + this.memoryTTL;
            this._data.set(key, data);
            this._metadata.set(key, meta);
            resolve();
          };
          break;

        case ACTION.GET:
          task = async () => {
            if (!this._metadata.has(key)) {
              this._stats.cache.misses++;
              resolve(undefined);
              return;
            }

            const meta = this._metadata.get(key);
            meta.accessCount++;
            meta.lastAccess = Date.now();

            if (meta.location === LOCATION.DISK) {
              // Check TTL before paying the I/O cost of promotion
              if (Date.now() > meta.expired) {
                this._stats.cache.misses++;
                await this._delete(key);
                resolve(undefined);
                return;
              }

              this._stats.cache.promotions++;
              this._log('debug', 'promoting from disk:', key);
              try {
                const raw = await fs.readFile(meta.locationFile);
                const value = deserialize(raw);
                meta.location = LOCATION.MEMORY;
                meta.expired  = Date.now() + this.memoryTTL;
                this._data.set(key, value);
                this._metadata.set(key, meta);
                await fs.rm(meta.locationFile).catch(() => {});
                this._stats.cache.hits++;
                resolve(value);
              } catch (err) {
                this._stats.errors.diskRead++;
                this._stats.cache.misses++;
                this._log('error', 'disk read error for key', key, err);
                resolve(undefined);
              }
              return;
            }

            // Memory hit — refresh sliding TTL
            meta.expired = Date.now() + this.memoryTTL;
            this._metadata.set(key, meta);
            this._stats.cache.hits++;
            resolve(this._data.get(key));
          };
          break;

        case ACTION.DELETE:
          task = async () => {
            await this._delete(key);
            resolve();
          };
          break;
      }

      this._queues.push(task);

      // Track queue length stats
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
    let idleCycles = 0;

    while (this._active) {
      let didWork = false;

      while (this._queues.length && this._active) {
        const task = this._queues.shift();
        try {
          await task();
        } catch (err) {
          this._stats.errors.queue++;
          this._log('error', 'queue task failed', err);
        }
        didWork = true;
      }

      if (didWork || this._queues.length > 0) {
        idleCycles = 0;
      } else {
        idleCycles++;
      }

      if (idleCycles >= 7) {
        idleCycles = 0;
        this._log('info', 'idle: sleeping until notified');

        // FIX: set _notifier synchronously, then check the queue one more
        // time inside the promise executor.  This closes the race window where
        // a task could arrive after the queue check but before _notifier is
        // assigned, causing it to be dropped silently.
        await new Promise((resolve) => {
          this._notifier = resolve;
          if (this._queues.length > 0) resolve(); // task sneaked in — wake immediately
        });
        this._notifier = null;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    }
  }

  async _startMaintainer() {
    while (this._active) {
      await new Promise((resolve) => setTimeout(resolve, 7_500));
      if (!this._active) break;

      let cycle        = 0;
      let cachedMetaLen = 0;
      let isFirst      = true;

      const maintenanceTask = async () => {
        const startTime = Date.now();

        // Recompute exact metadata size every 5 cycles; use cached value otherwise.
        if (++cycle > 5 || isFirst) {
          cachedMetaLen = serialize(this._metadata).length;
          cycle   = 0;
          isFirst = false;
        }

        let memTotal = cachedMetaLen;

        for (const [key] of this._metadata) {
          // Map is safe to iterate while deleting from it in JS; the guard below
          // handles keys that were deleted by a concurrent task.
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
          // Evict the 20% least-recently-accessed in-memory items.
          // Using lastAccess gives proper LRU semantics instead of raw accessCount.
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

    if (meta.location === LOCATION.DISK && meta.locationFile) {
      try { await fs.rm(meta.locationFile); } catch { /* already gone */ }
    }

    this._metadata.delete(key);
    this._data.delete(key);
    this._log('debug', 'deleted key:', key);
  }

  async _demote(key) {
    const meta = this._metadata.get(key);
    if (!meta || meta.dataSizeV8 < 1) return;

    if (!meta.locationFile) meta.locationFile = this._getLocation(key);

    try {
      const raw = serialize(this._data.get(key));
      await fs.mkdir(dirname(meta.locationFile), { recursive: true });
      await fs.writeFile(meta.locationFile, raw);

      meta.location = LOCATION.DISK;
      meta.expired  = meta.isCache ? Date.now() + this.diskTTL : Infinity;
      this._data.delete(key);
      this._metadata.set(key, meta);
      this._stats.cache.demotions++;
      this._log('debug', 'demoted to disk:', key);
    } catch (err) {
      meta.location = LOCATION.MEMORY;
      meta.expired  = Date.now() + this.memoryTTL;
      this._metadata.set(key, meta);
      this._stats.errors.diskWrite++;
      this._log('error', 'failed to demote key', key, err);
    }
  }

  /** Synchronous bulk-demote used only during shutdown (close()). */
  async _demoteAll() {
    for (const [key, meta] of this._metadata.entries()) {
      if (meta.location === LOCATION.MEMORY && meta.dataSizeV8 > 0) {
        await this._demote(key);
      }
    }
  }

  async _loadMetadataFromDisk() {
    const metadataPath = join(this.diskPath, 'metadata.dat');
    if (!fsSync.existsSync(metadataPath)) return;

    try {
      const data = await fs.readFile(metadataPath);
      this._metadata = deserialize(data);
      this._log('info', 'metadata loaded from disk');
    } catch (err) {
      this._log('error', 'metadata load failed', err);
    }
  }

  async _saveMetadata() {
    if (!this.diskPath) return;
    try {
      const data = serialize(this._metadata);
      await fs.writeFile(join(this.diskPath, 'metadata.dat'), data);
      this._log('debug', 'metadata saved');
    } catch (err) {
      this._log('error', 'failed to save metadata', err);
    }
  }

  /**
   * Derive a stable, filesystem-safe file path for a key using SHA-1.
   * The first two hex characters become a subdirectory (256 buckets),
   * keeping any single directory manageable.  Works correctly for empty keys,
   * very long keys, and keys with special characters.
   */
  _getLocation(key) {
    const hash = createHash('sha1').update(key).digest('hex');
    return join(this.diskPath, hash.slice(0, 2), hash.slice(2) + '.dat');
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

export default StoreManager;
