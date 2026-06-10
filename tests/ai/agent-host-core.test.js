import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { createHost, resolveStoragePaths } from '../../src/ai/agent-host-core.js';

afterEach(() => mock.restoreAll());

function stubAgent({ messages = [], runImpl } = {}) {
  const agent = {
    messages,
    usage: { cost: 0, tokens: 0 },
    isRunning: false,
    tools: { register: () => {} },
    cleanup: async () => {},
    run: async (content, _notify, _opts) => {
      agent.isRunning = true;
      agent.messages.push({ role: 'user', content });
      if (runImpl) await runImpl(agent);
      agent.isRunning = false;
      return '';
    },
  };
  return agent;
}

describe('agent host core', () => {
  it('runs a prompt and emits charge + done with outcome finished', async () => {
    const sent = [];
    const agent = stubAgent({
      runImpl: (a) => a.messages.push({ role: 'assistant', content: 'final answer' }),
    });
    const host = createHost({
      agent,
      send: (m) => sent.push(m),
      mode: 'natural',
      compactThreshold: 1000,
      keepTail: 10,
      summarizer: async () => 's',
    });
    host.handle({ t: 'prompt', id: 'r1', content: 'hello' });
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(sent.some((m) => m.t === 'charge' && m.kind === 'run'));
    const done = sent.find((m) => m.t === 'done');
    assert.equal(done.id, 'r1');
    assert.equal(done.outcome, 'finished');
    assert.equal(done.messages, undefined); // natural mode omits messages
  });

  it('command mode done includes messages', async () => {
    const sent = [];
    const agent = stubAgent({ runImpl: (a) => a.messages.push({ role: 'assistant', content: 'ok' }) });
    const host = createHost({
      agent,
      send: (m) => sent.push(m),
      mode: 'command',
      compactThreshold: 1000,
      keepTail: 10,
      summarizer: async () => 's',
    });
    host.handle({ t: 'prompt', id: 'r1', content: 'hi' });
    await new Promise((r) => setTimeout(r, 10));
    const done = sent.find((m) => m.t === 'done');
    assert.ok(Array.isArray(done.messages));
  });

  it('reports outcome truncated when the last message is not assistant text', async () => {
    const sent = [];
    const agent = stubAgent({ runImpl: (a) => a.messages.push({ role: 'tool', content: 'tool result' }) });
    const host = createHost({
      agent,
      send: (m) => sent.push(m),
      mode: 'natural',
      compactThreshold: 1000,
      keepTail: 10,
      summarizer: async () => 's',
    });
    host.handle({ t: 'prompt', id: 'r1', content: 'hi' });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(sent.find((m) => m.t === 'done').outcome, 'truncated');
  });

  it('a re-entrant prompt does not emit a second done', async () => {
    const sent = [];
    let resolveRun;
    const sharedPromise = new Promise((res) => {
      resolveRun = res;
    });
    const agent = stubAgent({ runImpl: () => sharedPromise });
    const host = createHost({
      agent,
      send: (m) => sent.push(m),
      mode: 'natural',
      compactThreshold: 1000,
      keepTail: 10,
      summarizer: async () => 's',
    });
    host.handle({ t: 'prompt', id: 'r1', content: 'a' });
    await new Promise((r) => setTimeout(r, 5));
    host.handle({ t: 'prompt', id: 'r2', content: 'b' }); // re-entrant while running
    resolveRun();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(sent.filter((m) => m.t === 'done').length, 1);
  });

  it('a proxy tool RPC resolves when a tool-result arrives', async () => {
    const sent = [];
    const agent = stubAgent();
    const host = createHost({
      agent,
      send: (m) => sent.push(m),
      mode: 'natural',
      compactThreshold: 1000,
      keepTail: 10,
      summarizer: async () => 's',
    });
    const promise = host.rpc('discord_send', { channel_id: 'c1', content: 'x' });
    // action tools are serialised through a promise queue — drain one microtask first
    await Promise.resolve();
    const toolMsg = sent.find((m) => m.t === 'tool');
    assert.equal(toolMsg.name, 'discord_send');
    host.handle({ t: 'tool-result', id: toolMsg.id, ok: true, result: 'sent-ok' });
    assert.equal(await promise, 'sent-ok');
  });

  it('shutdown aborts, cleans up, and calls onClose', async () => {
    let cleaned = false;
    let closed = false;
    const agent = stubAgent();
    agent.cleanup = async () => {
      cleaned = true;
    };
    const host = createHost({
      agent,
      send: () => {},
      mode: 'natural',
      compactThreshold: 1000,
      keepTail: 10,
      summarizer: async () => 's',
      onClose: () => {
        closed = true;
      },
    });
    await host.handle({ t: 'shutdown' });
    assert.equal(cleaned, true);
    assert.equal(closed, true);
  });

  it('includes text and actionToolCalled in done payload', async () => {
    const sent = [];
    const agent = stubAgent({
      runImpl: (a) => a.messages.push({ role: 'assistant', content: 'hello from assistant' }),
    });
    const host = createHost({
      agent,
      send: (m) => sent.push(m),
      mode: 'natural',
      compactThreshold: 1000,
      keepTail: 10,
      summarizer: async () => 's',
    });
    host.handle({ t: 'prompt', id: 'r1', content: 'hello' });
    await new Promise((r) => setTimeout(r, 10));
    const done = sent.find((m) => m.t === 'done');
    assert.equal(done.outcome, 'finished');
    assert.equal(done.text, 'hello from assistant');
    assert.equal(done.actionToolCalled, false);
  });

  it('sets actionToolCalled to true when discord tool is called', async () => {
    const sent = [];
    const agent = stubAgent({
      runImpl: async (a) => {
        await host.rpc('discord_send', { channel_id: 'c1', content: 'msg' });
        a.messages.push({ role: 'assistant', content: 'closing thought' });
      },
    });
    const host = createHost({
      agent,
      send: (m) => {
        sent.push(m);
        if (m.t === 'tool' && m.name === 'discord_send') {
          setTimeout(() => {
            host.handle({ t: 'tool-result', id: m.id, ok: true, result: 'ok' });
          }, 1);
        }
      },
      mode: 'natural',
      compactThreshold: 1000,
      keepTail: 10,
      summarizer: async () => 's',
    });

    host.handle({ t: 'prompt', id: 'r1', content: 'hello' });
    await new Promise((r) => setTimeout(r, 20));
    const done = sent.find((m) => m.t === 'done');
    assert.equal(done.outcome, 'finished');
    assert.equal(done.actionToolCalled, true);
  });
});

describe('resolveStoragePaths', () => {
  it('uses the configured memoryDir when provided', () => {
    const sp = resolveStoragePaths({ memoryDir: '/data/memory/guild-g1' }, '/work/channel-c1');
    assert.deepEqual(sp, {
      tmpDir: path.join('/work/channel-c1', '.agent', 'tmp'),
      memoryDir: '/data/memory/guild-g1',
    });
  });

  it('falls back to the workspace-local memory dir', () => {
    const sp = resolveStoragePaths({}, '/work/channel-c1');
    assert.equal(sp.memoryDir, path.join('/work/channel-c1', '.agent', 'memory'));
    assert.equal(sp.tmpDir, path.join('/work/channel-c1', '.agent', 'tmp'));
  });
});
