import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { ChildHandle } from '../../src/ai/agent-pool.js';
import { AgentPool } from '../../src/ai/agent-pool.js';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

// Fake forked child: an EventEmitter with send() recording outgoing messages.
function fakeChild() {
  const child = new EventEmitter();
  child.sent = [];
  child.send = (m) => child.sent.push(m);
  child.kill = () => child.emit('exit', 0);
  return child;
}

function makeHandle(overrides = {}) {
  const child = fakeChild();
  const ctx = {
    client: {},
    runtime: { onAgentCharge: () => {}, onAgentMessages: () => {} },
    ...overrides.ctx,
  };
  const getExecutor = overrides.getExecutor ?? (() => async () => 'exec-result');
  const handle = new ChildHandle({ agentKey: 'channel:c1', child, getExecutor, ctx, logger: null });
  return { handle, child, ctx };
}

describe('ChildHandle', () => {
  it('init resolves when the child reports ready', async () => {
    const { handle, child } = makeHandle();
    const ready = handle.init({ mode: 'natural' });
    assert.deepEqual(child.sent[0].t, 'init');
    child.emit('message', { t: 'ready' });
    await ready;
  });

  it('run sends a prompt and marks the handle running', async () => {
    const { handle, child } = makeHandle();
    handle.init({ mode: 'natural' });
    child.emit('message', { t: 'ready' });
    handle.run('hello');
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(child.sent.some((m) => m.t === 'prompt' && m.content === 'hello'));
    assert.equal(handle.running, true);
  });

  it('a done message resolves the current run and clears running', async () => {
    const { handle, child } = makeHandle();
    handle.init({ mode: 'natural' });
    child.emit('message', { t: 'ready' });
    const runP = handle.run('hi');
    await new Promise((r) => setTimeout(r, 5));
    child.emit('message', { t: 'done', id: 'r1', outcome: 'finished', usage: {} });
    const done = await runP;
    assert.equal(done.outcome, 'finished');
    assert.equal(handle.running, false);
  });

  it('a tool message runs the executor and replies with tool-result', async () => {
    const { handle, child } = makeHandle({ getExecutor: () => async (_ctx, input) => `got:${input.x}` });
    handle.init({ mode: 'natural' });
    child.emit('message', { t: 'ready' });
    child.emit('message', { t: 'tool', id: 't1', name: 'discord_send', input: { x: 9 } });
    await new Promise((r) => setTimeout(r, 5));
    const result = child.sent.find((m) => m.t === 'tool-result');
    assert.deepEqual(result, { t: 'tool-result', id: 't1', ok: true, result: 'got:9' });
  });

  it('an unknown tool replies ok:false', async () => {
    const { handle, child } = makeHandle({ getExecutor: () => null });
    handle.init({ mode: 'natural' });
    child.emit('message', { t: 'ready' });
    child.emit('message', { t: 'tool', id: 't1', name: 'nope', input: {} });
    await new Promise((r) => setTimeout(r, 5));
    const result = child.sent.find((m) => m.t === 'tool-result');
    assert.equal(result.ok, false);
  });

  it('a charge message forwards to the runtime', async () => {
    const charges = [];
    const { handle, child } = makeHandle({
      ctx: { runtime: { onAgentCharge: (k, kind) => charges.push({ k, kind }), onAgentMessages: () => {} } },
    });
    handle.init({ mode: 'natural' });
    child.emit('message', { t: 'ready' });
    child.emit('message', { t: 'charge', kind: 'run' });
    assert.deepEqual(charges, [{ k: 'channel:c1', kind: 'run' }]);
  });

  it('child exit rejects an in-flight run', async () => {
    const { handle, child } = makeHandle();
    handle.init({ mode: 'natural' });
    child.emit('message', { t: 'ready' });
    const runP = handle.run('hi');
    await new Promise((r) => setTimeout(r, 5));
    child.emit('exit', 1);
    await assert.rejects(runP, /exited/);
  });
});

// A fake fork: returns an EventEmitter child; tests drive it manually.
function fakeForkFactory(registry) {
  return () => {
    const child = fakeChild();
    registry.push(child);
    return child;
  };
}

function poolCtx() {
  return { client: {}, runtime: { onAgentCharge: () => {}, onAgentMessages: () => {} } };
}

async function tmpWorkspace() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'agentpool-'));
}

// Deterministic async waits — no fixed timeouts. flush() drains the
// microtask queue; waitFor() polls until a condition holds. Spawning a
// child does real fs.mkdir I/O, so a fixed setTimeout would race it.
const flush = () => new Promise((r) => setImmediate(r));

async function waitFor(predicate) {
  for (let i = 0; i < 1000 && !predicate(); i++) await flush();
  if (!predicate()) throw new Error('waitFor: condition never became true');
}

describe('AgentPool', () => {
  it('spawns a child on first run and routes the prompt', async () => {
    const children = [];
    const pool = new AgentPool({ ctx: poolCtx(), logger: null, forkFn: fakeForkFactory(children), maintainMs: 100000 });
    const ws = await tmpWorkspace();
    const runP = pool.run('channel:c1', 'hello', { mode: 'natural', workspaceDir: ws });
    await waitFor(() => children.length > 0);
    children[0].emit('message', { t: 'ready' });
    await waitFor(() => children[0].sent.some((m) => m.t === 'prompt'));
    assert.equal(children.length, 1);
    assert.ok(children[0].sent.some((m) => m.t === 'init'));
    assert.ok(children[0].sent.some((m) => m.t === 'prompt' && m.content === 'hello'));
    children[0].emit('message', { t: 'done', id: 'r1', outcome: 'finished', usage: {} });
    await runP;
    pool.shutdown();
  });

  it('reuses an existing child for the same agentKey', async () => {
    const children = [];
    const pool = new AgentPool({ ctx: poolCtx(), logger: null, forkFn: fakeForkFactory(children), maintainMs: 100000 });
    const ws = await tmpWorkspace();
    pool.run('channel:c1', 'a', { mode: 'natural', workspaceDir: ws });
    await waitFor(() => children.length > 0);
    children[0].emit('message', { t: 'ready' });
    await flush();
    children[0].emit('message', { t: 'done', id: 'r1', outcome: 'finished', usage: {} });
    await flush();
    pool.run('channel:c1', 'b', { mode: 'natural', workspaceDir: ws });
    await flush();
    assert.equal(children.length, 1); // no second fork
    pool.shutdown();
  });

  it('evicts the LRU idle child when at capacity', async () => {
    const children = [];
    const pool = new AgentPool({
      ctx: poolCtx(),
      logger: null,
      forkFn: fakeForkFactory(children),
      maxChildren: 1,
      maintainMs: 100000,
    });
    const ws = await tmpWorkspace();
    pool.run('channel:c1', 'a', { mode: 'natural', workspaceDir: ws });
    await waitFor(() => children.length > 0);
    children[0].emit('message', { t: 'ready' });
    await flush();
    children[0].emit('message', { t: 'done', id: 'r1', outcome: 'finished', usage: {} }); // c1 now idle
    await flush();
    pool.run('channel:c2', 'b', { mode: 'natural', workspaceDir: ws });
    await waitFor(() => children.length > 1);
    assert.ok(children[0].sent.some((m) => m.t === 'shutdown')); // c1 evicted
    assert.equal(children.length, 2); // c2 spawned
    pool.shutdown();
  });

  it('returns null when at capacity and all children are busy', async () => {
    const children = [];
    const pool = new AgentPool({
      ctx: poolCtx(),
      logger: null,
      forkFn: fakeForkFactory(children),
      maxChildren: 1,
      maintainMs: 100000,
    });
    const ws = await tmpWorkspace();
    pool.run('channel:c1', 'a', { mode: 'natural', workspaceDir: ws });
    await waitFor(() => children.length > 0);
    children[0].emit('message', { t: 'ready' });
    await flush(); // c1 running, not idle
    const result = await pool.run('channel:c2', 'b', { mode: 'natural', workspaceDir: ws });
    assert.equal(result, null);
    pool.shutdown();
  });

  it('applies a respawn cooldown after a non-zero exit', async () => {
    const children = [];
    const pool = new AgentPool({
      ctx: poolCtx(),
      logger: null,
      forkFn: fakeForkFactory(children),
      respawnCooldownMs: 100000,
      maintainMs: 100000,
    });
    const ws = await tmpWorkspace();
    pool.run('channel:c1', 'a', { mode: 'natural', workspaceDir: ws });
    await waitFor(() => children.length > 0);
    children[0].emit('exit', 1);
    await flush();
    assert.equal(pool.inCooldown('channel:c1'), true);
    const result = await pool.run('channel:c1', 'b', { mode: 'natural', workspaceDir: ws });
    assert.equal(result, null); // refused while in cooldown
    pool.shutdown();
  });

  it('does not double-fork on concurrent runs for the same new key', async () => {
    const children = [];
    const pool = new AgentPool({ ctx: poolCtx(), logger: null, forkFn: fakeForkFactory(children), maintainMs: 100000 });
    const ws = await tmpWorkspace();
    const r1 = pool.run('channel:c1', 'a', { mode: 'natural', workspaceDir: ws });
    const r2 = pool.run('channel:c1', 'b', { mode: 'natural', workspaceDir: ws });
    await waitFor(() => children.length > 0);
    children[0].emit('message', { t: 'ready' });
    await flush();
    children[0].emit('message', { t: 'done', id: 'r1', outcome: 'finished', usage: {} });
    await Promise.all([r1, r2]);
    assert.equal(children.length, 1); // one shared fork, not two
    pool.shutdown();
  });

  it('the maintainer evicts a child idle past idleMs', async () => {
    mock.timers.enable({ apis: ['Date', 'setInterval'] });
    const children = [];
    const pool = new AgentPool({
      ctx: poolCtx(),
      logger: null,
      forkFn: fakeForkFactory(children),
      idleMs: 1000,
      maintainMs: 500,
    });
    const ws = await tmpWorkspace();
    pool.run('channel:c1', 'a', { mode: 'natural', workspaceDir: ws });
    await waitFor(() => children.length > 0);
    children[0].emit('message', { t: 'ready' });
    children[0].emit('message', { t: 'done', id: 'r1', outcome: 'finished', usage: {} });
    mock.timers.tick(2000);
    assert.ok(children[0].sent.some((m) => m.t === 'shutdown'));
    pool.shutdown();
  });
});
