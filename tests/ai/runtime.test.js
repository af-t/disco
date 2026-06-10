import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChannelAIRuntime } from '../../src/ai/runtime.js';

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

// Stub pool: records run() calls; isRunning() is controllable per key.
function stubPool() {
  const runs = [];
  const running = new Set();
  return {
    runs,
    running,
    has: (k) => running.has(k),
    isRunning: (k) => running.has(k),
    run: async (agentKey, content, spawnContext) => {
      runs.push({ agentKey, content, spawnContext });
      return { outcome: 'finished', usage: {} };
    },
  };
}

function stubClient() {
  const store = new Map();
  return {
    _session: { user: { id: 'BOT', username: 'TestBot' } },
    store: {
      async get(k) {
        return store.get(k);
      },
      async set(k, v) {
        store.set(k, v);
      },
      async has(k) {
        return store.has(k);
      },
    },
    getChannel: async (id) => ({ id, name: `chan-${id}`, guild_id: 'g1' }),
    getMessage: async (cid, mid) => ({ id: mid, channel_id: cid, attachments: [] }),
    reply: async () => ({ id: 'r' }),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };
}

function msg(over = {}) {
  return {
    id: 'm1',
    channel_id: 'c1',
    guild_id: 'g1',
    author: { id: 'u1', username: 'user' },
    content: 'hello',
    attachments: [],
    ...over,
  };
}

describe('ChannelAIRuntime with the agent pool', () => {
  it('ignores bot and self messages', async () => {
    const pool = stubPool();
    const rt = new ChannelAIRuntime({ client: stubClient(), pool, config: { debounceMs: 10, forceDebounceMs: 5 } });
    await rt.onMessage(msg({ author: { id: 'BOT' } }));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(pool.runs.length, 0);
  });

  it('debounces a normal message then dispatches one run to the channel key', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const pool = stubPool();
    const rt = new ChannelAIRuntime({
      client: stubClient(),
      pool,
      config: { debounceMs: 20, forceDebounceMs: 5, dailyLimit: 1000 },
    });
    await rt.onMessage(msg({ content: 'hello there' }));
    mock.timers.tick(25);
    await new Promise((r) => setImmediate(r));
    assert.equal(pool.runs.length, 1);
    assert.equal(pool.runs[0].agentKey, 'channel:c1');
  });

  it('steers immediately into a running child, skipping the debounce', async () => {
    const pool = stubPool();
    pool.running.add('channel:c1');
    const rt = new ChannelAIRuntime({
      client: stubClient(),
      pool,
      config: { debounceMs: 9999, forceDebounceMs: 9999, dailyLimit: 1000 },
    });
    await rt.onMessage(msg({ content: 'mid-run question' }));
    assert.equal(pool.runs.length, 1); // no debounce wait
    assert.equal(pool.runs[0].agentKey, 'channel:c1');
  });

  it('does not steer into a running child for a muted channel', async () => {
    const pool = stubPool();
    pool.running.add('channel:c1');
    const rt = new ChannelAIRuntime({
      client: stubClient(),
      pool,
      config: { dailyLimit: 1000 },
      mutedChannelsResolver: async () => ['c1'],
    });
    await rt.onMessage(msg());
    assert.equal(pool.runs.length, 0);
  });

  it('invoke command mode dispatches to a per-user agent key with history', async () => {
    const client = stubClient();
    await client.store.set('session:openrouter:g1:u1', [{ role: 'user', content: 'earlier' }]);
    const pool = stubPool();
    const rt = new ChannelAIRuntime({ client, pool, config: { dailyLimit: 1000 } });
    await rt.invoke({ mode: 'command', msg: msg(), explicitPrompt: 'do a thing' });
    assert.equal(pool.runs[0].agentKey, 'command:g1:u1');
    assert.deepEqual(pool.runs[0].spawnContext.history, [{ role: 'user', content: 'earlier' }]);
  });

  it('invoke command mode replies a notice on a truncated outcome', async () => {
    const client = stubClient();
    const replies = [];
    client.reply = async (_m, content) => {
      replies.push(content);
      return { id: 'r' };
    };
    const pool = stubPool();
    pool.run = async () => ({ outcome: 'truncated', usage: {} });
    const rt = new ChannelAIRuntime({ client, pool, config: { dailyLimit: 1000 } });
    await rt.invoke({ mode: 'command', msg: msg(), explicitPrompt: 'big task' });
    assert.equal(replies.length, 1);
    assert.match(replies[0], /turn limit/i);
  });

  it('natural dispatch scopes memory to the guild, outside the channel workspace', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const pool = stubPool();
    const rt = new ChannelAIRuntime({
      client: stubClient(),
      pool,
      config: { debounceMs: 20, forceDebounceMs: 5, dailyLimit: 1000 },
    });
    await rt.onMessage(msg({ content: 'hello there' }));
    mock.timers.tick(25);
    await new Promise((r) => setImmediate(r));
    assert.equal(pool.runs[0].spawnContext.memoryDir, path.join(rt.workspaceRoot, 'memory', 'guild-g1'));
  });

  it('natural dispatch in a DM scopes memory to the channel', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const pool = stubPool();
    const client = stubClient();
    client.getChannel = async (id) => ({ id, name: `chan-${id}`, guild_id: null });
    const rt = new ChannelAIRuntime({
      client,
      pool,
      config: { debounceMs: 20, forceDebounceMs: 5, dailyLimit: 1000 },
    });
    await rt.onMessage(msg({ content: 'hello there', guild_id: undefined }));
    mock.timers.tick(25);
    await new Promise((r) => setImmediate(r));
    assert.equal(pool.runs[0].spawnContext.memoryDir, path.join(rt.workspaceRoot, 'memory', 'dm-c1'));
  });

  it('invoke command mode scopes memory per guild and user', async () => {
    const pool = stubPool();
    const rt = new ChannelAIRuntime({ client: stubClient(), pool, config: { dailyLimit: 1000 } });
    await rt.invoke({ mode: 'command', msg: msg(), explicitPrompt: 'do a thing' });
    assert.equal(pool.runs[0].spawnContext.memoryDir, path.join(rt.workspaceRoot, 'memory', 'command-g1-u1'));
  });

  it('onAgentCharge increments the guild budget', async () => {
    const client = stubClient();
    const pool = stubPool();
    const rt = new ChannelAIRuntime({ client, pool, config: { dailyLimit: 1000 } });
    rt._agentGuild.set('command:g1:u1', 'g1');
    await rt.onAgentCharge('command:g1:u1', 'run');
    const v = await client.store.get(rt.budget._keyFor('g1'));
    assert.equal(v.count, 1);
  });

  it('onAgentMessages persists command-mode history to the session key', async () => {
    const client = stubClient();
    const pool = stubPool();
    const rt = new ChannelAIRuntime({ client, pool, config: { dailyLimit: 1000 } });
    await rt.onAgentMessages('command:g1:u1', [{ role: 'user', content: 'x' }]);
    const stored = await client.store.get('session:openrouter:g1:u1');
    assert.deepEqual(stored, [{ role: 'user', content: 'x' }]);
  });

  it('trims the rolling buffer to bufferSize', () => {
    const rt = new ChannelAIRuntime({ client: stubClient(), pool: stubPool(), config: { bufferSize: 3 } });
    for (let i = 0; i < 6; i++) rt.onBotMessage({ channel_id: 'c1', id: `b${i}`, content: 'x' });
    assert.equal(rt._state('c1').rollingBuffer.length, 3);
  });

  it('removes the channel workspace dir when its buffer key is deleted', async () => {
    const workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'rt-ws-'));
    try {
      const channelDir = path.join(workspaceRoot, 'channel-c1');
      await fsp.mkdir(channelDir, { recursive: true });
      const client = stubClient();
      new ChannelAIRuntime({ client, pool: stubPool(), config: {}, workspaceRoot });
      await client.store.onDelete('channel:buffer:c1');
      await assert.rejects(fsp.access(channelDir));
    } finally {
      await fsp.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('dispatches a content-part array with an image_url block for image attachments', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const pool = stubPool();
    const rt = new ChannelAIRuntime({
      client: stubClient(),
      pool,
      config: { debounceMs: 20, forceDebounceMs: 5, dailyLimit: 1000 },
    });
    await rt.onMessage(
      msg({
        content: 'look at this',
        attachments: [
          { id: 'a1', filename: 'pic.png', content_type: 'image/png', url: 'http://cdn/pic.png', size: 10 },
        ],
      }),
    );
    mock.timers.tick(25);
    await new Promise((r) => setImmediate(r));
    assert.equal(pool.runs.length, 1);
    assert.ok(Array.isArray(pool.runs[0].content));
    assert.ok(pool.runs[0].content.some((b) => b.type === 'image_url' && b.image_url.url === 'http://cdn/pic.png'));
  });

  it('natural mode fallback reply triggers on done.text with actionToolCalled:false', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const pool = stubPool();
    const client = stubClient();
    const sentReplies = [];
    client.reply = async (m, text) => {
      sentReplies.push({ m, text });
      return { id: 'sent-reply-id' };
    };

    pool.run = async (_agentKey, _content, _spawnContext) => {
      return { outcome: 'finished', text: 'this is a fallback response', actionToolCalled: false, usage: {} };
    };

    const rt = new ChannelAIRuntime({
      client,
      pool,
      config: { debounceMs: 20, forceDebounceMs: 5, dailyLimit: 1000 },
    });

    await rt.onMessage(msg({ id: 'm1', content: 'test question' }));
    mock.timers.tick(25);
    await new Promise((r) => setImmediate(r));

    assert.equal(sentReplies.length, 1);
    assert.equal(sentReplies[0].text, 'this is a fallback response');
    assert.equal(sentReplies[0].m.id, 'm1');
  });

  it('natural mode fallback reply ignores SKIP and actionToolCalled:true', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const pool = stubPool();
    const client = stubClient();
    const sentReplies = [];
    client.reply = async (m, text) => {
      sentReplies.push({ m, text });
      return { id: 'sent-reply-id' };
    };

    const rt = new ChannelAIRuntime({
      client,
      pool,
      config: { debounceMs: 20, forceDebounceMs: 5, dailyLimit: 1000 },
    });

    // Case 1: text is SKIP
    pool.run = async () => ({ outcome: 'finished', text: 'SKIP', actionToolCalled: false, usage: {} });
    await rt.onMessage(msg({ id: 'm1', content: 'test question' }));
    mock.timers.tick(25);
    await new Promise((r) => setImmediate(r));
    assert.equal(sentReplies.length, 0);

    // Case 2: actionToolCalled:true
    pool.run = async () => ({ outcome: 'finished', text: 'hello', actionToolCalled: true, usage: {} });
    await rt.onMessage(msg({ id: 'm2', content: 'test question 2' }));
    mock.timers.tick(25);
    await new Promise((r) => setImmediate(r));
    assert.equal(sentReplies.length, 0);
  });

  it('command mode fallback reply triggers on done.text with actionToolCalled:false', async () => {
    const client = stubClient();
    const pool = stubPool();
    const sentReplies = [];
    client.reply = async (m, text) => {
      sentReplies.push({ m, text });
      return { id: 'sent-reply-id' };
    };

    pool.run = async () => ({
      outcome: 'finished',
      text: 'command fallback response',
      actionToolCalled: false,
      usage: {},
    });

    const rt = new ChannelAIRuntime({ client, pool, config: { dailyLimit: 1000 } });
    await rt.invoke({ mode: 'command', msg: msg(), explicitPrompt: 'do a thing' });

    assert.equal(sentReplies.length, 1);
    assert.equal(sentReplies[0].text, 'command fallback response');
  });

  it('natural mode only includes new pending messages when agent is already alive in the pool', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const pool = stubPool();
    const aliveAgents = new Set();
    pool.has = (k) => aliveAgents.has(k);
    pool.isRunning = (_k) => false;

    const client = stubClient();
    const rt = new ChannelAIRuntime({
      client,
      pool,
      config: { debounceMs: 20, forceDebounceMs: 5, dailyLimit: 1000 },
    });

    // Case 1: Agent is NOT alive in the pool yet.
    // It should render the full rollingBuffer.
    await rt.onMessage(msg({ id: 'm1', content: 'first message' }));
    mock.timers.tick(25);
    await new Promise((r) => setImmediate(r));
    assert.equal(pool.runs.length, 1);
    assert.match(pool.runs[0].content, /first message/);

    // Case 2: Agent IS alive in the pool.
    // It should only render the pending message, not the old one in rollingBuffer.
    aliveAgents.add('channel:c1');
    pool.runs.length = 0;

    await rt.onMessage(msg({ id: 'm2', content: 'second message' }));
    mock.timers.tick(25);
    await new Promise((r) => setImmediate(r));

    assert.equal(pool.runs.length, 1);
    assert.match(pool.runs[0].content, /second message/);
    assert.doesNotMatch(pool.runs[0].content, /first message/);
  });

  it('marks the dispatched message id as authorizable after an idle flush', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const pool = stubPool();
    const rt = new ChannelAIRuntime({
      client: stubClient(),
      pool,
      config: { debounceMs: 20, forceDebounceMs: 5, dailyLimit: 1000 },
    });
    await rt.onMessage(msg({ id: 'm1', content: 'ban that user please' }));
    mock.timers.tick(25);
    await new Promise((r) => setImmediate(r));
    assert.ok(rt._state('c1').authorizableIds.has('m1'));
  });

  it('replaces authorizable ids with the new message when steering a running child', async () => {
    const pool = stubPool();
    pool.running.add('channel:c1');
    const rt = new ChannelAIRuntime({
      client: stubClient(),
      pool,
      config: { debounceMs: 9999, forceDebounceMs: 9999, dailyLimit: 1000 },
    });
    rt._state('c1').authorizableIds = new Set(['old']);
    await rt.onMessage(msg({ id: 'm2', content: 'mid-run instruction' }));
    assert.ok(rt._state('c1').authorizableIds.has('m2'));
    assert.ok(!rt._state('c1').authorizableIds.has('old'));
  });

  it('marks the command message id as authorizable in command mode', async () => {
    const pool = stubPool();
    const rt = new ChannelAIRuntime({ client: stubClient(), pool, config: { dailyLimit: 1000 } });
    await rt.invoke({ mode: 'command', msg: msg({ id: 'm1' }), explicitPrompt: 'ban that user' });
    assert.ok(rt._state('c1').authorizableIds.has('m1'));
  });

  it('automatically fetches replied-to message attachments and sends them inline', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const pool = stubPool();
    const client = stubClient();

    // Stub getMessage to return a replied-to message with an image attachment
    client.getMessage = async (cid, mid) => {
      assert.equal(cid, 'c1');
      assert.equal(mid, 'replied-id');
      return {
        id: mid,
        channel_id: cid,
        attachments: [
          { filename: 'replied-image.png', content_type: 'image/png', url: 'http://cdn/replied-image.png', size: 500 },
        ],
      };
    };

    const rt = new ChannelAIRuntime({
      client,
      pool,
      config: { debounceMs: 20, forceDebounceMs: 5, dailyLimit: 1000 },
    });

    await rt.onMessage(
      msg({
        id: 'm2',
        content: 'what image is this?',
        message_reference: { message_id: 'replied-id', channel_id: 'c1' },
      }),
    );
    mock.timers.tick(25);
    await new Promise((r) => setImmediate(r));

    assert.equal(pool.runs.length, 1);
    assert.ok(Array.isArray(pool.runs[0].content));
    // Verify that the replied message's image is included in the multimodal blocks
    assert.ok(
      pool.runs[0].content.some((b) => b.type === 'image_url' && b.image_url.url === 'http://cdn/replied-image.png'),
    );
  });
});
