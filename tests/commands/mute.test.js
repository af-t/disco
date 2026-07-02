import { describe, it } from 'node:test';
import assert from 'node:assert';
import mute from '../../src/commands/admin/mute.js';
import permissionFlags from '../../src/lib/permission.js';

const GUILD_ID = '300000000000000001';
const CHANNEL_ID = '200000000000000001';
const ACTOR_ID = '100000000000000001';
const TARGET_ID = '100000000000000002';
const OWNER_ID = '100000000000000099';

function createMockClient({ ownerId = OWNER_ID, actorRoles = [], targetRoles = [], roles = [] } = {}) {
  const storeData = new Map();
  const muteCalls = [];
  const replies = [];
  return {
    muteCalls,
    replies,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    store: {
      get: async (k) => storeData.get(k),
      set: async (k, v) => void storeData.set(k, v),
      has: async (k) => storeData.has(k),
    },
    getGuild: async () => ({ id: GUILD_ID, owner_id: ownerId }),
    getGuildMember: async (guildId, userId) => {
      if (userId === ACTOR_ID) return { roles: actorRoles };
      if (userId === TARGET_ID) return { roles: targetRoles };
      return null;
    },
    getRoles: async () => roles,
    muteMember: async (guildId, userId, duration) => muteCalls.push([guildId, userId, duration]),
    deleteMessage: async () => {},
    reply: async (msg, content) => {
      replies.push(content);
      return { id: 'reply_001' };
    },
  };
}

function createMockMessage() {
  return {
    id: '900000000000000001',
    channel_id: CHANNEL_ID,
    guild_id: GUILD_ID,
    author: { id: ACTOR_ID, username: 'Moderator', bot: false },
  };
}

describe('mute duration parsing', () => {
  it('mutes for 7 days on a 1-week duration, not 2.8 hours', async () => {
    const client = createMockClient({
      actorRoles: ['mod'],
      roles: [
        { id: GUILD_ID, permissions: '0', position: 0 },
        { id: 'mod', permissions: String(permissionFlags.MUTE_MEMBERS), position: 1 },
      ],
    });
    await mute.execute(client, createMockMessage(), [`<@${TARGET_ID}>`, '1w']);
    assert.equal(client.muteCalls.length, 1);
    assert.equal(client.muteCalls[0][2], 1000 * 60 * 60 * 24 * 7);
  });
});

describe('mute role hierarchy', () => {
  it('blocks mute when the target outranks the actor', async () => {
    const client = createMockClient({
      actorRoles: ['mod'],
      targetRoles: ['staff'],
      roles: [
        { id: GUILD_ID, permissions: '0', position: 0 },
        { id: 'mod', permissions: String(permissionFlags.MUTE_MEMBERS), position: 1 },
        { id: 'staff', permissions: String(permissionFlags.MUTE_MEMBERS), position: 5 },
      ],
    });
    await mute.execute(client, createMockMessage(), [`<@${TARGET_ID}>`, '10m']);
    assert.equal(client.muteCalls.length, 0);
    assert.match(client.replies[0], /hierarchy/);
  });

  it('allows mute when the actor outranks the target', async () => {
    const client = createMockClient({
      actorRoles: ['staff'],
      targetRoles: ['mod'],
      roles: [
        { id: GUILD_ID, permissions: '0', position: 0 },
        { id: 'mod', permissions: String(permissionFlags.MUTE_MEMBERS), position: 1 },
        { id: 'staff', permissions: String(permissionFlags.MUTE_MEMBERS), position: 5 },
      ],
    });
    await mute.execute(client, createMockMessage(), [`<@${TARGET_ID}>`, '10m']);
    assert.equal(client.muteCalls.length, 1);
  });
});
