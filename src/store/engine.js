import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import v8 from 'node:v8';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { serialize, deserialize } from 'node:v8';
import StoreBase from './base.js';

const ACTION = Object.freeze({ CLEAR: 0, SET: 1, GET: 2, DELETE: 3, HAS: 4, METADATA: 5 });
const LOCATION = Object.freeze({ MEMORY: 0, DISK: 1 });

class StoreManager extends StoreBase {
  /**
   * @param {object} [config]
   * @param {number} [config.memoryTTL]  ms items live in memory  (default 5 min)
   * @param {number} [config.diskTTL]    ms cache items live on disk (default 20 min)
   * @param {string} [config.diskPath]   directory for disk storage
   * @param {number} [config.maxMemory]  byte budget for in-memory data (default 30% of heap limit)
   * @param {object} [config.logger]     object with .info/.warn/.error/.debug methods
   */
  constructor(config = {}) {
    super(config);

    this.diskTTL = this._validateInt(config.diskTTL) ?? 1_200_000;
    this.diskPath = config.diskPath || join(process.cwd(), 'storage', 'db');
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
      this.diskPath = null;
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
      try {
        await task();
      } catch {
        /* already logged inside tasks */
      }
    }

    await this._demoteAll();
    await this._saveMetadata();
    return true;
  }

  /**
   * Store a value.
   * @param {string}  key
   * @param {*}       data
   * @param {boolean|object} [options=false]  true → item gets diskTTL when demoted;
   *                                          false → item lives on disk until deleted;
   *                                          object → { isCache: boolean, ttl: number }
   */
  async set(key, data, options = false) {
    if (typeof key !== 'string') throw new TypeError('key must be a string');
    this._stats.operations.set++;
    return this._addAction(ACTION.SET, key, data, options);
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
  async has(key) {
    if (typeof key !== 'string') throw new TypeError('key must be a string');
    return this._addAction(ACTION.HAS, key);
  }

  /** Shallow copy of the metadata entry for `key`, or {} if not found. */
  async metadata(key) {
    if (typeof key !== 'string') throw new TypeError('key must be a string');
    return this._addAction(ACTION.METADATA, key);
  }

  // --- Stats (engine-specific: uses itemsOnDisk) ---

  async getStats() {
    let itemsInMemory = 0;
    let itemsOnDisk = 0;
    let dataBytes = 0;
    for (const m of this._metadata.values()) {
      if (m.location === LOCATION.MEMORY) {
        itemsInMemory++;
        if (m.dataSizeV8 > 0) dataBytes += m.dataSizeV8;
      } else {
        itemsOnDisk++;
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
        itemsOnDisk,
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

  // --- Stats factory (engine-specific error fields) ---

  _makeStats() {
    return {
      operations: { get: 0, set: 0, delete: 0, clear: 0 },
      cache: { hits: 0, misses: 0, promotions: 0, demotions: 0 },
      errors: { diskRead: 0, diskWrite: 0, serialize: 0, queue: 0 },
      performance: { maxQueueLength: 0, maintenanceCycles: 0, lastMaintenanceDuration: 0 },
      lifecycle: { startTime: Date.now() },
    };
  }

  // --- Task factory (engine-specific: disk I/O) ---

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
                /* ignore */
              }
            }
          }
          this._metadata.clear();
          this._data.clear();
          if (this.diskPath) {
            await fs.rm(this.diskPath, { force: true, recursive: true });
            await fs.mkdir(this.diskPath, { recursive: true });
          }
        };

      case ACTION.SET:
        return async () => {
          const isCache = typeof options === 'boolean' ? options : !!options?.isCache;
          const customTTL = typeof options === 'object' ? options?.ttl : null;

          const existing = this._metadata.get(key);
          const meta = existing ?? {
            created: Date.now(),
            isCache: !!isCache,
            lastAccess: Date.now(),
            accessCount: 0,
            location: LOCATION.MEMORY,
            locationFile: null,
            dataSizeV8: 0,
            expired: customTTL ? Date.now() + customTTL : Date.now() + this.memoryTTL,
          };

          meta.accessCount = 0;
          if (customTTL !== null) {
            meta.customTTL = customTTL;
            meta.expired = Date.now() + customTTL;
          }

          // Remove stale disk file if key was previously demoted
          if (meta.location === LOCATION.DISK) {
            try {
              await fs.rm(meta.locationFile);
            } catch {
              /* file may already be gone */
            }
            meta.location = LOCATION.MEMORY;
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
          if (!this._metadata.has(key)) {
            this._stats.cache.misses++;
            return;
          }

          const meta = this._metadata.get(key);

          // Check TTL before refreshing or promoting
          if (Date.now() > meta.expired) {
            this._stats.cache.misses++;
            await this._delete(key);
            return;
          }

          meta.accessCount++;
          meta.lastAccess = Date.now();

          if (meta.location === LOCATION.DISK) {
            if (!fsSync.existsSync(meta.locationFile)) {
              const suff = meta.locationFile.includes('/')
                ? meta.locationFile.split('/').slice(-2).join('/')
                : meta.locationFile.split('\\').slice(-2).join('\\');
              const newPath = join(this.diskPath, suff);
              if (fsSync.existsSync(newPath)) {
                meta.locationFile = newPath;
              }
            }

            // Check TTL before paying the I/O cost of promotion
            if (Date.now() > meta.expired) {
              this._stats.cache.misses++;
              await this._delete(key);
              return;
            }

            this._stats.cache.promotions++;
            this._log('debug', 'promoting from disk:', key);
            try {
              const raw = await fs.readFile(meta.locationFile);
              const value = deserialize(raw);
              meta.location = LOCATION.MEMORY;
              meta.expired = meta.customTTL ? Date.now() + meta.customTTL : Date.now() + this.memoryTTL;
              this._data.set(key, value);
              this._metadata.set(key, meta);
              await fs
                .rm(meta.locationFile)
                .catch((err) =>
                  this._log('debug', 'cleanup: failed to remove disk file', meta.locationFile, err?.message),
                );
              this._stats.cache.hits++;
              return value;
            } catch (err) {
              this._stats.errors.diskRead++;
              this._stats.cache.misses++;
              this._log('error', 'disk read error for key', key, err);
              return;
            }
          }

          // Memory hit — refresh sliding TTL
          meta.expired = meta.customTTL ? Date.now() + meta.customTTL : Date.now() + this.memoryTTL;
          this._metadata.set(key, meta);
          this._stats.cache.hits++;
          return this._data.get(key);
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

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  // --- Backend-specific delete ---

  async _deleteFromBackend(_key, meta) {
    if (meta.location === LOCATION.DISK && meta.locationFile) {
      try {
        await fs.rm(meta.locationFile);
      } catch {
        /* already gone */
      }
    }
  }

  // --- Demote (memory → disk) ---

  async _demote(key) {
    const meta = this._metadata.get(key);
    if (!meta || meta.dataSizeV8 < 1) return;

    if (!meta.locationFile) meta.locationFile = this._getLocation(key);

    try {
      const raw = serialize(this._data.get(key));
      await fs.mkdir(dirname(meta.locationFile), { recursive: true });
      await fs.writeFile(meta.locationFile, raw);

      meta.location = LOCATION.DISK;
      meta.expired = meta.isCache ? Date.now() + this.diskTTL : Infinity;
      this._data.delete(key);
      this._metadata.set(key, meta);
      this._stats.cache.demotions++;
      this._log('debug', 'demoted to disk:', key);
    } catch (err) {
      meta.location = LOCATION.MEMORY;
      meta.expired = Date.now() + this.memoryTTL;
      this._metadata.set(key, meta);
      this._stats.errors.diskWrite++;
      this._log('error', 'failed to demote key', key, err);
    }
  }

  /** Synchronous bulk-demote used only during shutdown (close()). */
  async _demoteAll() {
    if (!this.diskPath) return;
    for (const [key, meta] of this._metadata.entries()) {
      if (meta.location === LOCATION.MEMORY && meta.dataSizeV8 > 0) {
        await this._demote(key);
      }
    }
  }

  // --- Disk metadata persistence ---

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
}

export default StoreManager;
