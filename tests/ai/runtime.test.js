import test from 'node:test';
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
