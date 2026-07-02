import { describe, it } from 'node:test';
import assert from 'node:assert';
import ban from '../../src/commands/admin/ban.js';
import kick from '../../src/commands/admin/kick.js';
import permissionFlags from '../../src/lib/permission.js';

const GUILD_ID = '300000000000000001';
const CHANNEL_ID = '200000000000000001';
const ACTOR_ID = '100000000000000001';
const TARGET_ID = '100000000000000002';
const OWNER_ID = '100000000000000099';

function createMockClient({ ownerId = OWNER_ID, actorRoles = [], targetRoles = [], roles = [] } = {}) {
  const storeData = new Map();
  const banCalls = [];
  const kickCalls = [];
  const replies = [];
  return {
    banCalls,
    kickCalls,
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
    banMember: async (guildId, userId, options) => banCalls.push([guildId, userId, options]),
    kickMember: async (guildId, userId, reason) => kickCalls.push([guildId, userId, reason]),
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

describe('moderation role hierarchy', () => {
  it('blocks ban when the target outranks the actor', async () => {
    const client = createMockClient({
      actorRoles: ['mod'],
      targetRoles: ['staff'],
      roles: [
        { id: GUILD_ID, permissions: '0', position: 0 },
        { id: 'mod', permissions: String(permissionFlags.BAN_MEMBERS), position: 1 },
        { id: 'staff', permissions: String(permissionFlags.BAN_MEMBERS), position: 5 },
      ],
    });
    await ban.execute(client, createMockMessage(), [`<@${TARGET_ID}>`]);
    assert.equal(client.banCalls.length, 0);
    assert.match(client.replies[0], /hierarchy/);
  });

  it('allows ban when the actor outranks the target', async () => {
    const client = createMockClient({
      actorRoles: ['staff'],
      targetRoles: ['mod'],
      roles: [
        { id: GUILD_ID, permissions: '0', position: 0 },
        { id: 'mod', permissions: String(permissionFlags.BAN_MEMBERS), position: 1 },
        { id: 'staff', permissions: String(permissionFlags.BAN_MEMBERS), position: 5 },
      ],
    });
    await ban.execute(client, createMockMessage(), [`<@${TARGET_ID}>`]);
    assert.equal(client.banCalls.length, 1);
    assert.equal(client.banCalls[0][1], TARGET_ID);
  });

  it('lets an ADMINISTRATOR actor bypass the hierarchy check', async () => {
    const client = createMockClient({
      actorRoles: ['admin'],
      targetRoles: ['staff'],
      roles: [
        { id: GUILD_ID, permissions: '0', position: 0 },
        { id: 'admin', permissions: String(permissionFlags.ADMINISTRATOR), position: 1 },
        { id: 'staff', permissions: String(permissionFlags.BAN_MEMBERS), position: 10 },
      ],
    });
    await ban.execute(client, createMockMessage(), [`<@${TARGET_ID}>`]);
    assert.equal(client.banCalls.length, 1);
  });

  it('blocks kick when the target outranks the actor', async () => {
    const client = createMockClient({
      actorRoles: ['mod'],
      targetRoles: ['staff'],
      roles: [
        { id: GUILD_ID, permissions: '0', position: 0 },
        { id: 'mod', permissions: String(permissionFlags.KICK_MEMBERS), position: 1 },
        { id: 'staff', permissions: String(permissionFlags.KICK_MEMBERS), position: 5 },
      ],
    });
    await kick.execute(client, createMockMessage(), [`<@${TARGET_ID}>`]);
    assert.equal(client.kickCalls.length, 0);
    assert.match(client.replies[0], /hierarchy/);
  });
});
