import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createSignalHandler } from '../../src/store/shutdown.js';

function fakeSocket() {
  return { destroy: mock.fn() };
}

function setup({ drainTimeoutMs } = {}) {
  const requestLog = new Map();
  const store = { close: mock.fn(async () => true) };
  const closeServer = mock.fn();
  const handleSignal = createSignalHandler({
    getStore: () => store,
    requestLog,
    closeServer,
    drainTimeoutMs,
  });
  return { requestLog, store, closeServer, handleSignal };
}

describe('store shutdown signal handler', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'] }));
  afterEach(() => {
    delete process.env.STORE_SHUTDOWN_DRAIN_MS;
    mock.timers.reset();
  });

  it('persists and closes immediately when no clients are connected', async () => {
    const { handleSignal, store, closeServer } = setup();

    await handleSignal();

    assert.equal(store.close.mock.callCount(), 1);
    assert.equal(closeServer.mock.callCount(), 1);
  });

  it('destroys clients still connected once the drain window elapses', async () => {
    const { requestLog, handleSignal, store, closeServer } = setup({ drainTimeoutMs: 250 });
    const socket = fakeSocket();
    requestLog.set('10.0.0.1', socket);

    const shutdown = handleSignal();
    mock.timers.tick(300);
    await shutdown;

    assert.equal(socket.destroy.mock.callCount(), 1);
    assert.equal(requestLog.size, 0);
    assert.equal(store.close.mock.callCount(), 1);
    assert.equal(closeServer.mock.callCount(), 1);
  });

  it('stops waiting as soon as every client disconnects', async () => {
    const startedAt = Date.now();
    const { requestLog, handleSignal, store } = setup({ drainTimeoutMs: 5000 });
    requestLog.set('10.0.0.2', fakeSocket());

    const shutdown = handleSignal();
    mock.timers.tick(50);
    requestLog.delete('10.0.0.2');
    mock.timers.tick(50);
    await shutdown;

    assert.equal(Date.now() - startedAt, 100);
    assert.equal(store.close.mock.callCount(), 1);
  });

  it('runs the shutdown at most once across repeated signals', async () => {
    const { handleSignal, store } = setup();

    const first = handleSignal();
    const second = handleSignal();

    assert.equal(first, second);
    await first;
    assert.equal(store.close.mock.callCount(), 1);
  });

  it('reads the drain window from STORE_SHUTDOWN_DRAIN_MS when not overridden', async () => {
    process.env.STORE_SHUTDOWN_DRAIN_MS = '100';
    const { requestLog, handleSignal } = setup();
    requestLog.set('10.0.0.3', fakeSocket());

    const shutdown = handleSignal();
    mock.timers.tick(150);
    await shutdown;

    assert.equal(requestLog.size, 0);
  });
});
