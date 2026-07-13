import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { APP_DEFINITIONS, AppSupervisor, installSignalHandlers, startApp } from '../../script/start-app.js';

const projectRoot = join(import.meta.dirname, '..', '..');
const silentLogger = { info() {}, warn() {}, error() {} };

afterEach(() => mock.restoreAll());

function createChild() {
  const child = new EventEmitter();
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    return true;
  };
  return child;
}

function createFork() {
  const calls = [];
  const forkFn = (script, args, options) => {
    const child = createChild();
    calls.push({ script, args, options, child });
    return child;
  };
  return { calls, forkFn };
}

function createTimers() {
  let nextId = 0;
  const pending = new Map();
  const cleared = [];
  const setTimeoutFn = (fn, delay) => {
    const handle = ++nextId;
    pending.set(handle, { fn, delay });
    return handle;
  };
  const clearTimeoutFn = (handle) => {
    cleared.push(handle);
    pending.delete(handle);
  };
  return { pending, cleared, setTimeoutFn, clearTimeoutFn };
}

function createSupervisor(overrides = {}) {
  const fork = createFork();
  const timers = createTimers();
  const supervisor = new AppSupervisor({
    forkFn: fork.forkFn,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    logger: silentLogger,
    ...overrides,
  });
  return { supervisor, fork, timers };
}

function firstPendingTimer(timers) {
  return [...timers.pending.entries()][0];
}

function exitChild(child, code = 0, signal = null) {
  child.emit('exit', code, signal);
}

describe('AppSupervisor', () => {
  it('exports store-first application definitions without starting them', () => {
    assert.deepEqual(
      APP_DEFINITIONS.map(({ name, script }) => ({ name, script })),
      [
        { name: 'store', script: join(projectRoot, 'src', 'store', 'server.js') },
        { name: 'bot', script: join(projectRoot, 'src', 'index.js') },
      ],
    );
  });

  it('starts the store before the bot with inherited output and project cwd', () => {
    const { supervisor, fork } = createSupervisor();

    supervisor.start();
    supervisor.start();

    assert.deepEqual(
      fork.calls.map(({ script }) => script),
      APP_DEFINITIONS.map(({ script }) => script),
    );
    for (const call of fork.calls) {
      assert.deepEqual(call.args, []);
      assert.deepEqual(call.options, { cwd: projectRoot, stdio: 'inherit' });
    }
  });

  it('restarts only the child that exits unexpectedly', () => {
    const { supervisor, fork, timers } = createSupervisor();
    supervisor.start();
    const bot = fork.calls[1].child;

    exitChild(bot, 1);

    assert.equal(timers.pending.size, 1);
    const [, restart] = firstPendingTimer(timers);
    assert.equal(restart.delay, 1_000);

    restart.fn();

    assert.equal(fork.calls.length, 3);
    assert.equal(fork.calls[2].script, APP_DEFINITIONS[1].script);
  });

  it('cancels pending restarts and terminates children during shutdown', async () => {
    const { supervisor, fork, timers } = createSupervisor();
    supervisor.start();
    const store = fork.calls[0].child;
    const bot = fork.calls[1].child;
    exitChild(bot, 1);
    const [restartHandle, restart] = firstPendingTimer(timers);

    const shutdown = supervisor.shutdown();

    assert.ok(timers.cleared.includes(restartHandle));
    assert.deepEqual(store.kills, ['SIGTERM']);
    assert.deepEqual(bot.kills, []);

    restart.fn();
    assert.equal(fork.calls.length, 2);

    exitChild(store, 0, 'SIGTERM');
    await shutdown;
    assert.equal(timers.pending.size, 0);
  });

  it('force-kills children that exceed the shutdown grace period', async () => {
    const { supervisor, fork, timers } = createSupervisor();
    supervisor.start();
    const children = fork.calls.map(({ child }) => child);

    const shutdown = supervisor.shutdown();
    const [, forceShutdown] = firstPendingTimer(timers);

    assert.equal(forceShutdown.delay, 5_000);
    forceShutdown.fn();
    for (const child of children) assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);

    for (const child of children) exitChild(child, null, 'SIGKILL');
    await shutdown;
    assert.equal(timers.pending.size, 0);
  });
});

describe('startApp', () => {
  it('loads the root env file before starting children', () => {
    const order = [];
    const processRef = new EventEmitter();
    processRef.exit = () => {};
    const loadEnvFileFn = (file) => order.push({ type: 'env', file });
    const forkFn = (script) => {
      order.push({ type: 'fork', script });
      return createChild();
    };

    startApp({
      processRef,
      loadEnvFileFn,
      supervisorOptions: { forkFn, logger: silentLogger },
    });

    assert.deepEqual(order[0], { type: 'env', file: join(projectRoot, '.env') });
    assert.equal(order[1].type, 'fork');
  });

  it('tolerates a missing env file', () => {
    const fork = createFork();
    const processRef = new EventEmitter();
    processRef.exit = () => {};

    assert.doesNotThrow(() =>
      startApp({
        processRef,
        loadEnvFileFn: () => {
          throw new Error('missing');
        },
        supervisorOptions: { forkFn: fork.forkFn, logger: silentLogger },
      }),
    );
    assert.equal(fork.calls.length, 2);
  });
});

describe('installSignalHandlers', () => {
  it('waits for one shutdown before exiting successfully', async () => {
    const processRef = new EventEmitter();
    processRef.exit = mock.fn();
    const deferred = Promise.withResolvers();
    const supervisor = { shutdown: mock.fn(() => deferred.promise) };
    installSignalHandlers(supervisor, processRef);

    processRef.emit('SIGINT');
    processRef.emit('SIGTERM');

    assert.equal(supervisor.shutdown.mock.callCount(), 1);
    assert.equal(processRef.exit.mock.callCount(), 0);

    deferred.resolve();
    await deferred.promise;
    await Promise.resolve();

    assert.equal(processRef.exit.mock.callCount(), 1);
    assert.deepEqual(processRef.exit.mock.calls[0].arguments, [0]);
  });

  it('exits with failure when shutdown rejects', async () => {
    mock.method(console, 'error', () => {});
    const processRef = new EventEmitter();
    processRef.exit = mock.fn();
    const supervisor = { shutdown: mock.fn(() => Promise.reject(new Error('failed'))) };
    installSignalHandlers(supervisor, processRef);

    processRef.emit('SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(processRef.exit.mock.calls[0].arguments, [1]);
  });
});
