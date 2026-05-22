import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { TOOL_DEFINITIONS, getExecutor, buildProxyTools, ACTION_TOOL_NAMES } from '../../src/ai/tools/index.js';

afterEach(() => mock.restoreAll());

describe('tools registry', () => {
  it('exposes a definition for all 10 Discord tools', () => {
    assert.equal(TOOL_DEFINITIONS.length, 10);
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
    assert.equal(proxies.length, 10);
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
});
