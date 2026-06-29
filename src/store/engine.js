import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import v8 from 'node:v8';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { serialize, deserialize } from 'node:v8';
import StoreBase, { ACTION, LOCATION } from './base.js';

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
    this._workerLoop = this._startQueueWorker();
    this._startMaintainer();

    try {
      await fs.mkdir(this.diskPath, { recursive: true });
      await this._loadMetadataFromDisk();
      this._log('info', 'start completed');
    } catch {
      this._log('warn', 'disk unavailable, switching to memory-only mode');
      // cap at heap limit to avoid unbounded growth
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

    // Stop the worker before draining so they never run tasks concurrently
    await this._drainAndStopWorker();

    await this._demoteAll();
    await this._saveMetadata();
    return true;
  }

  // --- Stats (engine-specific: uses itemsOnDisk) ---

  async getStats() {
    const stats = await super.getStats();
    stats.storage.itemsOnDisk = stats.storage.itemsOnBackend;
    delete stats.storage.itemsOnBackend;
    return stats;
  }

  // --- Stats factory (engine-specific error fields) ---

  _makeStats() {
    const stats = super._makeStats();
    stats.errors.diskRead = 0;
    stats.errors.diskWrite = 0;
    stats.errors.serialize = 0;
    return stats;
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
          await this._executeClear();
          this._dirty = true;
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

          if (meta.location === LOCATION.DISK) {
            try {
              await fs.rm(meta.locationFile);
            } catch {}
          }
          if (this._updateMemoryMeta(key, data, meta, customTTL)) {
            this._dirty = true;
          }
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
              this._dirty = true;
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
          this._dirty = true;
          this._stats.cache.hits++;
          return this._data.get(key);
        };

      default:
        return super._createTask(action, key, data, options);
    }
  }

  // --- Backend-specific delete ---

  async _deleteFromBackend(_key, meta) {
    if (meta.location === LOCATION.DISK && meta.locationFile) {
      try {
        await fs.rm(meta.locationFile);
      } catch {
        // already gone
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
      await this._atomicWrite(meta.locationFile, raw);

      meta.location = LOCATION.DISK;
      meta.expired = meta.isCache ? Date.now() + this.diskTTL : Infinity;
      this._data.delete(key);
      this._metadata.set(key, meta);
      this._dirty = true;
      this._stats.cache.demotions++;
      this._log('debug', 'demoted to disk:', key);
    } catch (err) {
      meta.location = LOCATION.MEMORY;
      meta.expired = Date.now() + this.memoryTTL;
      this._metadata.set(key, meta);
      this._dirty = true;
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

      // memory-resident entries have no on-disk data after a crash;
      // drop them so has()/get() stay consistent
      let dropped = 0;
      for (const [key, meta] of this._metadata) {
        if (meta.location === LOCATION.MEMORY) {
          this._metadata.delete(key);
          dropped++;
        }
      }
      this._dirty = dropped > 0;
      this._log('info', 'metadata loaded from disk', dropped ? `(dropped ${dropped} volatile entries)` : '');
    } catch (err) {
      this._log('error', 'metadata load failed', err);
    }
  }

  // Persist the checkpoint each maintainer cycle, not only on close()
  async _onMaintainerCycle() {
    await this._saveMetadata();
  }

  async _saveMetadata() {
    if (!this.diskPath) return;
    if (!this._dirty) return;
    try {
      const data = serialize(this._metadata);
      await this._atomicWrite(join(this.diskPath, 'metadata.dat'), data);
      this._dirty = false;
      this._log('debug', 'metadata saved');
    } catch (err) {
      this._log('error', 'failed to save metadata', err);
    }
  }

  // Write via a temp file then rename so a crash never leaves a torn file
  async _atomicWrite(filePath, data) {
    const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.writeFile(tmp, data);
      await fs.rename(tmp, filePath);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
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
