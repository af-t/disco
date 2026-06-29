import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as chan from '../../../src/ai/tools/discord-manage-channel.js';
import * as role from '../../../src/ai/tools/discord-manage-role.js';
import * as guild from '../../../src/ai/tools/discord-edit-guild.js';
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
