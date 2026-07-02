import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import DiscordClient from '../../src/client/level_2.js';

afterEach(() => mock.restoreAll());

function clientWithCapture() {
  const client = Object.create(DiscordClient.prototype);
  const calls = [];
  client.makeRequest = async (method, path, body, headers) => {
    calls.push({ method, path, body, headers });
    return { ok: true };
  };
  return { client, calls };
}

describe('member REST helpers', () => {
  it('editGuildMember PATCHes the member with the given body', async () => {
    const { client, calls } = clientWithCapture();
    await client.editGuildMember('g1', 'u1', { communication_disabled_until: '2026-06-01T00:00:00Z' });
    assert.equal(calls[0].method, 'PATCH');
    assert.equal(calls[0].path, '/guilds/g1/members/u1');
    assert.deepEqual(calls[0].body, { communication_disabled_until: '2026-06-01T00:00:00Z' });
  });

  it('editGuildMember sets X-Audit-Log-Reason when a reason is given', async () => {
    const { client, calls } = clientWithCapture();
    await client.editGuildMember('g1', 'u1', { mute: true }, 'spamming voice');
    assert.deepEqual(calls[0].headers, { 'X-Audit-Log-Reason': 'spamming voice' });
  });

  it('editGuildMember omits the audit header when no reason is given', async () => {
    const { client, calls } = clientWithCapture();
    await client.editGuildMember('g1', 'u1', { mute: true });
    assert.deepEqual(calls[0].headers, {});
  });

  it('addMemberRole PUTs the role', async () => {
    const { client, calls } = clientWithCapture();
    await client.addMemberRole('g1', 'u1', 'r1');
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].path, '/guilds/g1/members/u1/roles/r1');
  });

  it('removeMemberRole DELETEs the role', async () => {
    const { client, calls } = clientWithCapture();
    await client.removeMemberRole('g1', 'u1', 'r1');
    assert.equal(calls[0].method, 'DELETE');
    assert.equal(calls[0].path, '/guilds/g1/members/u1/roles/r1');
  });
});

describe('cache bypass with force option', () => {
  function clientWithStore() {
    const { client, calls } = clientWithCapture();
    const storeCalls = [];
    client.store = {
      get: async (k) => {
        storeCalls.push(['get', k]);
        return { cached: true };
      },
      set: async (k, v) => {
        storeCalls.push(['set', k, v]);
      },
    };
    client.makeRequest = async (method, path) => {
      calls.push({ method, path });
      return { fresh: true };
    };
    return { client, calls, storeCalls };
  }

  it('_cacheableGet reads from the store when force is not set', async () => {
    const { client, calls, storeCalls } = clientWithStore();
    const result = await client._cacheableGet('/guilds/g1');
    assert.deepEqual(result, { cached: true });
    assert.equal(calls.length, 0);
    assert.deepEqual(storeCalls[0], ['get', '/guilds/g1']);
  });

  it('_cacheableGet skips the store read and refreshes the cache when force is true', async () => {
    const { client, calls, storeCalls } = clientWithStore();
    const result = await client._cacheableGet('/guilds/g1', { force: true });
    assert.deepEqual(result, { fresh: true });
    assert.equal(calls.length, 1);
    assert.ok(!storeCalls.some((c) => c[0] === 'get'));
    assert.deepEqual(
      storeCalls.find((c) => c[0] === 'set'),
      ['set', '/guilds/g1', { fresh: true }],
    );
  });

  it('getGuild forwards force to the cache layer without leaking it into the query string', async () => {
    const { client, calls } = clientWithStore();
    await client.getGuild('g1', { force: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/guilds/g1?');
  });

  it('getRoles forwards force to the cache layer', async () => {
    const { client, calls } = clientWithStore();
    const result = await client.getRoles('g1', { force: true });
    assert.deepEqual(result, { fresh: true });
    assert.equal(calls.length, 1);
  });

  it('getGuildMember forwards force to the cache layer', async () => {
    const { client, calls } = clientWithStore();
    const result = await client.getGuildMember('g1', 'u1', { force: true });
    assert.deepEqual(result, { fresh: true });
    assert.equal(calls.length, 1);
  });
});
