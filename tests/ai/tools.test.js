import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { TOOL_DEFINITIONS, getExecutor, buildProxyTools, ACTION_TOOL_NAMES } from '../../src/ai/tools/index.js';

afterEach(() => mock.restoreAll());

describe('tools registry', () => {
  it('exposes a definition for all 26 Discord tools', () => {
    assert.equal(TOOL_DEFINITIONS.length, 26);
    for (const def of TOOL_DEFINITIONS) {
      assert.equal(typeof def.name, 'string');
      assert.equal(typeof def.description, 'string');
      assert.equal(def.input_schema.type, 'object');
    }
  });

  it('discord_send executor sends a message and notifies the runtime', async () => {
    const calls = [];
    const ctx = {
      client: { sendMessage: async (channel_id, content) => ({ id: 's1', channel_id, content }) },
      runtime: { onBotMessage: (m) => calls.push(m) },
    };
    const out = JSON.parse(await getExecutor('discord_send')(ctx, { channel_id: 'c1', content: 'hi' }));
    assert.deepEqual(out, { ok: true, message_id: 's1' });
    assert.equal(calls.length, 1);
  });

  it('discord_send executor returns ok:false on a thrown error', async () => {
    const ctx = {
      client: {
        sendMessage: async () => {
          throw new Error('boom');
        },
      },
      runtime: { onBotMessage: () => {} },
    };
    const out = JSON.parse(await getExecutor('discord_send')(ctx, { channel_id: 'c1', content: 'hi' }));
    assert.equal(out.ok, false);
    assert.match(out.error, /boom/);
  });

  it('buildProxyTools produces tools whose execute RPCs by name', async () => {
    const rpcCalls = [];
    const rpc = (name, input) => {
      rpcCalls.push({ name, input });
      return Promise.resolve('rpc-result');
    };
    const proxies = buildProxyTools(rpc);
    assert.equal(proxies.length, 26);
    const reply = proxies.find((t) => t.name === 'discord_reply');
    const result = await reply.execute({ channel_id: 'c1', message_id: 'm1', content: 'yo' });
    assert.equal(result, 'rpc-result');
    assert.deepEqual(rpcCalls[0], {
      name: 'discord_reply',
      input: { channel_id: 'c1', message_id: 'm1', content: 'yo' },
    });
  });

  it('keeps ACTION_TOOL_NAMES', () => {
    assert.ok(ACTION_TOOL_NAMES.has('discord_send'));
  });

  it('discord_read executor fetches the message, saves attachments, and sets saved_path', async () => {
    const rawMsg = {
      id: 'm1',
      channel_id: 'c1',
      content: 'read-me',
      timestamp: '2026-05-26T18:00:00Z',
      attachments: [{ filename: 'test.png', content_type: 'image/png', url: 'http://cdn/test.png', size: 100 }],
    };
    const ctx = {
      client: { getMessage: async (_channel_id, _message_id) => rawMsg },
      runtime: {
        saveAllAttachments: async (attachments, msgId, channelId) => {
          assert.deepEqual(attachments, rawMsg.attachments);
          assert.equal(msgId, 'm1');
          assert.equal(channelId, 'c1');
          return [{ original: 'test.png', saved_path: '/path/to/test.png' }];
        },
      },
    };
    const out = JSON.parse(await getExecutor('discord_read')(ctx, { channel_id: 'c1', message_id: 'm1' }));
    assert.ok(out.ok);
    assert.equal(out.message.id, 'm1');
    assert.equal(out.message.attachments[0].url, 'http://cdn/test.png');
    assert.equal(out.message.attachments[0].saved_path, '/path/to/test.png');
  });

  it('discord_fetch_history executor fetches messages, saves attachments, and sets saved_path', async () => {
    const rawMsg = {
      id: 'm2',
      channel_id: 'c1',
      content: 'history-msg',
      timestamp: '2026-05-26T18:00:00Z',
      attachments: [{ filename: 'h.png', content_type: 'image/png', url: 'http://cdn/h.png', size: 100 }],
    };
    const ctx = {
      client: {
        makeRequest: async (method, path) => {
          assert.equal(method, 'GET');
          assert.match(path, /messages/);
          return [rawMsg];
        },
      },
      runtime: {
        config: { fetchHistoryMax: 50 },
        saveAllAttachments: async (attachments, msgId, channelId) => {
          assert.deepEqual(attachments, rawMsg.attachments);
          assert.equal(msgId, 'm2');
          assert.equal(channelId, 'c1');
          return [{ original: 'h.png', saved_path: '/path/to/h.png' }];
        },
      },
    };
    const out = JSON.parse(await getExecutor('discord_fetch_history')(ctx, { channel_id: 'c1', limit: 5 }));
    assert.ok(out.ok);
    assert.equal(out.messages.length, 1);
    assert.equal(out.messages[0].attachments[0].url, 'http://cdn/h.png');
    assert.equal(out.messages[0].attachments[0].saved_path, '/path/to/h.png');
  });
});
