import { describe, it } from 'node:test';
import assert from 'node:assert';
import afk from '../../src/commands/utils/afk.js';

const USER_ID = '100000000000000001';
const GUILD_ID = '300000000000000001';
const CHANNEL_ID = '200000000000000001';

function createMockClient() {
  const setCalls = [];
  return {
    setCalls,
    store: {
      set: async (key, value, options) => setCalls.push([key, value, options]),
    },
    reply: async () => ({ id: 'reply_001' }),
  };
}

function createMockMessage(overrides = {}) {
  return {
    id: '900000000000000001',
    channel_id: CHANNEL_ID,
    guild_id: GUILD_ID,
    author: { id: USER_ID, username: 'TestUser', global_name: 'TestUser' },
    ...overrides,
  };
}

describe('afk command', () => {
  it('sets the AFK entry as a cache item with a 7-day TTL', async () => {
    const client = createMockClient();
    await afk.execute(client, createMockMessage(), ['out', 'for', 'lunch']);

    assert.equal(client.setCalls.length, 1);
    const [key, , options] = client.setCalls[0];
    assert.equal(key, `afk:${GUILD_ID}:${USER_ID}`);
    assert.deepEqual(options, { isCache: true, ttl: 604_800_000 });
  });
});
