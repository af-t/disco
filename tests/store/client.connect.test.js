import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { serialize } from 'node:v8';

// All MockWS instances created during tests
const wsInstances = [];

class MockWS {
  static OPEN = 1;
  constructor(url) {
    wsInstances.push(this);
    this.url = url;
    this.readyState = 1; // OPEN
    this.binaryType = 'arraybuffer';
    this._listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }
  dispatch(type, detail) {
    const event = { type, ...detail };
    for (const fn of this._listeners.get(type) ?? []) fn(event);
  }
  send(payload) {
    try {
      const msg = JSON.parse(payload);
      setImmediate(() => this.dispatch('message', { data: serialize({ id: msg.id, data: null }) }));
    } catch {}
  }
  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.dispatch('close', { code, reason, wasClean: true });
  }
}

// Dynamic import AFTER MockWS is defined
const { default: StoreClient } = await import('../../src/store/client.js');

// Helper to drain setImmediate queue multiple times
const drain = (n = 5) =>
  new Promise((r) => {
    let i = 0;
    const tick = () => {
      if (++i >= n) r();
      else setImmediate(tick);
    };
    setImmediate(tick);
  });

// ── connect(): guards (run first while wsInstances is clean) ──────────────────
describe('StoreClient connect guards', () => {
  afterEach(() => {
    wsInstances.length = 0;
    mock.restoreAll();
  });

  it('returns early when _reconnect=false', async () => {
    const client = new StoreClient({ url: 'ws://mock', webSocketImpl: MockWS });
    client._reconnect = false;
    const result = await client.connect();
    assert.strictEqual(result, undefined); // early return
    assert.strictEqual(wsInstances.length, 0); // no WebSocket created
  });

  it('returns early when already _connecting', async () => {
    const client = new StoreClient({ url: 'ws://mock', webSocketImpl: MockWS });
    client._connecting = true;
    const result = await client.connect();
    assert.strictEqual(result, undefined);
    assert.strictEqual(wsInstances.length, 0);
  });
});

// ── connect(): 'open' event ───────────────────────────────────────────────────
describe('StoreClient connect open event', () => {
  afterEach(() => {
    wsInstances.length = 0;
    mock.restoreAll();
  });

  it('resolves after open fires and _send new+ready succeed', async () => {
    const client = new StoreClient({ url: 'ws://mock', webSocketImpl: MockWS });
    // _reconnect is true by default — connect() will proceed
    // Disable reconnect AFTER starting connect so retry loops don't fire
    const connectPromise = client.connect();
    client._reconnect = false;

    // MockWS was created synchronously inside connect()
    assert.strictEqual(wsInstances.length, 1);

    wsInstances[0].dispatch('open', {});
    await drain();
    await connectPromise;

    assert.strictEqual(client._connecting, false);
    assert.strictEqual(client._retryAttempt, 0);
  });

  it('logs warning when _send fails inside open handler but still resolves', async () => {
    const client = new StoreClient({ url: 'ws://mock', webSocketImpl: MockWS });
    const logs = [];
    client._log = (level, ...rest) => {
      logs.push([level, rest.join(' ')]);
    };
    const connectPromise = client.connect();
    client._reconnect = false;

    // Override send to always error so _send('new') rejects inside the open handler
    wsInstances[0].send = (_payload) => {
      throw new Error('send error');
    };
    wsInstances[0].dispatch('open', {});
    await connectPromise; // still resolves — error is caught internally
    assert.strictEqual(client._connecting, false);
    assert.ok(
      logs.some(([level, msg]) => level === 'error' && msg.includes('failed to initialize')),
      'open-handler _send failure should be logged at error level',
    );
  });
});

// ── connect(): 'error' event ──────────────────────────────────────────────────
describe('StoreClient connect error event', () => {
  afterEach(() => {
    wsInstances.length = 0;
    mock.restoreAll();
  });

  it('clears _ws and calls scheduleRetry on error', async () => {
    const client = new StoreClient({ url: 'ws://mock', webSocketImpl: MockWS });
    const connectPromise = client.connect();
    // Disable reconnect so scheduleRetry resolves immediately
    client._reconnect = false;

    assert.strictEqual(wsInstances.length, 1);
    wsInstances[0].dispatch('error', { message: 'ECONNREFUSED', error: new Error('ECONNREFUSED') });
    await connectPromise;

    assert.strictEqual(client._ws, null);
    assert.strictEqual(client._connecting, false);
    assert.strictEqual(client._retryAttempt, 1);
  });
});

// ── connect(): 'close' event (no reconnect) ───────────────────────────────────
describe('StoreClient connect close event no reconnect', () => {
  afterEach(() => {
    wsInstances.length = 0;
    mock.restoreAll();
  });

  it('resolves and clears _ws when closed without reconnect', async () => {
    const client = new StoreClient({ url: 'ws://mock', webSocketImpl: MockWS });
    const connectPromise = client.connect();
    client._reconnect = false;

    assert.strictEqual(wsInstances.length, 1);
    wsInstances[0].dispatch('close', { code: 1000, reason: '' });
    await connectPromise;

    assert.strictEqual(client._ws, null);
    assert.strictEqual(client._connecting, false);
  });
});

// ── connect(): 'close' event (with reconnect) ─────────────────────────────────
describe('StoreClient connect close event with reconnect', () => {
  afterEach(() => {
    wsInstances.length = 0;
    mock.restoreAll();
    mock.timers.reset();
  });

  it('schedules retry when reconnect=true and close fires', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const client = new StoreClient({ url: 'ws://mock', webSocketImpl: MockWS });
    // reconnect=true by default — keep it true so close triggers a retry

    const connectPromise = client.connect();
    // wsInstances[0] is the first WS, emit close with reconnect=true
    wsInstances[0].dispatch('close', { code: 1000, reason: '' });

    // After close, retryAttempt is incremented and timer scheduled
    assert.strictEqual(client._retryAttempt, 1);

    // Disable reconnect so when the timer fires, scheduleRetry resolves immediately
    client._reconnect = false;
    mock.timers.tick(10_000);
    await drain(10);

    await Promise.race([connectPromise, new Promise((_, r) => setTimeout(r, 200, new Error('timeout')))]);
  });
});

// ── connect(): 'message' event ─────────────────────────────────────────────────
describe('StoreClient connect message event', () => {
  afterEach(() => {
    wsInstances.length = 0;
    mock.restoreAll();
  });

  it('handles deserialize error in message handler gracefully', async () => {
    const client = new StoreClient({ url: 'ws://mock', webSocketImpl: MockWS });
    const logs = [];
    client._log = (level, ...rest) => {
      logs.push([level, rest.join(' ')]);
    };
    const connectPromise = client.connect();
    client._reconnect = false;

    // Emit a malformed buffer — the message handler must catch the deserialize error
    wsInstances[0].dispatch('message', { data: Buffer.from('not-v8-data') });

    wsInstances[0].dispatch('close', { code: 1000, reason: '' });
    await connectPromise;
    assert.ok(
      logs.some(([level, msg]) => level === 'error' && msg.includes('deserialize failed')),
      'deserialize error should be logged',
    );
  });

  it('routes valid message to pending request resolver', async () => {
    const client = new StoreClient({ url: 'ws://mock', webSocketImpl: MockWS });
    const connectPromise = client.connect();
    client._reconnect = false;

    // Register a pending request manually
    let resolved;
    const pendingPromise = new Promise((res) => {
      client._pendingRequests.set(42, {
        resolve: (v) => {
          resolved = v;
          res(v);
        },
        reject: () => {},
      });
    });

    // Emit a valid serialized response
    wsInstances[0].dispatch('message', { data: serialize({ id: 42, data: 'hello' }) });

    await pendingPromise;
    assert.strictEqual(resolved, 'hello');
    assert.strictEqual(client._pendingRequests.has(42), false);

    wsInstances[0].dispatch('close', { code: 1000, reason: '' });
    await connectPromise;
  });
});

// ── _ensureConnected() ────────────────────────────────────────────────────────
describe('StoreClient _ensureConnected', () => {
  afterEach(() => {
    wsInstances.length = 0;
    mock.restoreAll();
  });

  it('returns immediately when WS is already OPEN', async () => {
    const client = new StoreClient({ url: 'ws://mock', webSocketImpl: MockWS });
    const ws = new MockWS('ws://mock');
    client._ws = ws;
    let connectCalled = false;
    mock.method(client, 'connect', async () => { connectCalled = true; });
    await client._ensureConnected();
    assert.strictEqual(connectCalled, false);
  });

  it('calls connect() when _ws is null', async () => {
    const client = new StoreClient({ url: 'ws://mock', webSocketImpl: MockWS });
    let connectCalled = false;
    mock.method(client, 'connect', async () => { connectCalled = true; });
    await client._ensureConnected();
    assert.strictEqual(connectCalled, true);
  });

  it('deduplicates concurrent calls — connect() called only once', async () => {
    const client = new StoreClient({ url: 'ws://mock', webSocketImpl: MockWS });
    let callCount = 0;
    let resolveConnect;
    mock.method(client, 'connect', () => new Promise((r) => {
      callCount++;
      resolveConnect = r;
    }));
    const p1 = client._ensureConnected();
    const p2 = client._ensureConnected();
    resolveConnect();
    await Promise.all([p1, p2]);
    assert.strictEqual(callCount, 1);
    assert.strictEqual(client._connectPromise, null); // cleared after resolution
  });

  it('resets _retryAttempt to 0 before calling connect()', async () => {
    const client = new StoreClient({ url: 'ws://mock', webSocketImpl: MockWS });
    client._retryAttempt = 5;
    mock.method(client, 'connect', async () => {});
    await client._ensureConnected();
    assert.strictEqual(client._retryAttempt, 0);
  });
});

// ── Idle disconnect ───────────────────────────────────────────────────────────
describe('StoreClient idle disconnect', () => {
  afterEach(() => {
    wsInstances.length = 0;
    mock.restoreAll();
    mock.timers.reset();
  });

  it('_disconnectIdle sets _intentionalClose and closes WS', () => {
    const client = new StoreClient({ url: 'ws://mock', webSocketImpl: MockWS });
    const ws = new MockWS('ws://mock');
    client._ws = ws;
    client._disconnectIdle();
    assert.strictEqual(client._intentionalClose, true);
    assert.strictEqual(ws.readyState, 3); // CLOSED
  });

  it('_disconnectIdle is a no-op when _ws is null', () => {
    const client = new StoreClient({ url: 'ws://mock', webSocketImpl: MockWS });
    assert.doesNotThrow(() => client._disconnectIdle());
  });

  it('_resetIdleTimer schedules _disconnectIdle after IDLE_DISCONNECT_MS', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const client = new StoreClient({ url: 'ws://mock', webSocketImpl: MockWS });
    const ws = new MockWS('ws://mock');
    client._ws = ws;
    let idleFired = false;
    mock.method(client, '_disconnectIdle', () => { idleFired = true; });
    client._resetIdleTimer();
    assert.strictEqual(idleFired, false);
    mock.timers.tick(StoreClient.IDLE_DISCONNECT_MS);
    assert.strictEqual(idleFired, true);
  });

  it('close handler with _intentionalClose=true resolves without retry and resets flag', async () => {
    const client = new StoreClient({ url: 'ws://mock', webSocketImpl: MockWS });
    const connectPromise = client.connect();
    client._reconnect = true; // would normally trigger retry

    client._intentionalClose = true;
    wsInstances[0].dispatch('close', { code: 1000, reason: '' });
    await connectPromise;

    assert.strictEqual(client._ws, null);
    assert.strictEqual(client._intentionalClose, false);
    assert.strictEqual(client._retryAttempt, 0); // no retry increment
  });

  it('close handler with _intentionalClose=false and _reconnect=true schedules retry', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const client = new StoreClient({ url: 'ws://mock', webSocketImpl: MockWS });
    const connectPromise = client.connect();

    wsInstances[0].dispatch('close', { code: 1000, reason: '' });
    assert.strictEqual(client._retryAttempt, 1);
    assert.strictEqual(client._intentionalClose, false); // flag untouched on server-initiated close

    client._reconnect = false;
    mock.timers.tick(10_000);
    await connectPromise;
  });

  it('close handler clears _idleTimer so stale timer cannot fire on a new connection', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const client = new StoreClient({ url: 'ws://mock', webSocketImpl: MockWS });
    const connectPromise = client.connect();
    // arm an idle timer
    let idleFired = false;
    mock.method(client, '_disconnectIdle', () => { idleFired = true; });
    client._resetIdleTimer();
    // simulate unexpected server close
    client._reconnect = false;
    wsInstances[0].dispatch('close', { code: 1006, reason: '' });
    await connectPromise;
    // advance past idle timeout — should NOT fire since timer was cleared on close
    mock.timers.tick(StoreClient.IDLE_DISCONNECT_MS + 1000);
    assert.strictEqual(idleFired, false);
  });
});

// ── _connectForShutdown() ─────────────────────────────────────────────────────
describe('StoreClient _connectForShutdown', () => {
  afterEach(() => {
    wsInstances.length = 0;
    mock.restoreAll();
    mock.timers.reset();
  });

  it('returns true immediately when WS is already OPEN', async () => {
    const client = new StoreClient({ url: 'ws://mock', webSocketImpl: MockWS });
    const ws = new MockWS('ws://mock'); // MockWS.OPEN = 1, readyState = 1
    client._ws = ws;
    const result = await client._connectForShutdown(5000);
    assert.strictEqual(result, true);
  });

  it('returns true when connect() succeeds and WS is OPEN', async () => {
    const client = new StoreClient({ url: 'ws://mock', webSocketImpl: MockWS });
    mock.method(client, 'connect', async () => {
      client._ws = new MockWS('ws://mock');
    });
    const result = await client._connectForShutdown(5000);
    assert.strictEqual(result, true);
  });

  it('returns false when connect() times out', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const client = new StoreClient({ url: 'ws://mock', webSocketImpl: MockWS });
    let resolveConnect;
    mock.method(client, 'connect', () => new Promise((r) => { resolveConnect = r; }));
    const resultPromise = client._connectForShutdown(100);
    mock.timers.tick(101);
    const result = await resultPromise;
    assert.strictEqual(result, false);
    resolveConnect?.();
  });

  it('returns false when connect() resolves but WS is not OPEN', async () => {
    const client = new StoreClient({ url: 'ws://mock', webSocketImpl: MockWS });
    mock.method(client, 'connect', async () => {
      // connect resolves but _ws stays null (error path)
    });
    const result = await client._connectForShutdown(5000);
    assert.strictEqual(result, false);
  });

  it('awaits existing _connectPromise instead of starting a duplicate connect', async () => {
    const client = new StoreClient({ url: 'ws://mock', webSocketImpl: MockWS });
    let connectCalled = false;
    mock.method(client, 'connect', async () => { connectCalled = true; });
    // simulate an in-flight connect by setting _connectPromise directly
    let resolveInFlight;
    client._connectPromise = new Promise((r) => { resolveInFlight = r; });
    const resultPromise = client._connectForShutdown(5000);
    // resolve in-flight connect with a live WS
    client._ws = new MockWS('ws://mock');
    resolveInFlight();
    const result = await resultPromise;
    assert.strictEqual(result, true);
    assert.strictEqual(connectCalled, false); // no duplicate connect started
  });
});
