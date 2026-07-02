import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { authorize } from '../../../src/ai/tools/authorize.js';
import permissionFlags from '../../../src/lib/permission.js';

afterEach(() => mock.restoreAll());

function makeCtx({
  guildId = 'g1',
  triggerIds = ['m-admin'],
  author = { id: 'u-admin', bot: false },
  perms = permissionFlags.MANAGE_MESSAGES,
  roleId = 'role1',
  agentKey,
  agentContext,
  memberCalls = [],
  roleCalls = [],
} = {}) {
  const client = {
    getChannel: async () => ({ guild_id: guildId }),
    getMessage: async () => ({ author }),
    getGuildMember: async (...args) => {
      memberCalls.push(args);
      return { roles: [roleId] };
    },
    getRoles: async (...args) => {
      roleCalls.push(args);
      return [
        { id: guildId, permissions: '0' },
        { id: roleId, permissions: String(perms) },
      ];
    },
  };
  const runtime = {
    _agentGuild: new Map(),
    channels: new Map([['c1', { authorizableIds: new Set(triggerIds) }]]),
  };
  return { client, runtime, agentKey, agentContext };
}

describe('authorize', () => {
  it('authorizes when the instruction author holds the required permission', async () => {
    const ctx = makeCtx();
    const res = await authorize(ctx, { channel_id: 'c1', authorizing_message_id: 'm-admin' }, 'MANAGE_MESSAGES');
    assert.equal(res.ok, true);
    assert.equal(res.guildId, 'g1');
    assert.equal(res.authorizedBy, 'u-admin');
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

  it('rejects a message that did not trigger the current turn', async () => {
    const ctx = makeCtx({ triggerIds: ['other'] });
    const res = await authorize(ctx, { channel_id: 'c1', authorizing_message_id: 'm-admin' }, 'MANAGE_MESSAGES');
    assert.equal(res.ok, false);
    assert.match(res.error, /trigger/);
  });

  it('rejects a channel agent acting on a different channel', async () => {
    const ctx = makeCtx({ agentKey: 'channel:cOther' });
    const res = await authorize(ctx, { channel_id: 'c1', authorizing_message_id: 'm-admin' }, 'MANAGE_MESSAGES');
    assert.equal(res.ok, false);
    assert.match(res.error, /outside this conversation/);
  });

  it('allows a channel agent acting on its own channel', async () => {
    const ctx = makeCtx({ agentKey: 'channel:c1' });
    const res = await authorize(ctx, { channel_id: 'c1', authorizing_message_id: 'm-admin' }, 'MANAGE_MESSAGES');
    assert.equal(res.ok, true);
  });

  it('rejects a command agent acting outside its invoking channel', async () => {
    const ctx = makeCtx({ agentKey: 'command:g1:u1', agentContext: { channelId: 'c-other' } });
    const res = await authorize(ctx, { channel_id: 'c1', authorizing_message_id: 'm-admin' }, 'MANAGE_MESSAGES');
    assert.equal(res.ok, false);
    assert.match(res.error, /outside this conversation/);
  });

  it('uses fresh member and role reads for authorization', async () => {
    const memberCalls = [];
    const roleCalls = [];
    const ctx = makeCtx({ memberCalls, roleCalls });
    const res = await authorize(ctx, { channel_id: 'c1', authorizing_message_id: 'm-admin' }, 'MANAGE_MESSAGES');
    assert.equal(res.ok, true);
    assert.deepEqual(memberCalls[0], ['g1', 'u-admin', { force: true }]);
    assert.deepEqual(roleCalls[0], ['g1', { force: true }]);
  });

  it('rejects when the agent-specific authorizer set excludes the message', async () => {
    const ctx = makeCtx({ agentKey: 'command:g1:u1' });
    ctx.runtime.getAuthorizableIds = (agentKey) =>
      agentKey === 'command:g1:u1' ? new Set(['command-msg']) : new Set();
    const res = await authorize(ctx, { channel_id: 'c1', authorizing_message_id: 'm-admin' }, 'MANAGE_MESSAGES');
    assert.equal(res.ok, false);
    assert.match(res.error, /trigger/);
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
