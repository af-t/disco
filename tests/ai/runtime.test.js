import test, { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ChannelAIRuntime } from '../../src/ai/runtime.js';

function fakeFetcherWith(content) {
  const u8 = new TextEncoder().encode(content);
  return async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength),
  });
}

function makeStubs() {
  const store = new Map();
  const stubStore = {
    async get(k) {
      return store.get(k);
    },
    async set(k, v, _opts) {
      store.set(k, v);
    },
    async has(k) {
      return store.has(k);
    },
  };
  const calls = { send: [], reply: [], run: 0 };
  const stubClient = {
    _session: { user: { id: 'BOT', username: 'TestBot' } },
    store: stubStore,
    sendMessage: async (channel_id, content) => {
      calls.send.push({ channel_id, content });
      return { id: 'sent1', channel_id, content };
    },
    reply: async (m, content) => {
      calls.reply.push({ m, content });
      return { id: 'sent2', channel_id: m.channel_id, content };
    },
    getChannel: async (id) => ({ id, name: `chan-${id}`, guild_id: 'g1' }),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };
  const stubAgent = {
    messages: [],
    tools: { register: () => {} },
    run: async () => {
      calls.run++;
      return '';
    },
  };
  return { stubStore, stubClient, stubAgent, calls };
}

test('onMessage ignores bot/self messages', async () => {
  const { stubClient, stubAgent, calls } = makeStubs();
  const rt = new ChannelAIRuntime({
    client: stubClient,
    agent: stubAgent,
    config: { debounceMs: 10, forceDebounceMs: 5 },
  });
  await rt.onMessage({ id: 'm1', channel_id: 'c1', guild_id: 'g1', author: { id: 'BOT' }, content: 'hi' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.run, 0);
});

test('onMessage on a normal message debounces and flushes once', async () => {
  const { stubClient, stubAgent, calls } = makeStubs();
  const rt = new ChannelAIRuntime({
    client: stubClient,
    agent: stubAgent,
    config: { debounceMs: 20, forceDebounceMs: 5, dailyLimit: 1000 },
  });
  await rt.onMessage({ id: 'm1', channel_id: 'c1', guild_id: 'g1', author: { id: 'u1' }, content: 'hello' });
  await rt.onMessage({ id: 'm2', channel_id: 'c1', guild_id: 'g1', author: { id: 'u1' }, content: 'world' });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.run, 1, 'debounce should batch the two messages into one run');
});

test('two channels flushing concurrently do not corrupt each other agent.messages', async () => {
  const { stubClient, stubAgent, calls } = makeStubs();
  // Custom agent.run that simulates async work + records the messages snapshot it saw
  const seenSnapshots = [];
  stubAgent.run = async function (_prompt) {
    seenSnapshots.push([...this.messages]);
    await new Promise((r) => setTimeout(r, 20));
    this.messages = [...this.messages, { role: 'assistant', content: `after-run-${calls.run}` }];
    calls.run++;
    return '';
  }.bind(stubAgent);

  const rt = new ChannelAIRuntime({
    client: stubClient,
    agent: stubAgent,
    config: { debounceMs: 5, forceDebounceMs: 5, dailyLimit: 1000 },
  });

  // Seed each channel with a different starting state so corruption is visible
  rt._state('cA').agentMessages = [{ role: 'user', content: 'A-only' }];
  rt._state('cB').agentMessages = [{ role: 'user', content: 'B-only' }];

  await Promise.all([
    rt.onMessage({ id: 'm1', channel_id: 'cA', guild_id: 'g1', author: { id: 'uA' }, content: 'hi from A' }),
    rt.onMessage({ id: 'm2', channel_id: 'cB', guild_id: 'g1', author: { id: 'uB' }, content: 'hi from B' }),
  ]);
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(calls.run, 2, 'both channels should have flushed');
  // Each channel's stored agentMessages must include the channel-specific seed and the run-appended turn,
  // not the other channel's seed.
  const aMsgs = rt._state('cA').agentMessages.map((m) => m.content);
  const bMsgs = rt._state('cB').agentMessages.map((m) => m.content);
  assert.ok(aMsgs.includes('A-only'), 'channel A should still have its seed');
  assert.ok(!aMsgs.includes('B-only'), 'channel A must NOT have channel B seed');
  assert.ok(bMsgs.includes('B-only'), 'channel B should still have its seed');
  assert.ok(!bMsgs.includes('A-only'), 'channel B must NOT have channel A seed');
});

test('mention bypasses cooldown', async () => {
  const { stubClient, stubAgent, calls } = makeStubs();
  const rt = new ChannelAIRuntime({
    client: stubClient,
    agent: stubAgent,
    config: { debounceMs: 100, forceDebounceMs: 5 },
  });
  rt._state('c1').cooldownUntil = Date.now() + 60_000;
  await rt.onMessage({ id: 'm1', channel_id: 'c1', guild_id: 'g1', author: { id: 'u1' }, content: 'hey <@BOT>' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.run, 1);
});

test('non-mention drops when in cooldown', async () => {
  const { stubClient, stubAgent, calls } = makeStubs();
  const rt = new ChannelAIRuntime({
    client: stubClient,
    agent: stubAgent,
    config: { debounceMs: 30, forceDebounceMs: 5 },
  });
  rt._state('c1').cooldownUntil = Date.now() + 60_000;
  await rt.onMessage({ id: 'm1', channel_id: 'c1', guild_id: 'g1', author: { id: 'u1' }, content: 'small talk' });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.run, 0);
});

test('invoke command mode bypasses prefilter and forces respond', async () => {
  const { stubClient, stubAgent, calls } = makeStubs();
  const rt = new ChannelAIRuntime({
    client: stubClient,
    agent: stubAgent,
    config: { debounceMs: 30, forceDebounceMs: 5 },
  });
  await rt.invoke({
    mode: 'command',
    contextKey: 'cmd:g1:u1',
    forceRespond: true,
    msg: { id: 'm1', channel_id: 'c1', guild_id: 'g1', author: { id: 'u1', username: 'user' } },
    explicitPrompt: 'hi there',
  });
  assert.equal(calls.run, 1);
});

test('invoke command mode swaps in command system prompt', async () => {
  const { stubClient, stubAgent, calls } = makeStubs();
  const seenSystemPrompts = [];
  stubAgent.run = async function () {
    seenSystemPrompts.push(this.systemPrompt);
    calls.run++;
    return '';
  }.bind(stubAgent);

  const rt = new ChannelAIRuntime({
    client: stubClient,
    agent: stubAgent,
    config: { debounceMs: 30, forceDebounceMs: 5 },
  });

  await rt.invoke({
    mode: 'command',
    contextKey: 'cmd:g1:u1',
    forceRespond: true,
    msg: { id: 'm1', channel_id: 'c1', guild_id: 'g1', author: { id: 'u1', username: 'tester' } },
    explicitPrompt: 'hello',
  });

  assert.equal(calls.run, 1);
  assert.match(seenSystemPrompts[0], /Skipping is not an option/);
});

test('invoke command mode prompt carries channel_id and message_id', async () => {
  const { stubClient, stubAgent, calls } = makeStubs();
  const seenPrompts = [];
  stubAgent.run = async function (prompt) {
    seenPrompts.push(prompt);
    calls.run++;
    return '';
  }.bind(stubAgent);

  const rt = new ChannelAIRuntime({
    client: stubClient,
    agent: stubAgent,
    config: { debounceMs: 30, forceDebounceMs: 5 },
  });

  await rt.invoke({
    mode: 'command',
    contextKey: 'cmd:g1:u1',
    forceRespond: true,
    msg: { id: 'msg-42', channel_id: 'chan-7', guild_id: 'g1', author: { id: 'u1', username: 'tester' } },
    explicitPrompt: 'hello',
  });

  assert.equal(calls.run, 1);
  assert.match(seenPrompts[0], /channel_id=chan-7/);
  assert.match(seenPrompts[0], /message_id=msg-42/);
  assert.match(seenPrompts[0], /discord_reply with channel_id="chan-7" and message_id="msg-42"/);
});

test('invoke command mode includes image_url blocks when msg has image attachments', async () => {
  const { stubClient, stubAgent, calls } = makeStubs();
  const seenInputs = [];
  stubAgent.run = async function (input) {
    seenInputs.push(input);
    calls.run++;
    return '';
  }.bind(stubAgent);

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-mixed-'));
  const rt = new ChannelAIRuntime({
    client: stubClient,
    agent: stubAgent,
    config: { debounceMs: 30, forceDebounceMs: 5 },
    fetcher: fakeFetcherWith('PDF'),
    workspaceRoot: tmpRoot,
  });

  await rt.invoke({
    mode: 'command',
    contextKey: 'cmd:g1:u1',
    forceRespond: true,
    msg: {
      id: 'm1',
      channel_id: 'c1',
      guild_id: 'g1',
      author: { id: 'u1', username: 'tester' },
      attachments: [
        { filename: 'pic.png', content_type: 'image/png', url: 'http://x/pic.png' },
        { filename: 'doc.pdf', content_type: 'application/pdf', url: 'http://x/doc.pdf' },
      ],
    },
    explicitPrompt: 'look at this',
  });

  try {
    assert.ok(Array.isArray(seenInputs[0]), 'input should be multimodal array when images present');
    assert.equal(seenInputs[0][0].type, 'text');
    const imgBlocks = seenInputs[0].filter((b) => b.type === 'image_url');
    assert.equal(imgBlocks.length, 1, 'only the image attachment should become an image_url block');
    assert.equal(imgBlocks[0].image_url.url, 'http://x/pic.png');
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('onMessage with image attachment in NEW msg drives multimodal agent input', async () => {
  const { stubClient, stubAgent, calls } = makeStubs();
  const seenInputs = [];
  stubAgent.run = async function (input) {
    seenInputs.push(input);
    calls.run++;
    return '';
  }.bind(stubAgent);

  const rt = new ChannelAIRuntime({
    client: stubClient,
    agent: stubAgent,
    config: { debounceMs: 20, forceDebounceMs: 5 },
  });

  await rt.onMessage({
    id: 'm1',
    channel_id: 'c1',
    guild_id: 'g1',
    author: { id: 'u1', username: 'alice' },
    content: 'check this <@BOT>',
    attachments: [{ filename: 'foo.jpg', content_type: 'image/jpeg', url: 'http://x/foo.jpg' }],
  });
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(calls.run, 1);
  assert.ok(Array.isArray(seenInputs[0]));
  const imgBlocks = seenInputs[0].filter((b) => b.type === 'image_url');
  assert.equal(imgBlocks.length, 1);
  assert.equal(imgBlocks[0].image_url.url, 'http://x/foo.jpg');
});

test('onMessage saves non-image attachments to channel workspace and tags snapshot with saved_path', async () => {
  const { stubClient, stubAgent } = makeStubs();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-channel-'));
  try {
    const rt = new ChannelAIRuntime({
      client: stubClient,
      agent: stubAgent,
      config: { debounceMs: 10_000, forceDebounceMs: 5_000, bufferSize: 30 },
      fetcher: fakeFetcherWith('PDF-CONTENT'),
      workspaceRoot: tmpRoot,
    });

    await rt.onMessage({
      id: 'm99',
      channel_id: 'c9',
      guild_id: 'g1',
      author: { id: 'u9', username: 'doe' },
      content: 'see attached',
      attachments: [
        { filename: 'report.pdf', content_type: 'application/pdf', url: 'http://x/report.pdf' },
        { filename: 'pic.png', content_type: 'image/png', url: 'http://x/pic.png' },
      ],
    });

    const snap = rt._state('c9').rollingBuffer.find((s) => s.id === 'm99');
    assert.ok(snap, 'snapshot exists for the message');
    const pdfMeta = snap.attachments_meta.find((a) => a.filename === 'report.pdf');
    const pngMeta = snap.attachments_meta.find((a) => a.filename === 'pic.png');
    assert.ok(pdfMeta.saved_path, 'non-image gets a saved_path');
    assert.equal(pngMeta.saved_path, undefined, 'image does not get a saved_path');

    const written = await fs.readFile(pdfMeta.saved_path, 'utf8');
    assert.equal(written, 'PDF-CONTENT');
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('invoke command mode saves non-image attachments and references them in the prompt', async () => {
  const { stubClient, stubAgent, calls } = makeStubs();
  const seenInputs = [];
  stubAgent.run = async function (input) {
    seenInputs.push(input);
    calls.run++;
    return '';
  }.bind(stubAgent);

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-cmd-'));
  try {
    const rt = new ChannelAIRuntime({
      client: stubClient,
      agent: stubAgent,
      config: { debounceMs: 30, forceDebounceMs: 5 },
      fetcher: fakeFetcherWith('TXT-CONTENT'),
      workspaceRoot: tmpRoot,
    });

    await rt.invoke({
      mode: 'command',
      contextKey: 'cmd:g1:u1',
      forceRespond: true,
      msg: {
        id: 'mC',
        channel_id: 'cX',
        guild_id: 'gZ',
        author: { id: 'uY', username: 'tester' },
        attachments: [{ filename: 'notes.txt', content_type: 'text/plain', url: 'http://x/notes.txt' }],
      },
      explicitPrompt: 'summarize',
    });

    const prompt = typeof seenInputs[0] === 'string' ? seenInputs[0] : seenInputs[0][0].text;
    assert.match(prompt, /\[Workspace files/);
    assert.match(prompt, /notes\.txt/);
    const m = prompt.match(/-> (.+notes\.txt[^\s\]]*)/);
    assert.ok(m, 'prompt contains a saved path arrow');
    const saved = await fs.readFile(m[1], 'utf8');
    assert.equal(saved, 'TXT-CONTENT');
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('store onDelete on channel:buffer key removes the channel workspace', async () => {
  const { stubClient, stubAgent } = makeStubs();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-clean-chan-'));
  try {
    const rt = new ChannelAIRuntime({
      client: stubClient,
      agent: stubAgent,
      config: { debounceMs: 10_000, forceDebounceMs: 5_000 },
      fetcher: fakeFetcherWith('PDF'),
      workspaceRoot: tmpRoot,
    });

    await rt.onMessage({
      id: 'm1',
      channel_id: 'cClean',
      guild_id: 'g1',
      author: { id: 'u1', username: 'a' },
      content: 'x',
      attachments: [{ filename: 'doc.pdf', content_type: 'application/pdf', url: 'http://x/doc.pdf' }],
    });

    const dir = path.join(tmpRoot, 'channel-cClean');
    const filesBefore = await fs.readdir(dir);
    assert.equal(filesBefore.length, 1);

    await stubClient.store.onDelete('channel:buffer:cClean', null);

    let existed = true;
    try {
      await fs.access(dir);
    } catch {
      existed = false;
    }
    assert.equal(existed, false, 'channel workspace should be removed after buffer key delete');
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('store onDelete on session:openrouter key removes the command workspace', async () => {
  const { stubClient, stubAgent, calls } = makeStubs();
  stubAgent.run = async function () {
    calls.run++;
    return '';
  }.bind(stubAgent);

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-clean-cmd-'));
  try {
    const rt = new ChannelAIRuntime({
      client: stubClient,
      agent: stubAgent,
      config: { debounceMs: 30, forceDebounceMs: 5 },
      fetcher: fakeFetcherWith('TXT'),
      workspaceRoot: tmpRoot,
    });

    await rt.invoke({
      mode: 'command',
      contextKey: 'cmd:gC:uC',
      forceRespond: true,
      msg: {
        id: 'mC',
        channel_id: 'cC',
        guild_id: 'gC',
        author: { id: 'uC', username: 'tester' },
        attachments: [{ filename: 'notes.txt', content_type: 'text/plain', url: 'http://x/notes.txt' }],
      },
      explicitPrompt: 'hi',
    });

    const dir = path.join(tmpRoot, 'command-gC-uC');
    const before = await fs.readdir(dir);
    assert.equal(before.length, 1);

    await stubClient.store.onDelete('session:openrouter:gC:uC', null);

    let existed = true;
    try {
      await fs.access(dir);
    } catch {
      existed = false;
    }
    assert.equal(existed, false, 'command workspace should be removed after session key delete');
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('cleanup hook chains with prior onDelete', async () => {
  const { stubClient, stubAgent } = makeStubs();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-clean-chain-'));
  const priorCalls = [];
  stubClient.store.onDelete = async (k, v) => {
    priorCalls.push([k, v]);
  };
  try {
    new ChannelAIRuntime({
      client: stubClient,
      agent: stubAgent,
      config: { debounceMs: 10_000, forceDebounceMs: 5_000 },
      fetcher: fakeFetcherWith('X'),
      workspaceRoot: tmpRoot,
    });

    await stubClient.store.onDelete('unrelated:key', { foo: 1 });
    assert.equal(priorCalls.length, 1, 'prior hook should still fire');
    assert.equal(priorCalls[0][0], 'unrelated:key');
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('invoke command mode persists and restores session via session:openrouter store key', async () => {
  const { stubStore, stubClient, stubAgent, calls } = makeStubs();
  stubAgent.run = async function () {
    this.messages = [...this.messages, { role: 'assistant', content: 'reply-1' }];
    calls.run++;
    return '';
  }.bind(stubAgent);

  const rt = new ChannelAIRuntime({
    client: stubClient,
    agent: stubAgent,
    config: { debounceMs: 30, forceDebounceMs: 5 },
  });

  const msg = { id: 'm1', channel_id: 'c1', guild_id: 'g1', author: { id: 'u1', username: 'tester' } };
  await rt.invoke({ mode: 'command', contextKey: 'cmd:g1:u1', forceRespond: true, msg, explicitPrompt: 'hi' });

  const persisted = await stubStore.get('session:openrouter:g1:u1');
  assert.ok(Array.isArray(persisted), 'session should be persisted as an array');
  assert.ok(
    persisted.some((m) => m.content === 'reply-1'),
    'persisted session should contain the assistant turn',
  );

  // simulate restart: drop in-memory state, runtime restarts
  rt.channels.clear();

  await rt.invoke({ mode: 'command', contextKey: 'cmd:g1:u1', forceRespond: true, msg, explicitPrompt: 'follow up' });
  const after = rt._state('cmd:g1:u1').agentMessages;
  assert.ok(
    after.some((m) => m.content === 'reply-1'),
    'agentMessages should rehydrate from store on second invoke',
  );
});

// ── onBotMessage ──────────────────────────────────────────────────────────────
describe('ChannelAIRuntime onBotMessage', () => {
  it('returns early when no channel_id', () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    rt.onBotMessage({}); // no channel_id — should not throw
    assert.strictEqual(rt.channels.size, 0);
  });

  it('adds snap to rollingBuffer and sets cooldown', () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    rt.onBotMessage({ channel_id: 'c1', id: 'm1', content: 'hi', attachments: [] });
    const s = rt.channels.get('c1');
    assert.strictEqual(s.rollingBuffer.length, 1);
    assert.ok(s.cooldownUntil > Date.now());
    assert.ok(s.lastBotMsgAt > 0);
  });

  it('trims buffer when it exceeds bufferSize', () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent, config: { bufferSize: 2 } });
    for (let i = 0; i < 3; i++) {
      rt.onBotMessage({ channel_id: 'c1', id: `m${i}`, content: `msg${i}`, attachments: [] });
    }
    assert.strictEqual(rt.channels.get('c1').rollingBuffer.length, 2);
  });
});

// ── onMessage ─────────────────────────────────────────────────────────────────
describe('ChannelAIRuntime onMessage', () => {
  afterEach(() => mock.restoreAll());

  it('skips bot messages', async () => {
    const { stubClient, stubAgent, calls } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    await rt.onMessage({ author: { id: 'other', bot: true }, channel_id: 'c1', attachments: [] });
    assert.strictEqual(calls.run, 0);
  });

  it('skips self messages', async () => {
    const { stubClient, stubAgent, calls } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    await rt.onMessage({ author: { id: stubClient._session.user.id }, channel_id: 'c1', attachments: [] });
    assert.strictEqual(calls.run, 0);
  });

  it('adds message to pendingMsgs and rollingBuffer', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    mock.method(rt, '_scheduleFlush', () => {}); // suppress actual flush
    await rt.onMessage({
      author: { id: 'u1', bot: false },
      channel_id: 'c1',
      content: 'x',
      attachments: [],
      guild_id: 'g1',
    });
    const s = rt.channels.get('c1');
    assert.strictEqual(s.rollingBuffer.length, 1);
    assert.strictEqual(s.pendingMsgs.length, 1);
  });
});

// ── _flush ─────────────────────────────────────────────────────────────────────
describe('ChannelAIRuntime _flush', () => {
  afterEach(() => mock.restoreAll());

  it('sets rerunAfter when llmActive=true', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    const s = rt._state('c1');
    s.llmActive = true;
    await rt._flush('c1');
    assert.strictEqual(s.rerunAfter, true);
  });

  it('clears pendingMsgs when budget exhausted (non-force)', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    mock.method(rt.budget, 'exhausted', async () => true);
    const s = rt._state('c1');
    s.pendingMsgs.push({ guild_id: 'g1', channel_id: 'c1', flag: 'new', content: 'x', attachments_meta: [] });
    await rt._flush('c1');
    assert.strictEqual(s.pendingMsgs.length, 0);
    assert.strictEqual(s.llmActive, false);
  });

  it('runs agent and increments budget on success', async () => {
    const { stubClient, stubAgent, calls } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    mock.method(rt.budget, 'exhausted', async () => false);
    const incrementSpy = mock.method(rt.budget, 'increment', async () => {});

    const snap = {
      guild_id: 'g1',
      channel_id: 'c1',
      flag: 'new',
      content: 'hi',
      attachments_meta: [],
      id: 'm1',
      author_id: 'u1',
      author_name: 'user',
      reply_to: null,
      timestamp: Date.now(),
    };
    const s = rt._state('c1');
    s.pendingMsgs.push(snap);
    s.rollingBuffer.push(snap);

    await rt._flush('c1');
    assert.ok(calls.run >= 1);
    assert.strictEqual(incrementSpy.mock.callCount(), 1);
    assert.strictEqual(s.llmActive, false);
  });

  it('schedules rerun when rerunAfter is set in finally', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    mock.method(rt.budget, 'exhausted', async () => false);
    mock.method(rt, '_runAgent', async () => []);

    const flushSpy = mock.method(rt, '_scheduleFlush', () => {});
    const snap = {
      flag: 'new',
      content: 'x',
      attachments_meta: [],
      guild_id: 'g1',
      channel_id: 'c1',
      id: 'm2',
      author_id: 'u1',
      author_name: 'user',
      reply_to: null,
      timestamp: Date.now(),
    };
    const s = rt._state('c1');
    s.rerunAfter = true;
    s.pendingMsgs.push(snap);
    s.rollingBuffer.push(snap);

    await rt._flush('c1');
    assert.strictEqual(flushSpy.mock.callCount(), 1);
  });

  it('logs error and resets llmActive when agent throws', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    mock.method(rt.budget, 'exhausted', async () => false);
    stubAgent.run = async () => {
      throw new Error('agent failed');
    };

    const errors = [];
    stubClient.logger.error = (...a) => {
      errors.push(a);
    };

    const snap = {
      flag: 'new',
      content: 'x',
      attachments_meta: [],
      guild_id: 'g1',
      channel_id: 'c1',
      id: 'm3',
      author_id: 'u1',
      author_name: 'user',
      reply_to: null,
      timestamp: Date.now(),
    };
    const s = rt._state('c1');
    s.pendingMsgs.push(snap);
    s.rollingBuffer.push(snap);

    await rt._flush('c1');
    assert.ok(errors.length > 0);
    assert.strictEqual(s.llmActive, false);
  });
});

// ── invoke ─────────────────────────────────────────────────────────────────────
describe('ChannelAIRuntime invoke', () => {
  afterEach(() => mock.restoreAll());

  it('queues when llmActive=true', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    const s = rt._state('c1');
    s.llmActive = true;
    await rt.invoke({
      mode: 'command',
      msg: { channel_id: 'c1', id: 'm1', author: { id: 'u1' }, content: 'hi', attachments: [] },
    });
    assert.strictEqual(s.rerunAfter, true);
    assert.strictEqual(s.pendingForceRespond, true);
  });

  it('restores persisted session from store', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const persistedMessages = [{ role: 'user', content: 'from store' }];
    await stubClient.store.set('session:openrouter:g1:u1', persistedMessages);
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    mock.method(rt, '_runAgent', async (msgs) => msgs);
    mock.method(rt.budget, 'increment', async () => {});

    await rt.invoke({
      mode: 'command',
      msg: { channel_id: 'c1', id: 'm1', guild_id: 'g1', author: { id: 'u1' }, content: 'hi', attachments: [] },
    });
    const s = rt._state('c1');
    assert.deepStrictEqual(s.agentMessages, persistedMessages);
  });

  it('skips budget increment when no guild_id', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    const incSpy = mock.method(rt.budget, 'increment', async () => {});
    mock.method(rt, '_runAgent', async () => []);

    await rt.invoke({
      mode: 'command',
      msg: { channel_id: 'c1', id: 'm1', guild_id: null, author: { id: 'u1' }, content: 'hi', attachments: [] },
    });
    assert.strictEqual(incSpy.mock.callCount(), 0);
  });

  it('resets llmActive on agent error', async () => {
    const { stubClient, stubAgent } = makeStubs();
    stubAgent.run = async () => {
      throw new Error('boom');
    };
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });

    await rt.invoke({
      mode: 'command',
      msg: { channel_id: 'c1', id: 'm1', guild_id: 'g1', author: { id: 'u1' }, content: 'hi', attachments: [] },
    });
    assert.strictEqual(rt._state('c1').llmActive, false);
  });

  it('throws for unknown mode', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    await assert.rejects(
      () =>
        rt.invoke({ mode: 'unknown', msg: { channel_id: 'c1', id: 'm1', author: {}, content: '', attachments: [] } }),
      /Unknown invoke mode/,
    );
  });
});

// ── _handleStoreDelete ─────────────────────────────────────────────────────────
describe('ChannelAIRuntime _handleStoreDelete', () => {
  afterEach(() => mock.restoreAll());

  it('returns early for non-string key', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    await rt._handleStoreDelete(42); // no throw
  });

  it('calls fs.rm for channel:buffer: key', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent, workspaceRoot: '/tmp/ws' });
    const rmCalls = [];
    mock.method(fs, 'rm', async (dir) => {
      rmCalls.push(dir);
    });
    await rt._handleStoreDelete('channel:buffer:ch123');
    assert.ok(rmCalls.some((d) => d.includes('channel-ch123')));
  });

  it('returns early for channel:buffer: with empty id', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    await rt._handleStoreDelete('channel:buffer:'); // empty channelId
  });

  it('calls fs.rm for session:openrouter: key', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent, workspaceRoot: '/tmp/ws' });
    const rmCalls = [];
    mock.method(fs, 'rm', async (dir) => {
      rmCalls.push(dir);
    });
    await rt._handleStoreDelete('session:openrouter:g1:u1');
    assert.ok(rmCalls.some((d) => d.includes('command-g1-u1')));
  });

  it('returns early for session:openrouter: with no guild/user separator', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    await rt._handleStoreDelete('session:openrouter:nocolon');
  });
});

// ── _installCleanupHook ────────────────────────────────────────────────────────
describe('ChannelAIRuntime _installCleanupHook', () => {
  afterEach(() => mock.restoreAll());

  it('no-op when client has no store', () => {
    const { stubClient, stubAgent } = makeStubs();
    stubClient.store = null;
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    // re-invoking the hook with no store must early-return without throwing
    assert.strictEqual(rt._installCleanupHook(), undefined);
  });

  it('calls prior onDelete hook before workspace cleanup', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const priorCalls = [];
    stubClient.store.onDelete = async (k) => {
      priorCalls.push(k);
    };
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    mock.method(rt, '_handleStoreDelete', async () => {});

    await stubClient.store.onDelete('channel:buffer:c1', {});
    assert.ok(priorCalls.includes('channel:buffer:c1'));
  });

  it('still runs workspace cleanup when prior hook throws', async () => {
    const { stubClient, stubAgent } = makeStubs();
    stubClient.store.onDelete = async () => {
      throw new Error('prior failed');
    };
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    const cleanupCalls = [];
    mock.method(rt, '_handleStoreDelete', async (k) => {
      cleanupCalls.push(k);
    });

    await stubClient.store.onDelete('channel:buffer:c1', {});
    assert.ok(cleanupCalls.includes('channel:buffer:c1'));
  });
});

// ── _saveNonImageAttachments ───────────────────────────────────────────────────
describe('ChannelAIRuntime _saveNonImageAttachments', () => {
  afterEach(() => mock.restoreAll());

  it('returns [] for null/empty attachments', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    assert.deepStrictEqual(await rt._saveNonImageAttachments(null, 'm1', '/tmp'), []);
    assert.deepStrictEqual(await rt._saveNonImageAttachments([], 'm1', '/tmp'), []);
  });

  it('returns [] for image-only attachments', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    const atts = [{ url: 'http://x/img.png', content_type: 'image/png', filename: 'img.png' }];
    assert.deepStrictEqual(await rt._saveNonImageAttachments(atts, 'm1', '/tmp'), []);
  });

  it('returns [] and logs warn when mkdir fails', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    mock.method(fs, 'mkdir', async () => {
      throw new Error('permission denied');
    });
    const warns = [];
    stubClient.logger.warn = (...a) => {
      warns.push(a);
    };

    const atts = [{ url: 'http://x/doc.pdf', content_type: 'application/pdf', filename: 'doc.pdf' }];
    const result = await rt._saveNonImageAttachments(atts, 'm1', '/tmp/ws');
    assert.deepStrictEqual(result, []);
    assert.ok(warns.length > 0, 'mkdir failure should be logged');
  });

  it('skips attachment when fetch fails', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({
      client: stubClient,
      agent: stubAgent,
      fetcher: async () => {
        throw new Error('network error');
      },
    });

    const workspaceDir = os.tmpdir() + '/ws-fetch-fail-' + Date.now();
    const atts = [{ url: 'http://x/doc.pdf', content_type: 'application/pdf', filename: 'doc.pdf' }];
    const result = await rt._saveNonImageAttachments(atts, 'm1', workspaceDir);
    assert.deepStrictEqual(result, []);
    // cleanup dir if created
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  });

  it('saves attachment and returns entry on success', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({
      client: stubClient,
      agent: stubAgent,
      fetcher: fakeFetcherWith('PDF CONTENT'),
      workspaceRoot: os.tmpdir(),
    });

    const workspaceDir = os.tmpdir() + '/rt-test-' + Date.now();
    const atts = [{ url: 'http://x/doc.pdf', content_type: 'application/pdf', filename: 'doc.pdf' }];
    const result = await rt._saveNonImageAttachments(atts, 'm1', workspaceDir);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].original, 'doc.pdf');
    assert.ok(result[0].saved_path.endsWith('doc.pdf'));
    // cleanup
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });
});

// ── _guildOf ──────────────────────────────────────────────────────────────────
describe('ChannelAIRuntime _guildOf', () => {
  afterEach(() => mock.restoreAll());

  it('returns guild_id from channel', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    const result = await rt._guildOf('c1');
    assert.strictEqual(result, 'g1');
  });

  it('returns null when getChannel throws', async () => {
    const { stubClient, stubAgent } = makeStubs();
    stubClient.getChannel = async () => {
      throw new Error('not found');
    };
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    const result = await rt._guildOf('c1');
    assert.strictEqual(result, null);
  });
});

describe('ChannelAIRuntime extra coverage', () => {
  afterEach(() => mock.restoreAll());

  it('constructor falls back to an unknown identity without a session user', () => {
    const { stubClient, stubAgent } = makeStubs();
    stubClient._session = {};
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    assert.strictEqual(rt.identity.mention, '<@unknown>');
    assert.match(rt.systemPrompt, /You are Bot/);
  });

  it('cleanup hook logs when workspace cleanup throws', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const warns = [];
    stubClient.logger.warn = (...a) => warns.push(a);
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    mock.method(rt, '_handleStoreDelete', async () => {
      throw new Error('cleanup boom');
    });
    await stubClient.store.onDelete('channel:buffer:c1', null);
    assert.ok(warns.some((w) => w.some((a) => typeof a === 'string' && a.includes('workspace cleanup failed'))));
  });

  it('_handleStoreDelete ignores session keys with an empty guild or user part', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    const rmCalls = [];
    mock.method(fs, 'rm', async (d) => {
      rmCalls.push(d);
    });
    await rt._handleStoreDelete('session:openrouter::u1');
    await rt._handleStoreDelete('session:openrouter:g1:');
    assert.strictEqual(rmCalls.length, 0);
  });

  it('_saveNonImageAttachments skips when the fetch response is not ok', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({
      client: stubClient,
      agent: stubAgent,
      fetcher: async () => ({ ok: false }),
    });
    const dir = path.join(os.tmpdir(), 'rt-notok-' + Date.now());
    const result = await rt._saveNonImageAttachments(
      [{ url: 'http://x/d.pdf', content_type: 'application/pdf', filename: 'd.pdf' }],
      'm1',
      dir,
    );
    assert.deepStrictEqual(result, []);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('onMessage trims the rolling buffer to bufferSize', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent, config: { bufferSize: 2 } });
    mock.method(rt, '_scheduleFlush', () => {});
    for (let i = 0; i < 4; i++) {
      await rt.onMessage({
        id: `m${i}`,
        channel_id: 'c1',
        guild_id: 'g1',
        author: { id: 'u1' },
        content: `t${i}`,
        attachments: [],
      });
    }
    assert.strictEqual(rt._state('c1').rollingBuffer.length, 2);
  });

  it('onMessage swallows a store.set failure', async () => {
    const { stubClient, stubAgent } = makeStubs();
    stubClient.store.set = async () => {
      throw new Error('store down');
    };
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    mock.method(rt, '_scheduleFlush', () => {});
    await rt.onMessage({
      id: 'm1',
      channel_id: 'c1',
      guild_id: 'g1',
      author: { id: 'u1' },
      content: 'hi',
      attachments: [],
    });
    assert.strictEqual(rt._state('c1').pendingMsgs.length, 1);
  });

  it('onMessage in a DM skips muted-channel and budget checks', async () => {
    const { stubClient, stubAgent, calls } = makeStubs();
    const rt = new ChannelAIRuntime({
      client: stubClient,
      agent: stubAgent,
      config: { debounceMs: 10, forceDebounceMs: 5 },
    });
    await rt.onMessage({ id: 'm1', channel_id: 'dm1', author: { id: 'u1' }, content: 'hello', attachments: [] });
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(calls.run, 1);
  });

  it('_flush compacts agent history past the threshold', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({
      client: stubClient,
      agent: stubAgent,
      config: { compactThreshold: 1, keepTail: 1 },
    });
    mock.method(rt.budget, 'exhausted', async () => false);
    const incSpy = mock.method(rt.budget, 'increment', async () => {});
    mock.method(rt, '_runAgent', async () => [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ]);
    const snap = {
      guild_id: 'g1',
      channel_id: 'c1',
      flag: 'new',
      content: 'hi',
      attachments_meta: [],
      id: 'm1',
      author_id: 'u1',
      author_name: 'u',
      reply_to: null,
      timestamp: Date.now(),
    };
    const s = rt._state('c1');
    s.pendingMsgs.push(snap);
    s.rollingBuffer.push(snap);
    await rt._flush('c1');
    assert.strictEqual(incSpy.mock.callCount(), 2); // compact charge + normal turn
  });

  it('_guildOf returns null when the channel has no guild', async () => {
    const { stubClient, stubAgent } = makeStubs();
    stubClient.getChannel = async (id) => ({ id, name: 'x' });
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    assert.strictEqual(await rt._guildOf('c1'), null);
  });

  it('invoke command mode tolerates a missing author id and empty prompt', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    mock.method(rt, '_runAgent', async () => []);
    mock.method(rt.budget, 'increment', async () => {});
    await rt.invoke({
      mode: 'command',
      msg: { id: 'm1', channel_id: 'c1', guild_id: 'g1', author: {}, attachments: [] },
    });
    assert.strictEqual(rt._state('c1').llmActive, false);
  });

  it('invoke command mode uses the Bot fallback name without a session', async () => {
    const { stubClient, stubAgent } = makeStubs();
    stubClient._session = {};
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    mock.method(rt, '_runAgent', async () => []);
    mock.method(rt.budget, 'increment', async () => {});
    await rt.invoke({
      mode: 'command',
      msg: { id: 'm1', channel_id: 'c1', guild_id: 'g1', author: { id: 'u1' }, content: 'hi', attachments: [] },
    });
    assert.strictEqual(rt._state('c1').llmActive, false);
  });

  it('invoke command mode reuses non-empty agent history without reloading', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    mock.method(rt, '_runAgent', async (msgs) => msgs);
    mock.method(rt.budget, 'increment', async () => {});
    const s = rt._state('c1');
    s.agentMessages = [{ role: 'user', content: 'seed' }];
    await rt.invoke({
      mode: 'command',
      msg: { id: 'm1', channel_id: 'c1', guild_id: 'g1', author: { id: 'u1' }, content: 'hi', attachments: [] },
    });
    assert.ok(s.agentMessages.some((m) => m.content === 'seed'));
  });

  it('invoke command mode swallows a session-persist failure', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const realSet = stubClient.store.set;
    stubClient.store.set = async (k, ...rest) => {
      if (typeof k === 'string' && k.startsWith('session:openrouter:')) throw new Error('persist down');
      return realSet(k, ...rest);
    };
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    mock.method(rt, '_runAgent', async () => []);
    mock.method(rt.budget, 'increment', async () => {});
    await rt.invoke({
      mode: 'command',
      msg: { id: 'm1', channel_id: 'c1', guild_id: 'g1', author: { id: 'u1' }, content: 'hi', attachments: [] },
    });
    assert.strictEqual(rt._state('c1').llmActive, false);
  });

  it('_composeUserPrompt copes with a nameless channel and a getChannel failure', async () => {
    const { stubClient, stubAgent } = makeStubs();
    const rt = new ChannelAIRuntime({ client: stubClient, agent: stubAgent });
    stubClient.getChannel = async (id) => ({ id });
    const out1 = await rt._composeUserPrompt('c1', rt._state('c1'));
    assert.match(out1, /channel_id=c1/);
    stubClient.getChannel = async () => {
      throw new Error('no channel');
    };
    const out2 = await rt._composeUserPrompt('c2', rt._state('c2'));
    assert.strictEqual(typeof out2, 'string');
  });
});
