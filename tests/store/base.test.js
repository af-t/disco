import { describe, it, mock, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import StoreBase from '../../src/store/base.js';

// Minimal concrete subclass — only implements the abstract surface
class ConcreteStore extends StoreBase {
  _createTask(action, key, data) {
    return async () => {
      if (action === 'SET') {
        const meta = {
          location: 0,
          dataSizeV8: 10,
          expired: Date.now() + 60_000,
          isCache: false,
          customTTL: null,
          created: Date.now(),
          lastAccess: Date.now(),
          accessCount: 0,
        };
        this._metadata.set(key, meta);
        this._data.set(key, data);
        return data;
      }
      if (action === 'GET') return this._data.get(key);
      if (action === 'DELETE') await this._delete(key);
      if (action === 'CLEAR') {
        this._metadata.clear();
        this._data.clear();
      }
      if (action === 'HAS') return this._metadata.has(key);
      if (action === 'METADATA') return Object.assign({}, this._metadata.get(key) || {});
    };
  }
  async _demote(key) {
    const meta = this._metadata.get(key);
    if (meta) {
      meta.location = 1;
      this._data.delete(key);
    }
  }
  async _demoteAll() {
    for (const [key] of this._metadata) await this._demote(key);
  }
  async _deleteFromBackend() {}
}

// ── Abstract method stubs ────────────────────────────────────────────────────
describe('StoreBase abstract methods', () => {
  it('set throws Not implemented', async () => {
    const b = new StoreBase();
    await assert.rejects(() => b.set('k', 'v'), { message: 'Not implemented' });
  });
  it('get throws Not implemented', async () => {
    const b = new StoreBase();
    await assert.rejects(() => b.get('k'), { message: 'Not implemented' });
  });
  it('delete throws Not implemented', async () => {
    const b = new StoreBase();
    await assert.rejects(() => b.delete('k'), { message: 'Not implemented' });
  });
  it('clear throws Not implemented', async () => {
    const b = new StoreBase();
    await assert.rejects(() => b.clear(), { message: 'Not implemented' });
  });
  it('_createTask throws in base', () => {
    const b = new StoreBase();
    assert.throws(() => b._createTask('SET'), /_createTask not implemented/);
  });
  it('_demote throws in base', async () => {
    const b = new StoreBase();
    await assert.rejects(() => b._demote('k'), { message: 'Not implemented' });
  });
  it('_demoteAll throws in base', async () => {
    const b = new StoreBase();
    await assert.rejects(() => b._demoteAll(), { message: 'Not implemented' });
  });
});

// ── _validateInt ─────────────────────────────────────────────────────────────
describe('StoreBase _validateInt', () => {
  let s;
  before(() => {
    s = new ConcreteStore();
  });

  it('returns null for null', () => assert.strictEqual(s._validateInt(null), null));
  it('returns null for undefined', () => assert.strictEqual(s._validateInt(undefined), null));
  it('returns null for float', () => assert.strictEqual(s._validateInt(1.5), null));
  it('returns null for NaN string', () => assert.strictEqual(s._validateInt('abc'), null));
  it('returns number for valid int string', () => assert.strictEqual(s._validateInt('300000'), 300000));
  it('returns number for integer', () => assert.strictEqual(s._validateInt(42), 42));
});

// ── _formatBytes ─────────────────────────────────────────────────────────────
describe('StoreBase _formatBytes', () => {
  let s;
  before(() => {
    s = new ConcreteStore();
  });

  it('formats 0', () => assert.strictEqual(s._formatBytes(0), '0 B'));
  it('formats Infinity', () => assert.strictEqual(s._formatBytes(Infinity), '∞'));
  it('formats bytes', () => assert.strictEqual(s._formatBytes(512), '512.00 B'));
  it('formats KB', () => assert.strictEqual(s._formatBytes(1536), '1.50 KB'));
  it('formats MB', () => assert.strictEqual(s._formatBytes(2 * 1024 * 1024), '2.00 MB'));
  it('formats GB', () => assert.strictEqual(s._formatBytes(1.5 * 1024 ** 3), '1.50 GB'));
});

// ── _formatDuration ──────────────────────────────────────────────────────────
describe('StoreBase _formatDuration', () => {
  let s;
  before(() => {
    s = new ConcreteStore();
  });

  it('formats seconds', () => assert.strictEqual(s._formatDuration(30_000), '30s'));
  it('formats minutes', () => assert.strictEqual(s._formatDuration(90_000), '1m 30s'));
  it('formats hours', () => assert.strictEqual(s._formatDuration(3_661_000), '1h 1m 1s'));
  it('formats days', () => assert.strictEqual(s._formatDuration(90_061_000), '1d 1h 1m'));
});

// ── getStats / resetStats ─────────────────────────────────────────────────────
describe('StoreBase getStats', () => {
  it('returns correct shape with zero ops', async () => {
    const s = new ConcreteStore();
    const stats = await s.getStats();
    assert.strictEqual(stats.operations.total, 0);
    assert.strictEqual(stats.cache.hitRate, '0.00%');
    assert.strictEqual(stats.storage.totalItems, 0);
    assert.ok('uptime' in stats);
    assert.ok('queue' in stats);
    assert.ok('errors' in stats);
  });

  it('computes hit rate correctly', async () => {
    const s = new ConcreteStore();
    s._stats.cache.hits = 3;
    s._stats.cache.misses = 1;
    const stats = await s.getStats();
    assert.strictEqual(stats.cache.hitRate, '75.00%');
    assert.strictEqual(stats.cache.hitRateNumeric, 75);
  });

  it('resetStats clears counters', async () => {
    const s = new ConcreteStore();
    s._stats.operations.get = 99;
    s._queueLenSum = 50;
    s._queueLenSamples = 10;
    await s.resetStats();
    assert.strictEqual(s._stats.operations.get, 0);
    assert.strictEqual(s._queueLenSum, 0);
    assert.strictEqual(s._queueLenSamples, 0);
  });

  it('counts itemsOnBackend correctly', async () => {
    const s = new ConcreteStore();
    s._metadata.set('srv', { location: 1, dataSizeV8: 0 });
    const stats = await s.getStats();
    assert.strictEqual(stats.storage.itemsOnBackend, 1);
    assert.strictEqual(stats.storage.itemsInMemory, 0);
  });
});

// ── _isAlwaysAllowed ─────────────────────────────────────────────────────────
describe('StoreBase _isAlwaysAllowed', () => {
  it('returns false for any action in base', () => {
    const s = new ConcreteStore();
    assert.strictEqual(s._isAlwaysAllowed('SET'), false);
    assert.strictEqual(s._isAlwaysAllowed('GET'), false);
  });
});

// ── StoreBase has and metadata ────────────────────────────────────────────────
describe('StoreBase has and metadata', () => {
  it('has() throws TypeError for non-string key', async () => {
    const s = new ConcreteStore();
    await assert.rejects(() => s.has(42), { name: 'TypeError' });
  });
  it('has() returns true when key exists', async () => {
    const s = new ConcreteStore();
    s._active = true;
    s._startQueueWorker();
    await s._addAction('SET', 'k', 'v');
    const result = await s.has('k');
    assert.strictEqual(result, true);
    s._active = false;
    s._notifier?.();
  });
  it('has() returns false for missing key', async () => {
    const s = new ConcreteStore();
    s._active = true;
    s._startQueueWorker();
    const result = await s.has('nope');
    assert.strictEqual(result, false);
    s._active = false;
    s._notifier?.();
  });
  it('metadata() throws TypeError for non-string key', async () => {
    const s = new ConcreteStore();
    await assert.rejects(() => s.metadata(null), { name: 'TypeError' });
  });
  it('metadata() returns object for existing key', async () => {
    const s = new ConcreteStore();
    s._active = true;
    s._startQueueWorker();
    await s._addAction('SET', 'k', 'v');
    const meta = await s.metadata('k');
    assert.ok(typeof meta === 'object');
    s._active = false;
    s._notifier?.();
  });
});

// ── _addAction ───────────────────────────────────────────────────────────────
describe('StoreBase _addAction', () => {
  it('resolves immediately when _active=false', async () => {
    const s = new ConcreteStore();
    // _active is false by default
    const result = await s._addAction('GET', 'k');
    assert.strictEqual(result, undefined);
  });

  it('executes task and resolves with value when active', async () => {
    const s = new ConcreteStore();
    s._active = true;
    s._startQueueWorker();
    await s._addAction('SET', 'k', 'v');
    const result = await s._addAction('GET', 'k');
    assert.strictEqual(result, 'v');
    s._active = false;
    s._notifier?.();
  });

  it('resolves (not throws) when task throws', async () => {
    const s = new ConcreteStore();
    s._active = true;
    s._startQueueWorker();
    s._createTask = () => async () => {
      throw new Error('boom');
    };
    const result = await s._addAction('SET', 'k');
    assert.strictEqual(result, undefined);
    assert.strictEqual(s._stats.errors.queue, 1);
    s._active = false;
    s._notifier?.();
  });
});

// ── _enqueueTask ─────────────────────────────────────────────────────────────
describe('StoreBase _enqueueTask', () => {
  it('tracks queue length stats', () => {
    const s = new ConcreteStore();
    s._enqueueTask(async () => {});
    s._enqueueTask(async () => {});
    assert.strictEqual(s._queueLenSamples, 2);
    assert.strictEqual(s._stats.performance.maxQueueLength, 2);
  });

  it('calls _notifier when set', () => {
    const s = new ConcreteStore();
    let notified = false;
    s._notifier = () => {
      notified = true;
    };
    s._enqueueTask(async () => {});
    assert.ok(notified);
  });
});

// ── _delete ───────────────────────────────────────────────────────────────────
describe('StoreBase _delete', () => {
  it('no-op when key missing', async () => {
    const s = new ConcreteStore();
    await s._delete('missing'); // should not throw
  });

  it('removes metadata and data', async () => {
    const s = new ConcreteStore();
    s._metadata.set('k', { location: 0 });
    s._data.set('k', 'val');
    await s._delete('k');
    assert.strictEqual(s._metadata.has('k'), false);
    assert.strictEqual(s._data.has('k'), false);
  });

  it('calls onDelete hook before deleting', async () => {
    const s = new ConcreteStore();
    const meta = { location: 0 };
    s._metadata.set('k', meta);
    let hookCalledWith = null;
    s.onDelete = async (key, m) => {
      hookCalledWith = { key, m };
    };
    await s._delete('k');
    assert.deepStrictEqual(hookCalledWith, { key: 'k', m: meta });
  });

  it('still deletes when onDelete throws', async () => {
    const s = new ConcreteStore();
    s._metadata.set('k', { location: 0 });
    s.onDelete = async () => {
      throw new Error('hook error');
    };
    await s._delete('k');
    assert.strictEqual(s._metadata.has('k'), false);
  });
});

// ── _deleteFromBackend (base no-op) ──────────────────────────────────────────
describe('StoreBase _deleteFromBackend', () => {
  it('no-op in base, does not throw', async () => {
    const b = new StoreBase();
    await b._deleteFromBackend('k', {}); // should resolve
  });
});

// ── _startQueueWorker ─────────────────────────────────────────────────────────
describe('StoreBase _startQueueWorker', () => {
  it('processes queued tasks in order', async () => {
    const s = new ConcreteStore();
    s._active = true;
    s._startQueueWorker();
    const order = [];
    s._enqueueTask(async () => {
      order.push(1);
    });
    s._enqueueTask(async () => {
      order.push(2);
    });
    s._enqueueTask(async () => {
      order.push(3);
    });
    // drain
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(order, [1, 2, 3]);
    s._active = false;
    s._notifier?.();
  });

  it('increments errors.queue when task throws', async () => {
    const s = new ConcreteStore();
    s._active = true;
    s._startQueueWorker();
    s._enqueueTask(async () => {
      throw new Error('oops');
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(s._stats.errors.queue, 1);
    s._active = false;
    s._notifier?.();
  });
});

// ── _startMaintainer ─────────────────────────────────────────────────────────
describe('StoreBase _startMaintainer', () => {
  afterEach(() => {
    mock.restoreAll();
    mock.timers.reset();
  });

  it('demotes expired MEMORY items after 15s', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const s = new ConcreteStore();
    s._active = true;
    s._startQueueWorker();

    const demoteSpy = mock.method(s, '_demote');

    // Add already-expired MEMORY item
    s._metadata.set('old', {
      location: 0,
      dataSizeV8: 10,
      expired: Date.now() - 1,
      isCache: true,
      customTTL: null,
    });
    s._data.set('old', 'v');

    s._startMaintainer();
    mock.timers.tick(16_000);

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(demoteSpy.mock.callCount(), 1);

    s._active = false;
    s._notifier?.();
    mock.timers.tick(16_000); // wake maintainer from next sleep
  });

  it('deletes expired SERVER items after 15s', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const s = new ConcreteStore();
    s._active = true;
    s._startQueueWorker();

    const deleteSpy = mock.method(s, '_delete');

    s._metadata.set('srv', {
      location: 1,
      dataSizeV8: 0,
      expired: Date.now() - 1,
      isCache: true,
      customTTL: null,
    });

    s._startMaintainer();
    mock.timers.tick(16_000);

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(deleteSpy.mock.callCount(), 1);

    s._active = false;
    s._notifier?.();
    mock.timers.tick(16_000);
  });

  it('evicts LRU items when over maxMemory', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const s = new ConcreteStore({ maxMemory: 1 }); // 1 byte — always over
    s._active = true;
    s._startQueueWorker();

    const demoteSpy = mock.method(s, '_demote');

    s._metadata.set('a', {
      location: 0,
      dataSizeV8: 10,
      expired: Date.now() + 999_999,
      isCache: true,
      customTTL: null,
      lastAccess: Date.now() - 5000,
    });
    s._data.set('a', 'v');

    s._startMaintainer();
    mock.timers.tick(16_000);

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(demoteSpy.mock.callCount(), 1);

    s._active = false;
    s._notifier?.();
    mock.timers.tick(16_000);
  });

  it('stops when _active becomes false', async () => {
    // capture real timers before mock.timers replaces the globals
    const realSetTimeout = setTimeout;
    const realClearTimeout = clearTimeout;
    mock.timers.enable({ apis: ['setTimeout'] });
    const s = new ConcreteStore();
    s._active = true;

    const p = s._startMaintainer();
    s._active = false;
    mock.timers.tick(16_000);
    await new Promise((r) => setImmediate(r));

    // fail loudly (not hang) if the maintainer loop never exits
    let failsafe;
    const guard = new Promise((_, rej) => {
      failsafe = realSetTimeout(() => rej(new Error('maintainer did not stop')), 1000);
    });
    try {
      await Promise.race([p, guard]);
    } finally {
      realClearTimeout(failsafe);
    }
  });
});
