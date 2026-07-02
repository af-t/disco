import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as chan from '../../../src/ai/tools/discord-manage-channel.js';
import * as role from '../../../src/ai/tools/discord-manage-role.js';
import * as guild from '../../../src/ai/tools/discord-edit-guild.js';
import permissionFlags from '../../../src/lib/permission.js';
import { gatedCtx } from './test_helper.js';

const restStub = (calls) => ({
  createChannel: async (g, o) => {
    calls.push(['createChannel', g, o]);
    return { id: 'newc' };
  },
  editChannel: async (c, o) => calls.push(['editChannel', c, o]),
  deleteChannel: async (c) => calls.push(['deleteChannel', c]),
  createRole: async (g, o) => {
    calls.push(['createRole', g, o]);
    return { id: 'newr' };
  },
  editRole: async (g, r, o) => calls.push(['editRole', g, r, o]),
  deleteRole: async (g, r) => calls.push(['deleteRole', g, r]),
  addMemberRole: async (g, u, r) => calls.push(['addMemberRole', g, u, r]),
  removeMemberRole: async (g, u, r) => calls.push(['removeMemberRole', g, u, r]),
  modifyGuild: async (g, o) => calls.push(['modifyGuild', g, o]),
});

describe('guild administration tools', () => {
  it('manage_channel create calls createChannel with options', async () => {
    const calls = [];
    const { ctx } = gatedCtx({ rest: restStub(calls) });
    const out = JSON.parse(
      await chan.execute(ctx, {
        channel_id: 'c1',
        action: 'create',
        options: { name: 'new' },
        authorizing_message_id: 'm-admin',
      }),
    );
    assert.equal(out.ok, true);
    assert.deepEqual(calls[0], ['createChannel', 'g1', { name: 'new' }]);
  });

  it('manage_channel delete calls deleteChannel on target', async () => {
    const calls = [];
    const { ctx } = gatedCtx({ rest: restStub(calls) });
    await chan.execute(ctx, {
      channel_id: 'c1',
      action: 'delete',
      target_channel_id: 'cX',
      authorizing_message_id: 'm-admin',
    });
    assert.deepEqual(calls[0], ['deleteChannel', 'cX']);
  });

  it('manage_channel rejects edit/delete targets from another guild', async () => {
    const calls = [];
    const { ctx } = gatedCtx({ rest: restStub(calls) });
    ctx.client.getChannel = async (channelId) => ({ guild_id: channelId === 'c1' ? 'g1' : 'g2' });
    const out = JSON.parse(
      await chan.execute(ctx, {
        channel_id: 'c1',
        action: 'delete',
        target_channel_id: 'c-other-guild',
        authorizing_message_id: 'm-admin',
      }),
    );
    assert.equal(out.ok, false);
    assert.match(out.error, /same guild/);
    assert.equal(calls.length, 0);
  });

  it('manage_role rejects administrator grants from non-admin role managers', async () => {
    const calls = [];
    const { ctx } = gatedCtx({ perms: permissionFlags.MANAGE_ROLES, rest: restStub(calls) });
    const out = JSON.parse(
      await role.execute(ctx, {
        channel_id: 'c1',
        action: 'create',
        options: { name: 'admin-ish', permissions: String(permissionFlags.ADMINISTRATOR) },
        authorizing_message_id: 'm-admin',
      }),
    );
    assert.equal(out.ok, false);
    assert.match(out.error, /permissions/);
    assert.equal(calls.length, 0);
  });

  it('manage_role rejects assigning roles at or above the authorizer position', async () => {
    const calls = [];
    const { ctx } = gatedCtx({ perms: permissionFlags.MANAGE_ROLES, rest: restStub(calls) });
    ctx.client.getGuildMember = async (_guildId, userId) => ({ roles: userId === 'a1' ? ['mod'] : ['member'] });
    ctx.client.getRoles = async () => [
      { id: 'g1', permissions: '0', position: 0 },
      { id: 'member', permissions: '0', position: 1 },
      { id: 'mod', permissions: String(permissionFlags.MANAGE_ROLES), position: 5 },
      { id: 'high', permissions: '0', position: 5 },
    ];
    const out = JSON.parse(
      await role.execute(ctx, {
        channel_id: 'c1',
        action: 'assign',
        user_id: 'u9',
        role_id: 'high',
        authorizing_message_id: 'm-admin',
      }),
    );
    assert.equal(out.ok, false);
    assert.match(out.error, /role hierarchy/);
    assert.equal(calls.length, 0);
  });

  it('manage_role assign calls addMemberRole', async () => {
    const calls = [];
    const { ctx } = gatedCtx({ rest: restStub(calls) });
    await role.execute(ctx, {
      channel_id: 'c1',
      action: 'assign',
      user_id: 'u9',
      role_id: 'r2',
      authorizing_message_id: 'm-admin',
    });
    assert.deepEqual(calls[0], ['addMemberRole', 'g1', 'u9', 'r2']);
  });

  it('edit_guild calls modifyGuild with options', async () => {
    const calls = [];
    const { ctx } = gatedCtx({ rest: restStub(calls) });
    await guild.execute(ctx, { channel_id: 'c1', options: { name: 'Cool Server' }, authorizing_message_id: 'm-admin' });
    assert.deepEqual(calls[0], ['modifyGuild', 'g1', { name: 'Cool Server' }]);
  });

  it('manage_channel rejects an unknown action', async () => {
    const calls = [];
    const { ctx } = gatedCtx({ rest: restStub(calls) });
    const out = JSON.parse(
      await chan.execute(ctx, { channel_id: 'c1', action: 'frobnicate', authorizing_message_id: 'm-admin' }),
    );
    assert.equal(out.ok, false);
  });

  it('short-circuits on authorization failure', async () => {
    const calls = [];
    const { ctx } = gatedCtx({ bufferIds: [], rest: restStub(calls) });
    const out = JSON.parse(
      await guild.execute(ctx, { channel_id: 'c1', options: {}, authorizing_message_id: 'm-admin' }),
    );
    assert.equal(out.ok, false);
    assert.equal(calls.length, 0);
  });
});
