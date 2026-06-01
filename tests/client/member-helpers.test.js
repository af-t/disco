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
