import { describe, it } from 'node:test';
import assert from 'node:assert';
import handleUpdate from '../../src/events/message_update.js';

const USER_ID = '100000000000000001';
const CHANNEL_ID = '200000000000000001';
const GUILD_ID = '300000000000000001';
const MESSAGE_ID = '900000000000000001';
const LOG_CHANNEL_ID = '400000000000000001';

function createMockClient({ store = new Map(), logChannel = null, roles = [], memberRoles = [] } = {}) {
  const sent = [];
  const deleted = [];
  return {
    sent,
    deleted,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    store: {
      get: async (key) => store.get(key),
      set: async (key, value) => void store.set(key, value),
      delete: async (key) => void store.delete(key),
      has: async (key) => store.has(key),
    },
    getChannels: async () => (logChannel ? [logChannel] : []),
    getGuildMember: async () => ({ roles: memberRoles }),
    getRoles: async () => roles,
    deleteMessage: async (channelId, id) => deleted.push([channelId, id]),
    sendMessage: async (channelId, content, options) => {
      sent.push({ channelId, content, options });
      return { id: 'sent_001', channel_id: channelId };
    },
  };
}

function createMockMessage(overrides = {}) {
  return {
    id: MESSAGE_ID,
    channel_id: CHANNEL_ID,
    guild_id: GUILD_ID,
    content: '',
    author: { id: USER_ID, username: 'TestUser', bot: false },
    ...overrides,
  };
}

describe('message_update anti-link re-scan', () => {
  it('deletes an edit that introduces a disallowed link for a non-mod user', async () => {
    const client = createMockClient();
    await client.store.set(`${CHANNEL_ID}:${MESSAGE_ID}:old`, { content: 'clean message' });

    await handleUpdate(client, createMockMessage({ content: 'now with a link http://malicious-site.xyz' }));

    assert.deepEqual(client.deleted[0], [CHANNEL_ID, MESSAGE_ID]);
    assert.ok(client.sent.some((s) => typeof s.content === 'string' && s.content.includes('not allowed')));
  });

  it('allows an edited disallowed link from a user with MANAGE_MESSAGES', async () => {
    const client = createMockClient({
      memberRoles: ['mod'],
      roles: [{ id: 'mod', permissions: String(1 << 13) }],
    });
    await client.store.set(`${CHANNEL_ID}:${MESSAGE_ID}:old`, { content: 'clean message' });

    await handleUpdate(client, createMockMessage({ content: 'now with a link http://malicious-site.xyz' }));

    assert.equal(client.deleted.length, 0);
  });
});

describe('message_update uncached edit logging', () => {
  it('does not throw when logging an edit with no cached original and a configured log channel', async () => {
    const client = createMockClient({ logChannel: { id: LOG_CHANNEL_ID, name: 'logs' } });

    await handleUpdate(client, createMockMessage({ content: 'edited content, never cached' }));

    assert.equal(client.sent.length, 1);
    const embed = client.sent[0].options.embeds[0];
    assert.equal(embed.fields[0].value, '*Original not in cache*');
  });
});
