import test from 'node:test';
import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import Engine from '../../src/store/engine.js';

test('StoreManager (Engine) should set and get values', async () => {
  const diskPath = join(process.cwd(), 'tests_tmp_engine');
  const engine = new Engine({ diskPath });
  await engine.ready();

  try {
    await engine.set('foo', { bar: 123 });
    const val = await engine.get('foo');
    assert.deepStrictEqual(val, { bar: 123 });

    const hasFoo = await engine.has('foo');
    assert.strictEqual(hasFoo, true);

    await engine.delete('foo');
    const valAfterDelete = await engine.get('foo');
    assert.strictEqual(valAfterDelete, undefined);
  } finally {
    await engine.close();
    await fs.rm(diskPath, { recursive: true, force: true });
  }
});

test('StoreManager should clear all data', async () => {
  const diskPath = join(process.cwd(), 'tests_tmp_engine_clear');
  const engine = new Engine({ diskPath });
  await engine.ready();

  try {
    await engine.set('a', 1);
    await engine.set('b', 2);
    await engine.clear();

    assert.strictEqual(await engine.get('a'), undefined);
    assert.strictEqual(await engine.get('b'), undefined);
  } finally {
    await engine.close();
    await fs.rm(diskPath, { recursive: true, force: true });
  }
});

test('StoreManager (Engine) should return metadata and stats', async () => {
  const diskPath = join(process.cwd(), 'tests_tmp_engine_meta');
  const engine = new Engine({ diskPath });
  await engine.ready();

  try {
    await engine.set('meta', 'data');
    const meta = await engine.metadata('meta');
    assert.strictEqual(meta.location, 0); // LOCATION.MEMORY
    assert.ok(meta.created > 0);

    const stats = await engine.getStats();
    assert.strictEqual(stats.storage.totalItems, 1);
    assert.strictEqual(stats.storage.itemsInMemory, 1);
  } finally {
    await engine.close();
    await fs.rm(diskPath, { recursive: true, force: true });
  }
});

test('StoreManager (Engine) should respect custom TTL', async () => {
  const diskPath = join(process.cwd(), 'tests_tmp_engine_ttl');
  const engine = new Engine({ diskPath, memoryTTL: 10000 });
  await engine.ready();

  try {
    // Set with short TTL (100ms)
    await engine.set('ttl-test', 'data', { ttl: 100 });

    // Immediate check
    assert.strictEqual(await engine.get('ttl-test'), 'data');

    // Wait for expiration
    await new Promise((r) => setTimeout(r, 200));

    const val = await engine.get('ttl-test');
    assert.strictEqual(val, undefined, 'Value should be expired');
  } finally {
    await engine.close();
    await fs.rm(diskPath, { recursive: true, force: true });
  }
});

test('StoreManager (Engine) should trigger onDelete hook', async () => {
  const diskPath = join(process.cwd(), 'tests_tmp_engine_delete');
  const engine = new Engine({ diskPath });
  await engine.ready();

  let deletedKey = null;
  let deletedMeta = null;
  engine.onDelete = (key, meta) => {
    deletedKey = key;
    deletedMeta = meta;
  };

  try {
    await engine.set('del-test', 'some-data');
    await engine.delete('del-test');

    assert.strictEqual(deletedKey, 'del-test');
    assert.ok(deletedMeta);
    assert.ok(deletedMeta.created > 0);
  } finally {
    await engine.close();
    await fs.rm(diskPath, { recursive: true, force: true });
  }
});

// ── Additional coverage for uncovered paths ───────────────────────────────────

describe('StoreEngine memory-only fallback', () => {
  afterEach(() => mock.restoreAll());

  it('falls back to memory-only when mkdir fails', async () => {
    mock.method(fs, 'mkdir', async () => {
      throw new Error('permission denied');
    });
    const engine = new Engine({ diskPath: '/no/such/path' });
    await engine.ready();
    // Should still work as memory-only
    await engine.set('k', 'v');
    assert.strictEqual(await engine.get('k'), 'v');
    assert.strictEqual(engine.diskPath, null);
    await engine.close();
  });
});

describe('StoreEngine CLEAR with onDelete hook', () => {
  it('calls onDelete for each key during clear', async () => {
    const diskPath = join(os.tmpdir(), 'engine_clear_hook_' + Date.now());
    const engine = new Engine({ diskPath });
    await engine.ready();
    try {
      await engine.set('a', 1);
      await engine.set('b', 2);
      const deleted = [];
      engine.onDelete = async (k) => {
        deleted.push(k);
      };
      await engine.clear();
      assert.deepStrictEqual(deleted.sort(), ['a', 'b']);
    } finally {
      await engine.close();
      await fs.rm(diskPath, { recursive: true, force: true });
    }
  });
});

describe('StoreEngine SET serialize error', () => {
  it('increments serialize error stat for unserializable value', async () => {
    const diskPath = join(os.tmpdir(), 'engine_ser_' + Date.now());
    const engine = new Engine({ diskPath });
    await engine.ready();
    try {
      await engine.set('bad', () => {}); // functions cannot be v8-serialized
      assert.strictEqual(engine._stats.errors.serialize, 1);
      assert.strictEqual(engine._metadata.has('bad'), false);
    } finally {
      await engine.close();
      await fs.rm(diskPath, { recursive: true, force: true });
    }
  });
});

describe('StoreEngine _createTask unknown action', () => {
  it('throws for unknown action number', () => {
    const engine = new Engine({ diskPath: '/tmp/x' });
    assert.throws(() => engine._createTask(99), /Unknown action/);
  });
});

describe('StoreEngine disk demote + get promotion', () => {
  it('demotes item to disk and promotes it back on get', async () => {
    const diskPath = join(os.tmpdir(), 'engine_demote_' + Date.now());
    const engine = new Engine({ diskPath });
    await engine.ready();
    try {
      await engine.set('dkey', { val: 42 });
      // Manually demote to disk
      await engine._demote('dkey');
      assert.strictEqual(engine._metadata.get('dkey').location, 1); // DISK
      // get() should promote back to memory
      const result = await engine.get('dkey');
      assert.deepStrictEqual(result, { val: 42 });
      assert.strictEqual(engine._stats.cache.promotions, 1);
    } finally {
      await engine.close();
      await fs.rm(diskPath, { recursive: true, force: true });
    }
  });

  it('_deleteFromBackend removes disk file for DISK location', async () => {
    const diskPath = join(os.tmpdir(), 'engine_delfb_' + Date.now());
    const engine = new Engine({ diskPath });
    await engine.ready();
    try {
      await engine.set('k', 'v');
      await engine._demote('k');
      const meta = engine._metadata.get('k');
      assert.strictEqual(meta.location, 1); // DISK
      await engine._deleteFromBackend('k', meta);
      // file should be gone now
      await assert.rejects(() => fs.access(meta.locationFile), /ENOENT/);
    } finally {
      await engine.close();
      await fs.rm(diskPath, { recursive: true, force: true });
    }
  });

  it('getStats counts itemsOnDisk correctly', async () => {
    const diskPath = join(os.tmpdir(), 'engine_stats_disk_' + Date.now());
    const engine = new Engine({ diskPath });
    await engine.ready();
    try {
      await engine.set('mem', 'v');
      await engine.set('disk', 'v2');
      await engine._demote('disk');
      const stats = await engine.getStats();
      assert.strictEqual(stats.storage.itemsInMemory, 1);
      assert.strictEqual(stats.storage.itemsOnDisk, 1);
    } finally {
      await engine.close();
      await fs.rm(diskPath, { recursive: true, force: true });
    }
  });

  it('_demote error increments diskWrite stat', async () => {
    const diskPath = join(os.tmpdir(), 'engine_demote_err_' + Date.now());
    const engine = new Engine({ diskPath });
    await engine.ready();
    try {
      await engine.set('k', 'v');
      // Mock writeFile to fail
      mock.method(fs, 'writeFile', async () => {
        throw new Error('disk full');
      });
      await engine._demote('k');
      assert.strictEqual(engine._stats.errors.diskWrite, 1);
      assert.strictEqual(engine._metadata.get('k').location, 0); // stayed MEMORY
    } finally {
      mock.restoreAll();
      engine._active = false;
      engine._notifier?.();
      await fs.rm(diskPath, { recursive: true, force: true });
    }
  });
});

describe('StoreEngine SET re-sets key previously on DISK', () => {
  it('cleans up disk file when re-setting a demoted key', async () => {
    const diskPath = join(os.tmpdir(), 'engine_reset_' + Date.now());
    const engine = new Engine({ diskPath });
    await engine.ready();
    try {
      await engine.set('k', 'v1');
      await engine._demote('k');
      const meta = engine._metadata.get('k');
      const locationFile = meta.locationFile;
      // Re-set the same key (triggers stale disk file cleanup)
      await engine.set('k', 'v2');
      assert.strictEqual(engine._metadata.get('k').location, 0); // MEMORY
      assert.strictEqual(await engine.get('k'), 'v2');
      await assert.rejects(() => fs.stat(locationFile), 'stale disk file should be removed');
    } finally {
      await engine.close();
      await fs.rm(diskPath, { recursive: true, force: true });
    }
  });
});

describe('StoreEngine _loadMetadataFromDisk error', () => {
  afterEach(() => mock.restoreAll());

  it('logs error but continues when metadata file is corrupt', async () => {
    const diskPath = join(os.tmpdir(), 'engine_meta_corrupt_' + Date.now());
    await fs.mkdir(diskPath, { recursive: true });
    // Write corrupt metadata
    await fs.writeFile(join(diskPath, 'metadata.dat'), Buffer.from('not-v8-serialized-data'));
    const engine = new Engine({ diskPath });
    await engine.ready(); // should not throw
    assert.strictEqual(engine._active, true);
    await engine.close();
    await fs.rm(diskPath, { recursive: true, force: true });
  });
});

describe('StoreEngine close drain loop catches task errors', () => {
  it('continues draining if a queued task throws', async () => {
    const diskPath = join(os.tmpdir(), 'engine_drain_' + Date.now());
    const engine = new Engine({ diskPath });
    await engine.ready();
    try {
      // Push a throwing task directly without waking the worker
      engine._queues.push(async () => {
        throw new Error('task error');
      });
      const result = await engine.close();
      assert.strictEqual(result, true);
    } finally {
      await fs.rm(diskPath, { recursive: true, force: true });
    }
  });
});

describe('StoreEngine CLEAR onDelete throws', () => {
  it('catches onDelete errors during clear', async () => {
    const diskPath = join(os.tmpdir(), 'engine_clear_throw_' + Date.now());
    const engine = new Engine({ diskPath });
    await engine.ready();
    try {
      await engine.set('a', 1);
      engine.onDelete = async () => {
        throw new Error('hook error');
      };
      await engine.clear(); // should not throw
      assert.strictEqual(engine._metadata.size, 0);
    } finally {
      await engine.close();
      await fs.rm(diskPath, { recursive: true, force: true });
    }
  });
});

describe('StoreEngine SET disk cleanup failure is swallowed', () => {
  afterEach(() => mock.restoreAll());

  it('handles fs.rm failure when re-setting a demoted key', async () => {
    const diskPath = join(os.tmpdir(), 'engine_rm_fail_' + Date.now());
    const engine = new Engine({ diskPath });
    await engine.ready();
    try {
      await engine.set('k', 'v1');
      await engine._demote('k');
      // patch fs.rm to throw only for .dat files
      const origRm = fs.rm.bind(fs);
      mock.method(fs, 'rm', async (p, ...args) => {
        if (typeof p === 'string' && p.endsWith('.dat')) throw new Error('rm failed');
        return origRm(p, ...args);
      });
      await engine.set('k', 'v2'); // should not throw even if rm fails
      assert.strictEqual(engine._metadata.get('k').location, 0); // MEMORY
      assert.strictEqual(await engine.get('k'), 'v2');
    } finally {
      mock.restoreAll();
      await engine.close();
      await fs.rm(diskPath, { recursive: true, force: true });
    }
  });
});

describe('StoreEngine GET disk file path recovery', () => {
  it('updates locationFile when file exists at recovered path', async () => {
    const diskPath = join(os.tmpdir(), 'engine_path_' + Date.now());
    const engine = new Engine({ diskPath });
    await engine.ready();
    try {
      await engine.set('pkey', { x: 1 });
      await engine._demote('pkey');
      const meta = engine._metadata.get('pkey');
      // The real file lives at e.g. <diskPath>/ab/cdef....dat
      // Compute the last 2 path segments so that newPath = join(diskPath, suff) resolves to the real file
      const realFile = meta.locationFile;
      const parts = realFile.split('/');
      const suff = parts.slice(-2).join('/'); // e.g. 'ab/cdef.dat'
      // Point locationFile to a fake prefix so existsSync(locationFile) is false
      // but existsSync(join(diskPath, suff)) is true (the real file)
      meta.locationFile = '/nonexistent/prefix/' + suff;
      engine._metadata.set('pkey', meta);
      // GET should recover the path and successfully read the value
      const result = await engine.get('pkey');
      assert.deepStrictEqual(result, { x: 1 });
    } finally {
      await engine.close();
      await fs.rm(diskPath, { recursive: true, force: true });
    }
  });
});

describe('StoreEngine GET expires during disk promotion', () => {
  afterEach(() => mock.restoreAll());

  it('returns undefined when TTL expires between first and second check', async () => {
    const diskPath = join(os.tmpdir(), 'engine_ttl_promo_' + Date.now());
    const engine = new Engine({ diskPath });
    await engine.ready();
    try {
      // isCache: true so _demote sets diskTTL (not Infinity) on meta.expired
      await engine.set('exp', 'data', { isCache: true, ttl: 5000 });
      await engine._demote('exp');
      const meta = engine._metadata.get('exp');
      const expiredAt = meta.expired;
      // Track calls within the GET task specifically.
      // Task calls Date.now() at: line 287 (first check), line 294 (lastAccess), line 308 (second check)
      // We need call 1 < expiredAt, call 3 > expiredAt.
      // Reset mock so it only activates once the task starts running.
      // Strategy: first 2 calls return past (not expired), 3rd+ returns future (expired).
      let callCount = 0;
      mock.method(Date, 'now', () => {
        callCount++;
        if (callCount <= 2) return expiredAt - 100; // not expired yet
        return expiredAt + 100; // expired now
      });
      const result = await engine.get('exp');
      assert.strictEqual(result, undefined);
      assert.strictEqual(engine._metadata.has('exp'), false);
    } finally {
      mock.restoreAll();
      await engine.close();
      await fs.rm(diskPath, { recursive: true, force: true });
    }
  });
});

describe('StoreEngine GET diskRead error', () => {
  it('increments diskRead stat when readFile fails during promotion', async () => {
    const diskPath = join(os.tmpdir(), 'engine_diskread_' + Date.now());
    const engine = new Engine({ diskPath });
    await engine.ready();
    try {
      await engine.set('rk', { val: 1 });
      await engine._demote('rk');
      // Remove the disk file to force a read error
      const meta = engine._metadata.get('rk');
      await fs.rm(meta.locationFile);
      // GET tries to read the file, gets ENOENT -> hits diskRead error path
      const result = await engine.get('rk');
      assert.strictEqual(result, undefined);
      assert.strictEqual(engine._stats.errors.diskRead, 1);
    } finally {
      await engine.close();
      await fs.rm(diskPath, { recursive: true, force: true });
    }
  });
});

describe('StoreEngine _deleteFromBackend already-gone file', () => {
  it('swallows rm error when disk file is already gone', async () => {
    const diskPath = join(os.tmpdir(), 'engine_delfb2_' + Date.now());
    const engine = new Engine({ diskPath });
    await engine.ready();
    try {
      await engine.set('g', 'v');
      await engine._demote('g');
      const meta = engine._metadata.get('g');
      // Delete the file first
      await fs.rm(meta.locationFile);
      // Call _deleteFromBackend again — should not throw
      await engine._deleteFromBackend('g', meta);
    } finally {
      await engine.close();
      await fs.rm(diskPath, { recursive: true, force: true });
    }
  });
});

describe('StoreEngine _saveMetadata error is swallowed', () => {
  afterEach(() => mock.restoreAll());

  it('logs error when metadata writeFile fails', async () => {
    const diskPath = join(os.tmpdir(), 'engine_savemeta_' + Date.now());
    const engine = new Engine({ diskPath });
    await engine.ready();
    try {
      await engine.set('k', 'v');
      // Make writeFile fail during close/_saveMetadata
      mock.method(fs, 'writeFile', async () => {
        throw new Error('disk full');
      });
      const result = await engine.close();
      // close() should complete without throwing even if metadata save fails
      assert.ok(result === true || result === undefined);
    } finally {
      mock.restoreAll();
      await fs.rm(diskPath, { recursive: true, force: true });
    }
  });
});
