import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { authorize } from '../../../src/ai/tools/authorize.js';
import permissionFlags from '../../../src/lib/permission.js';

afterEach(() => mock.restoreAll());

function makeCtx({
  guildId = 'g1',
  bufferIds = ['m-admin'],
  author = { id: 'u-admin', bot: false },
  perms = permissionFlags.MANAGE_MESSAGES,
  roleId = 'role1',
} = {}) {
  const client = {
    getChannel: async () => ({ guild_id: guildId }),
    getMessage: async () => ({ author }),
    getGuildMember: async () => ({ roles: [roleId] }),
    getRoles: async () => [
      { id: guildId, permissions: '0' },
      { id: roleId, permissions: String(perms) },
    ],
  };
  const runtime = {
    _agentGuild: new Map(),
    channels: new Map([['c1', { rollingBuffer: bufferIds.map((id) => ({ id })) }]]),
  };
  return { client, runtime };
}

describe('authorize', () => {
  it('authorizes when the instruction author holds the required permission', async () => {
    const ctx = makeCtx();
    const res = await authorize(ctx, { channel_id: 'c1', authorizing_message_id: 'm-admin' }, 'MANAGE_MESSAGES');
    assert.deepEqual(res, { ok: true, guildId: 'g1', authorizedBy: 'u-admin' });
  });

  it('authorizes via ADMINISTRATOR even without the specific permission', async () => {
    const ctx = makeCtx({ perms: permissionFlags.ADMINISTRATOR });
    const res = await authorize(ctx, { channel_id: 'c1', authorizing_message_id: 'm-admin' }, 'BAN_MEMBERS');
    assert.equal(res.ok, true);
  });

  it('rejects when the author lacks the permission', async () => {
    const ctx = makeCtx({ perms: permissionFlags.SEND_MESSAGES });
    const res = await authorize(ctx, { channel_id: 'c1', authorizing_message_id: 'm-admin' }, 'MANAGE_MESSAGES');
    assert.equal(res.ok, false);
    assert.match(res.error, /lacks MANAGE_MESSAGES/);
  });

  it('rejects when the authorizing message is not in the channel buffer', async () => {
    const ctx = makeCtx({ bufferIds: ['other'] });
    const res = await authorize(ctx, { channel_id: 'c1', authorizing_message_id: 'm-admin' }, 'MANAGE_MESSAGES');
    assert.equal(res.ok, false);
    assert.match(res.error, /not a recent message/);
  });

  it('rejects in a DM (no guild)', async () => {
    const ctx = makeCtx();
    ctx.client.getChannel = async () => ({ guild_id: null });
    const res = await authorize(ctx, { channel_id: 'c1', authorizing_message_id: 'm-admin' }, 'MANAGE_MESSAGES');
    assert.equal(res.ok, false);
    assert.match(res.error, /guild/);
  });

  it('rejects when the authorizing message is from a bot', async () => {
    const ctx = makeCtx({ author: { id: 'b1', bot: true } });
    const res = await authorize(ctx, { channel_id: 'c1', authorizing_message_id: 'm-admin' }, 'MANAGE_MESSAGES');
    assert.equal(res.ok, false);
    assert.match(res.error, /non-bot/);
  });

  it('rejects an unknown permission name', async () => {
    const ctx = makeCtx();
    const res = await authorize(ctx, { channel_id: 'c1', authorizing_message_id: 'm-admin' }, 'NOT_A_PERM');
    assert.equal(res.ok, false);
    assert.match(res.error, /unknown permission/);
  });
});
