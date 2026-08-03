import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import StoreClient from '../../src/store/client.js';
import { serialize, deserialize } from 'node:v8';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMockWs(readyState = 1) {
  // 1 = OPEN, matches WebSocket.OPEN
  const listeners = new Map();

  const ws = {
    readyState,
    binaryType: 'arraybuffer',
    sent: [],
    closed: false,
    closeCode: null,
    closeReason: '',

    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },

    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },

    dispatch(type, detail) {
      // Build an event-like object. For 'message', event.data is the payload.
      const event = { type, ...detail };
      for (const fn of listeners.get(type) ?? []) fn(event);
    },

    send(payload) {
      this.sent.push(payload);
      try {
        const { id } = JSON.parse(payload);
        setImmediate(() => this.dispatch('message', { data: serialize({ id, data: null }) }));
      } catch {}
    },

    close(code = 1000, reason = '') {
      this.closed = true;
      this.closeCode = code;
      this.closeReason = reason;
      this.readyState = 3; // CLOSED
    },
  };

  return ws;
}

function makeClient(wsReadyState = 1) {
  const client = new StoreClient({ url: 'ws://mock' });
  const ws = makeMockWs(wsReadyState);
  client._ws = ws;
  client._reconnect = false;
  client._active = true;
  client._startQueueWorker();

  // mirror the real message handler that connect() would install
  ws.addEventListener('message', (event) => {
    try {
      const buffer = Buffer.from(event.data);
      const { id, data } = deserialize(buffer);
      const entry = client._pendingRequests.get(id);
      if (entry) {
        entry.resolve(data);
        client._pendingRequests.delete(id);
      }
    } catch {}
  });

  return { client, ws };
}

function stopClient(client) {
  client._active = false;
  client._notifier?.();
  clearTimeout(client._idleTimer);
}

function mockWsSend(ws, dataResolver, delay = 5) {
  ws.send = (payload) => {
    const { op, id } = JSON.parse(payload);
    setTimeout(() => {
      const data = dataResolver(op);
      ws.dispatch('message', { data: serialize({ id, data }) });
    }, delay);
  };
}

// ── Original test (migrated to describe/it) ──────────────────────────────────
describe('StoreClient connect and send/receive', () => {
  afterEach(() => mock.restoreAll());

  it('sends a GET and receives a response', async () => {
    const { client, ws } = makeClient();
    mockWsSend(ws, (op) => (op === 'getWithMetadata' ? 'pong' : null), 10);
    const result = await client.get('test');
    assert.strictEqual(result, 'pong');
    stopClient(client);
  });
});

// ── _send: connect-on-demand + idle timer reset ───────────────────────────────
describe('StoreClient _send connect-on-demand', () => {
  afterEach(() => mock.restoreAll());

  it('calls _ensureConnected when WS is not connected', async () => {
    const { client, ws } = makeClient();
    client._ws = null; // simulate disconnected
    let ensureCalled = false;
    mock.method(client, '_ensureConnected', async () => {
      ensureCalled = true;
      client._ws = ws; // restore as if connect succeeded
    });
    await client._send('ready');
    assert.strictEqual(ensureCalled, true);
    stopClient(client);
  });

  it('skips _ensureConnected when WS is already OPEN (fast path)', async () => {
    const { client } = makeClient(); // WS is OPEN by default
    let ensureCalled = false;
    mock.method(client, '_ensureConnected', async () => {
      ensureCalled = true;
    });
    await client._send('ready');
    assert.strictEqual(ensureCalled, false);
    stopClient(client);
  });

  it('resets idle timer after successful ws.send()', async () => {
    const { client } = makeClient();
    let resetCalled = false;
    mock.method(client, '_resetIdleTimer', () => {
      resetCalled = true;
    });
    await client._send('ready');
    assert.strictEqual(resetCalled, true);
  });

  it('does not reset idle timer when _active is false (shutdown path)', async () => {
    const { client } = makeClient();
    client._active = false;
    let resetCalled = false;
    mock.method(client, '_resetIdleTimer', () => {
      resetCalled = true;
    });
    await client._send('ready');
    assert.strictEqual(resetCalled, false);
  });
});

// ── API type validation ───────────────────────────────────────────────────────
describe('StoreClient API type validation', () => {
  it('set() throws TypeError for non-string key', async () => {
    const { client } = makeClient();
    await assert.rejects(() => client.set(123, 'v'), { name: 'TypeError' });
    stopClient(client);
  });
  it('get() throws TypeError for non-string key', async () => {
    const { client } = makeClient();
    await assert.rejects(() => client.get(null), { name: 'TypeError' });
    stopClient(client);
  });
  it('delete() throws TypeError for non-string key', async () => {
    const { client } = makeClient();
    await assert.rejects(() => client.delete({}), { name: 'TypeError' });
    stopClient(client);
  });
  it('has() throws TypeError for non-string key', async () => {
    const { client } = makeClient();
    await assert.rejects(() => client.has(undefined), { name: 'TypeError' });
    stopClient(client);
  });
  it('metadata() throws TypeError for non-string key', async () => {
    const { client } = makeClient();
    await assert.rejects(() => client.metadata(42), { name: 'TypeError' });
    stopClient(client);
  });
});

// ── _isAlwaysAllowed ─────────────────────────────────────────────────────────
describe('StoreClient _isAlwaysAllowed', () => {
  it('returns true for ATTR_SET (6) and ATTR_GET (7)', () => {
    const client = new StoreClient();
    assert.strictEqual(client._isAlwaysAllowed(6), true);
    assert.strictEqual(client._isAlwaysAllowed(7), true);
  });
  it('returns false for other actions', () => {
    const client = new StoreClient();
    assert.strictEqual(client._isAlwaysAllowed(1), false);
    assert.strictEqual(client._isAlwaysAllowed(2), false);
  });
});

// ── _createTask: SET ──────────────────────────────────────────────────────────
describe('StoreClient _createTask SET', () => {
  afterEach(() => mock.restoreAll());

  it('stores value in memory with correct metadata', async () => {
    const { client } = makeClient();
    await client.set('foo', 'bar');
    assert.strictEqual(await client.get('foo'), 'bar');
    const meta = client._metadata.get('foo');
    assert.strictEqual(meta.location, 0); // MEMORY
    assert.ok(meta.dataSizeV8 > 0);
    stopClient(client);
  });

  it('isCache=true from boolean options', async () => {
    const { client } = makeClient();
    await client.set('k', 'v', true);
    assert.strictEqual(client._metadata.get('k').isCache, true);
    stopClient(client);
  });

  it('customTTL from options.ttl', async () => {
    const { client } = makeClient();
    const before = Date.now();
    await client.set('k', 'v', { ttl: 5000 });
    const meta = client._metadata.get('k');
    assert.ok(meta.expired >= before + 4900);
    assert.ok(meta.expired <= before + 5100);
    stopClient(client);
  });

  it('reuses existing metadata, resets accessCount', async () => {
    const { client } = makeClient();
    await client.set('k', 'first');
    client._metadata.get('k').accessCount = 99;
    await client.set('k', 'second');
    assert.strictEqual(client._metadata.get('k').accessCount, 0);
    stopClient(client);
  });

  it('serialize error increments stats.errors.serialize', async () => {
    const { client } = makeClient();
    // Arrow functions cannot be cloned by V8 serialize
    const unserializable = () => {};
    await client.set('k', unserializable);
    assert.strictEqual(client._stats.errors.serialize, 1);
    assert.strictEqual(client._metadata.has('k'), false);
    stopClient(client);
  });
});

// ── _createTask: GET ──────────────────────────────────────────────────────────
describe('StoreClient _createTask GET', () => {
  it('memory hit: returns value, increments hits', async () => {
    const { client } = makeClient();
    await client.set('k', 'val');
    const result = await client.get('k');
    assert.strictEqual(result, 'val');
    assert.strictEqual(client._stats.cache.hits, 1);
    stopClient(client);
  });

  it('expired item: deletes and returns undefined', async () => {
    const { client } = makeClient();
    await client.set('k', 'val');
    client._metadata.get('k').expired = Date.now() - 1;
    const result = await client.get('k');
    assert.strictEqual(result, undefined);
    assert.strictEqual(client._metadata.has('k'), false);
    assert.strictEqual(client._stats.cache.misses, 1);
    stopClient(client);
  });

  it('server fallback success: promotes to memory', async () => {
    const { client, ws } = makeClient();
    ws.send = (payload) => {
      const { op, id } = JSON.parse(payload);
      setTimeout(() => {
        const data =
          op === 'getWithMetadata' ? { value: 'from-server', metadata: { isCache: true, customTTL: null } } : null;
        ws.dispatch('message', { data: serialize({ id, data }) });
      }, 5);
    };
    const result = await client.get('server-key');
    assert.strictEqual(result, 'from-server');
    assert.strictEqual(client._stats.cache.promotions, 1);
    assert.strictEqual(client._data.get('server-key'), 'from-server');
    stopClient(client);
  });

  it('server fallback preserves isCache=false so re-demoting keeps the key persistent', async () => {
    const { client, ws } = makeClient();
    const setCalls = [];
    ws.send = (payload) => {
      const { op, id, args } = JSON.parse(payload);
      if (op === 'set') setCalls.push(args);
      setTimeout(() => {
        const data =
          op === 'getWithMetadata' ? { value: 'persisted-value', metadata: { isCache: false, customTTL: null } } : null;
        ws.dispatch('message', { data: serialize({ id, data }) });
      }, 5);
    };
    const result = await client.get('persistent-key');
    assert.strictEqual(result, 'persisted-value');
    assert.strictEqual(client._metadata.get('persistent-key').isCache, false);

    // Simulate a later re-demote (e.g. memory pressure) — must stay classified as persistent.
    client._data.set('persistent-key', 'persisted-value');
    client._metadata.get('persistent-key').dataSizeV8 = 10;
    await client._demote('persistent-key');
    assert.deepEqual(setCalls[0][2], { isCache: false, ttl: null });
    assert.strictEqual(client._metadata.get('persistent-key').expired, Infinity);
    stopClient(client);
  });

  it('server fallback with a legacy plain-value response defaults to isCache=true', async () => {
    const { client, ws } = makeClient();
    mockWsSend(ws, (op) => (op === 'getWithMetadata' ? 'legacy-value' : null));
    const result = await client.get('legacy-key');
    assert.strictEqual(result, 'legacy-value');
    assert.strictEqual(client._metadata.get('legacy-key').isCache, true);
    stopClient(client);
  });

  it('server fallback returns null: miss, returns undefined, no promotion', async () => {
    const { client, ws } = makeClient();
    mockWsSend(ws, () => null);
    const result = await client.get('missing');
    assert.strictEqual(result, undefined);
    assert.strictEqual(client._stats.cache.misses, 1);
    assert.strictEqual(client._stats.cache.promotions, 0);
    stopClient(client);
  });

  it('server fallback throws: increments serverRead error', async () => {
    const { client } = makeClient();
    client._ws = null; // force _send to throw
    // inject a server-only entry in metadata
    client._metadata.set('k', { location: 1, expired: Date.now() + 999_999 });
    const result = await client.get('k');
    assert.strictEqual(result, undefined);
    assert.strictEqual(client._stats.errors.serverRead, 1);
    stopClient(client);
  });
});

// ── _createTask: CLEAR ────────────────────────────────────────────────────────
describe('StoreClient _createTask CLEAR', () => {
  it('clears metadata and data', async () => {
    const { client } = makeClient();
    await client.set('a', 1);
    await client.set('b', 2);
    await client.clear();
    assert.strictEqual(client._metadata.size, 0);
    assert.strictEqual(client._data.size, 0);
    stopClient(client);
  });

  it('calls onDelete for each entry before clearing', async () => {
    const { client } = makeClient();
    await client.set('a', 1);
    await client.set('b', 2);
    const deleted = [];
    client.onDelete = async (key) => {
      deleted.push(key);
    };
    await client.clear();
    assert.deepStrictEqual(deleted.sort(), ['a', 'b']);
    stopClient(client);
  });

  it('swallows _send error, still clears', async () => {
    const { client, ws } = makeClient();
    await client.set('k', 'v');
    ws.send = (payload) => {
      const { op } = JSON.parse(payload);
      if (op === 'clear') {
        throw new Error('send failed');
      }
    };
    await client.clear();
    assert.strictEqual(client._metadata.size, 0);
    stopClient(client);
  });
});

// ── _createTask: HAS / METADATA / ATTR ───────────────────────────────────────
describe('StoreClient _createTask HAS/METADATA/ATTR', () => {
  it('has() returns true when key in metadata', async () => {
    const { client } = makeClient();
    await client.set('k', 'v');
    assert.strictEqual(await client.has('k'), true);
    assert.strictEqual(await client.has('missing'), false);
    stopClient(client);
  });

  it('metadata() returns copy of meta object', async () => {
    const { client } = makeClient();
    await client.set('k', 'v');
    const meta = await client.metadata('k');
    assert.ok('location' in meta);
    assert.ok('expired' in meta);
    stopClient(client);
  });

  it('metadata() returns {} for missing key', async () => {
    const { client } = makeClient();
    const meta = await client.metadata('nope');
    assert.deepStrictEqual(meta, {});
    stopClient(client);
  });

  it('setAttr/getAttr when WS connected', async () => {
    const { client, ws } = makeClient();
    mockWsSend(ws, (op) => (op === 'get-attr' ? 'attr-value' : true));
    const set = await client.setAttr('myattr', 'val');
    assert.strictEqual(set, true);
    const got = await client.getAttr('myattr');
    assert.strictEqual(got, 'attr-value');
    stopClient(client);
  });

  it('setAttr returns false when WS disconnected', async () => {
    const { client } = makeClient();
    client._ws = null;
    // ATTR actions are always allowed even when inactive
    const result = await client.setAttr('k', 'v');
    assert.strictEqual(result, false);
    stopClient(client);
  });

  it('getAttr returns undefined when WS disconnected', async () => {
    const { client } = makeClient();
    client._ws = null;
    const result = await client.getAttr('k');
    assert.strictEqual(result, undefined);
    stopClient(client);
  });
});

// ── _createTask: DELETE ───────────────────────────────────────────────────────
describe('StoreClient _createTask DELETE', () => {
  it('removes key from memory', async () => {
    const { client } = makeClient();
    await client.set('k', 'v');
    await client.delete('k');
    assert.strictEqual(client._metadata.has('k'), false);
    assert.strictEqual(client._data.has('k'), false);
    stopClient(client);
  });
});

// ── _createTask: unknown action ───────────────────────────────────────────────
describe('StoreClient _createTask unknown action', () => {
  it('throws for unknown action number', () => {
    const client = new StoreClient();
    assert.throws(() => client._createTask(99), /Unknown action/);
  });
});

// ── _demote ───────────────────────────────────────────────────────────────────
describe('StoreClient _demote', () => {
  it('moves item to SERVER on success', async () => {
    const { client, ws } = makeClient();
    mockWsSend(ws, () => true);
    await client.set('k', 'v');
    await client._demote('k');
    assert.strictEqual(client._metadata.get('k').location, 1); // SERVER
    assert.strictEqual(client._data.has('k'), false);
    assert.strictEqual(client._stats.cache.demotions, 1);
    stopClient(client);
  });

  it('skips when dataSizeV8 < 1', async () => {
    const { client } = makeClient();
    client._metadata.set('k', { dataSizeV8: 0, location: 0 });
    await client._demote('k');
    assert.strictEqual(client._metadata.get('k').location, 0); // unchanged
    stopClient(client);
  });

  it('stays MEMORY and increments serverWrite on send error', async () => {
    const { client } = makeClient();
    await client.set('k', 'v');
    client._ws = null; // force _send to fail
    await client._demote('k');
    assert.strictEqual(client._metadata.get('k').location, 0); // MEMORY
    assert.strictEqual(client._stats.errors.serverWrite, 1);
    stopClient(client);
  });

  it('uses customTTL for expired when present', async () => {
    const { client, ws } = makeClient();
    mockWsSend(ws, () => true);
    await client.set('k', 'v', { ttl: 9999 });
    const before = Date.now();
    await client._demote('k');
    const meta = client._metadata.get('k');
    assert.ok(meta.expired >= before + 9000);
    stopClient(client);
  });
});

// ── _deleteFromBackend ────────────────────────────────────────────────────────
describe('StoreClient _deleteFromBackend', () => {
  it('calls _send delete for SERVER location', async () => {
    const { client, ws } = makeClient();
    const ops = [];
    ws.send = (payload) => {
      const parsed = JSON.parse(payload);
      ops.push(parsed.op);
      setTimeout(() => ws.dispatch('message', { data: serialize({ id: parsed.id, data: null }) }), 5);
    };
    await client._deleteFromBackend('k', { location: 1 });
    assert.ok(ops.includes('delete'));
    stopClient(client);
  });

  it('skips _send for MEMORY location', async () => {
    const { client } = makeClient();
    let sendCalled = false;
    client._ws.send = () => {
      sendCalled = true;
    };
    await client._deleteFromBackend('k', { location: 0 });
    assert.strictEqual(sendCalled, false);
    stopClient(client);
  });
});

// ── getStats ──────────────────────────────────────────────────────────────────
describe('StoreClient getStats', () => {
  it('connected:true when ws.readyState === OPEN', async () => {
    const { client } = makeClient();
    const stats = await client.getStats();
    assert.strictEqual(stats.connected, true);
    stopClient(client);
  });

  it('connected:false when ws is null', async () => {
    const { client } = makeClient();
    client._ws = null;
    const stats = await client.getStats();
    assert.strictEqual(stats.connected, false);
    stopClient(client);
  });

  it('itemsInMemory and itemsOnServer counted correctly', async () => {
    const { client } = makeClient();
    await client.set('mem', 'v');
    client._metadata.set('srv', { location: 1, dataSizeV8: 0 });
    const stats = await client.getStats();
    assert.strictEqual(stats.storage.itemsInMemory, 1);
    assert.strictEqual(stats.storage.itemsOnServer, 1);
    stopClient(client);
  });
});

// ── _send ─────────────────────────────────────────────────────────────────────
describe('StoreClient _send', () => {
  afterEach(() => {
    mock.restoreAll();
    mock.timers.reset();
  });

  it('rejects when WS not open', async () => {
    const client = new StoreClient();
    client._ws = null;
    client._reconnect = false; // prevent _ensureConnected from attempting a real connect
    await assert.rejects(() => client._send('get', ['k']), /WebSocket not connected/);
  });

  it('rejects when ws.send throws', async () => {
    const { client, ws } = makeClient();
    ws.send = () => {
      throw new Error('send failed');
    };
    await assert.rejects(() => client._send('get', ['k']), { message: 'send failed' });
    stopClient(client);
  });

  it('times out after 30s', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { client, ws } = makeClient();
    // ws.send succeeds but never emits a response
    ws.send = (_payload) => {};

    const sendPromise = client._send('get', ['k']);
    const rejectPromise = assert.rejects(sendPromise, /Request timed out/);
    // _send is now async (await _ensureConnected), so the 30s timer is created
    // on the next microtask tick — drain that before advancing fake clock
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(30_001);
    await new Promise((r) => setImmediate(r));
    await rejectPromise;
    assert.strictEqual(client._pendingRequests.size, 0);
    stopClient(client);
  });
});

// ── close() ───────────────────────────────────────────────────────────────────
describe('StoreClient close', () => {
  it('returns false when already inactive', async () => {
    const client = new StoreClient();
    const result = await client.close();
    assert.strictEqual(result, false);
  });

  it('drains queue, calls _demoteAll, closes WS, returns true', async () => {
    const { client, ws } = makeClient();
    const drained = [];
    client._queues.push(async () => {
      drained.push('task');
    });
    // _demoteAll will call _send; mock it to succeed
    mockWsSend(ws, () => true);
    const result = await client.close();
    assert.strictEqual(result, true);
    assert.deepStrictEqual(drained, ['task']);
    assert.strictEqual(client._ws, null);
  });

  it('works when no WS attached', async () => {
    const client = new StoreClient();
    client._active = true;
    client._reconnect = false;
    const result = await client.close();
    assert.strictEqual(result, true);
  });
});

// ── ready() ───────────────────────────────────────────────────────────────────
describe('StoreClient ready', () => {
  afterEach(() => mock.restoreAll());

  it('sets _active and is idempotent (second call is no-op)', async () => {
    const client = new StoreClient({ url: 'ws://mock' });
    mock.method(client, '_connectForShutdown', async () => false);
    await client.ready();
    assert.strictEqual(client._active, true);
    await client.ready(); // second call — no-op (returns early)
    await client.close();
  });
});

// ── _scheduleRetry ────────────────────────────────────────────────────────────
describe('StoreClient _scheduleRetry', () => {
  afterEach(() => {
    mock.restoreAll();
    mock.timers.reset();
  });

  it('calls resolve immediately when _reconnect=false', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const client = new StoreClient();
    client._reconnect = false;
    let resolved = false;
    client._scheduleRetry(() => {
      resolved = true;
    });
    assert.strictEqual(resolved, true);
  });

  it('schedules a retry timer when _reconnect=true', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const client = new StoreClient();
    client._reconnect = true;
    mock.method(client, 'connect', async () => {});
    let resolved = false;
    client._scheduleRetry(() => {
      resolved = true;
    });
    assert.strictEqual(resolved, false);
    mock.timers.tick(10_000);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(resolved, true);
    client._reconnect = false;
  });
});

// ── close() drain loop when a queued task throws ──────────────────────────────
describe('StoreClient close drains tasks that throw', () => {
  it('swallows task errors during queue drain', async () => {
    const client = new StoreClient();
    client._active = true;
    client._reconnect = false;
    // Push a throwing task without waking the worker
    client._queues.push(async () => {
      throw new Error('task boom');
    });
    const result = await client.close();
    assert.strictEqual(result, true);
    assert.strictEqual(client._queues.length, 0);
  });
});

// ── close() when _send('close') throws ───────────────────────────────────────
describe('StoreClient close WS send failure', () => {
  afterEach(() => mock.restoreAll());

  it('ignores error when sending close to WS fails', async () => {
    const client = new StoreClient();
    client._active = true;
    client._reconnect = false;
    const ws = makeMockWs();
    client._ws = ws;
    // Make _send throw
    mock.method(client, '_send', async () => {
      throw new Error('send failed');
    });
    const result = await client.close();
    assert.strictEqual(result, true);
    assert.strictEqual(client._ws, null);
  });
});

// ── CLEAR onDelete throws ─────────────────────────────────────────────────────
describe('StoreClient CLEAR onDelete throws', () => {
  it('swallows onDelete errors during clear', async () => {
    const client = new StoreClient();
    client._active = true;
    client._reconnect = false;
    client._startQueueWorker();
    await client.set('a', 1);
    await client.set('b', 2);
    client.onDelete = async () => {
      throw new Error('hook error');
    };
    await client.clear(); // should not throw
    assert.strictEqual(client._metadata.size, 0);
    stopClient(client);
  });
});

// ── GET returns undefined when server has no value ────────────────────────────
describe('StoreClient GET returns undefined when server misses', () => {
  afterEach(() => mock.restoreAll());

  it('increments cache.misses when server returns null', async () => {
    const client = new StoreClient();
    client._active = true;
    client._reconnect = false;
    client._startQueueWorker();
    // Manually place key in SERVER location (simulating a previously demoted key)
    client._metadata.set('missing', {
      created: Date.now(),
      isCache: false,
      location: 1, // SERVER
      dataSizeV8: 10,
      expired: Date.now() + 60000,
      lastAccess: Date.now(),
      accessCount: 0,
    });
    // Mock _send to return null (server doesn't have the key)
    mock.method(client, '_send', async () => null);
    const result = await client.get('missing');
    assert.strictEqual(result, undefined);
    assert.strictEqual(client._stats.cache.misses, 1);
    stopClient(client);
  });
});

// ── _deleteFromBackend swallows send error ────────────────────────────────────
describe('StoreClient _deleteFromBackend swallows send error', () => {
  afterEach(() => mock.restoreAll());

  it('does not throw when _send fails during delete', async () => {
    const client = new StoreClient();
    mock.method(client, '_send', async () => {
      throw new Error('ws error');
    });
    // Call with a SERVER-location meta
    await client._deleteFromBackend('k', { location: 1 }); // should not throw
  });
});

// ── _demoteAll promotes all memory items ──────────────────────────────────────
describe('StoreClient _demoteAll promotes all memory items', () => {
  afterEach(() => mock.restoreAll());

  it('calls _demote for each in-memory item', async () => {
    const client = new StoreClient();
    client._active = true;
    client._reconnect = false;
    client._startQueueWorker();
    await client.set('x', { v: 1 });
    await client.set('y', { v: 2 });
    // Ensure both are in memory
    assert.strictEqual(client._metadata.get('x').location, 0);
    assert.strictEqual(client._metadata.get('y').location, 0);
    const demoted = [];
    mock.method(client, '_demote', async (key) => {
      demoted.push(key);
    });
    await client._demoteAll();
    assert.ok(demoted.includes('x'));
    assert.ok(demoted.includes('y'));
    stopClient(client);
  });
});

// ── GET serialize error during server promotion ───────────────────────────────
describe('StoreClient GET serialize error during promotion', () => {
  afterEach(() => mock.restoreAll());

  it('still returns value when serialize(value) throws in promotion path', async () => {
    const client = new StoreClient();
    client._active = true;
    client._reconnect = false;
    client._startQueueWorker();
    // Return a value that serialize() will fail on (arrow function)
    const unserializable = () => {};
    mock.method(client, '_send', async () => unserializable);
    // No metadata for this key — falls through to server path
    const result = await client.get('srv-key');
    // Value is promoted even if serialize fails (dataSizeV8 stays 0)
    assert.strictEqual(result, unserializable);
    assert.strictEqual(client._stats.cache.promotions, 1);
    stopClient(client);
  });
});

// ── ready(): no auto-connect ──────────────────────────────────────────────────
describe('StoreClient ready (connect-on-demand)', () => {
  afterEach(() => mock.restoreAll());

  it('does not call connect() during startup', async () => {
    const client = new StoreClient({ url: 'ws://mock' });
    let connectCalled = false;
    mock.method(client, 'connect', async () => {
      connectCalled = true;
    });
    await client.ready();
    assert.strictEqual(connectCalled, false);
    await client.close();
  });
});

// ── close(): shutdown sequence ────────────────────────────────────────────────
describe('StoreClient close (shutdown sequence)', () => {
  afterEach(() => {
    mock.restoreAll();
    mock.timers.reset();
  });

  it('clears idle timer at start of shutdown', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { client } = makeClient();
    let idleFired = false;
    mock.method(client, '_disconnectIdle', () => {
      idleFired = true;
    });
    client._resetIdleTimer();
    mock.method(client, '_connectForShutdown', async () => true);
    mock.method(client, '_demoteAll', async () => {});
    await client.close();
    mock.timers.tick(StoreClient.IDLE_DISCONNECT_MS + 1000);
    assert.strictEqual(idleFired, false);
    assert.strictEqual(client._idleTimer, null);
  });

  it('calls _demoteAll when _connectForShutdown returns true', async () => {
    const { client } = makeClient();
    mock.method(client, '_connectForShutdown', async () => true);
    let demoteAllCalled = false;
    mock.method(client, '_demoteAll', async () => {
      demoteAllCalled = true;
    });
    await client.close();
    assert.strictEqual(demoteAllCalled, true);
  });

  it('skips _demoteAll and logs warning when _connectForShutdown returns false and items exist', async () => {
    const client = new StoreClient({ url: 'ws://mock' });
    client._active = true;
    client._metadata.set('k', { location: 0, dataSizeV8: 10, expired: Infinity });
    const logs = [];
    client._log = (level, ...rest) => logs.push([level, rest.join(' ')]);
    mock.method(client, '_connectForShutdown', async () => false);
    let demoteAllCalled = false;
    mock.method(client, '_demoteAll', async () => {
      demoteAllCalled = true;
    });
    await client.close();
    assert.strictEqual(demoteAllCalled, false);
    assert.ok(
      logs.some(([level, msg]) => level === 'warn' && msg.includes('1 items not persisted')),
      'expected warning about unpersisted items',
    );
  });

  it('does not log warning when server unreachable but no in-memory items', async () => {
    const client = new StoreClient({ url: 'ws://mock' });
    client._active = true;
    const logs = [];
    client._log = (level, ...rest) => logs.push([level, rest.join(' ')]);
    mock.method(client, '_connectForShutdown', async () => false);
    mock.method(client, '_demoteAll', async () => {});
    await client.close();
    assert.ok(!logs.some(([level]) => level === 'warn'));
  });
});
