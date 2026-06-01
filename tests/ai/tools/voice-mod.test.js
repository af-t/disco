import { describe, it } from 'node:test';
import assert from 'node:assert';
import permissionFlags from '../../../src/lib/permission.js';
import * as vmute from '../../../src/ai/tools/discord-voice-mute-member.js';
import * as vdeaf from '../../../src/ai/tools/discord-voice-deafen-member.js';
import * as vdisc from '../../../src/ai/tools/discord-voice-disconnect-member.js';

// Same helper as Task 5 (deletion tools).
export function gatedCtx({ perms = permissionFlags.ADMINISTRATOR, bufferIds = ['m-admin'], rest = {} } = {}) {
  const map = new Map();
  const client = {
    getChannel: async () => ({ guild_id: 'g1' }),
    getMessage: async () => ({ author: { id: 'a1', bot: false } }),
    getGuildMember: async () => ({ roles: ['role1'] }),
    getRoles: async () => [
      { id: 'g1', permissions: '0' },
      { id: 'role1', permissions: String(perms) },
    ],
    store: { get: async (k) => map.get(k), set: async (k, v) => void map.set(k, v) },
    logger: { warn() {} },
    ...rest,
  };
  const runtime = {
    _agentGuild: new Map(),
    channels: new Map([['c1', { authorizableIds: new Set(bufferIds) }]]),
  };
  return { ctx: { client, runtime }, map };
}

describe('voice moderation tools', () => {
  it('discord_voice_mute_member sets mute', async () => {
    const calls = [];
    const { ctx } = gatedCtx({ rest: { editGuildMember: async (g, u, body) => calls.push([g, u, body]) } });
    const out = JSON.parse(
      await vmute.execute(ctx, { channel_id: 'c1', user_id: 'u9', mute: true, authorizing_message_id: 'm-admin' }),
    );
    assert.equal(out.ok, true);
    assert.deepEqual(calls[0][2], { mute: true });
  });

  it('discord_voice_deafen_member sets deaf', async () => {
    const calls = [];
    const { ctx } = gatedCtx({ rest: { editGuildMember: async (g, u, body) => calls.push([g, u, body]) } });
    const out = JSON.parse(
      await vdeaf.execute(ctx, { channel_id: 'c1', user_id: 'u9', deaf: true, authorizing_message_id: 'm-admin' }),
    );
    assert.equal(out.ok, true);
    assert.deepEqual(calls[0][2], { deaf: true });
  });

  it('discord_voice_disconnect_member sets channel_id null', async () => {
    const calls = [];
    const { ctx } = gatedCtx({ rest: { editGuildMember: async (g, u, body) => calls.push([g, u, body]) } });
    const out = JSON.parse(
      await vdisc.execute(ctx, { channel_id: 'c1', user_id: 'u9', authorizing_message_id: 'm-admin' }),
    );
    assert.equal(out.ok, true);
    assert.deepEqual(calls[0][2], { channel_id: null });
  });
});
