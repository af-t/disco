import { describe, it } from 'node:test';
import assert from 'node:assert';
import permissionFlags from '../../../src/lib/permission.js';
import * as timeout from '../../../src/ai/tools/discord-timeout-member.js';
import * as untimeout from '../../../src/ai/tools/discord-remove-timeout.js';
import * as kick from '../../../src/ai/tools/discord-kick-member.js';
import * as ban from '../../../src/ai/tools/discord-ban-member.js';

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

describe('punishment tools', () => {
  it('discord_timeout_member sets communication_disabled_until and files a mute case', async () => {
    const calls = [];
    const { ctx, map } = gatedCtx({
      rest: { editGuildMember: async (g, u, body, reason) => calls.push([g, u, body, reason]) },
    });
    const out = JSON.parse(
      await timeout.execute(ctx, {
        channel_id: 'c1',
        user_id: 'u9',
        duration_seconds: 60,
        authorizing_message_id: 'm-admin',
      }),
    );
    assert.equal(out.ok, true);
    assert.ok(calls[0][2].communication_disabled_until);
    assert.match(calls[0][3], /instructed by a1/);
    assert.equal(map.get('modcase:g1:1').type, 'mute');
    assert.equal(map.get('modcase:g1:1').moderator_id, 'a1');
    assert.equal(map.get('modcase:g1:1').user_id, 'u9');
    assert.equal(map.get('modcase:g1:1').duration, 60000);
  });

  it('discord_remove_timeout clears the timeout and files an unmute case', async () => {
    const calls = [];
    const { ctx, map } = gatedCtx({ rest: { editGuildMember: async (g, u, body) => calls.push([g, u, body]) } });
    const out = JSON.parse(
      await untimeout.execute(ctx, { channel_id: 'c1', user_id: 'u9', authorizing_message_id: 'm-admin' }),
    );
    assert.equal(out.ok, true);
    assert.equal(calls[0][2].communication_disabled_until, null);
    assert.equal(map.get('modcase:g1:1').type, 'unmute');
  });

  it('discord_kick_member kicks with an attributed reason and files a kick case', async () => {
    const calls = [];
    const { ctx, map } = gatedCtx({ rest: { kickMember: async (g, u, r) => calls.push([g, u, r]) } });
    const out = JSON.parse(
      await kick.execute(ctx, { channel_id: 'c1', user_id: 'u9', reason: 'rude', authorizing_message_id: 'm-admin' }),
    );
    assert.equal(out.ok, true);
    assert.match(calls[0][2], /instructed by a1/);
    assert.equal(map.get('modcase:g1:1').type, 'kick');
  });

  it('discord_ban_member bans with an attributed reason and files a ban case', async () => {
    const calls = [];
    const { ctx, map } = gatedCtx({ rest: { banMember: async (g, u, o) => calls.push([g, u, o]) } });
    const out = JSON.parse(
      await ban.execute(ctx, { channel_id: 'c1', user_id: 'u9', reason: 'raid', authorizing_message_id: 'm-admin' }),
    );
    assert.equal(out.ok, true);
    assert.match(calls[0][2].reason, /instructed by a1/);
    assert.equal(map.get('modcase:g1:1').type, 'ban');
  });

  it('rejects without performing when authorization fails', async () => {
    let called = false;
    const { ctx } = gatedCtx({
      bufferIds: [],
      rest: {
        kickMember: async () => {
          called = true;
        },
      },
    });
    const out = JSON.parse(
      await kick.execute(ctx, { channel_id: 'c1', user_id: 'u9', authorizing_message_id: 'm-admin' }),
    );
    assert.equal(out.ok, false);
    assert.equal(called, false);
  });
});
