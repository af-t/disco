import { describe, it } from 'node:test';
import assert from 'node:assert';
import permissionFlags from '../../../src/lib/permission.js';
import * as del from '../../../src/ai/tools/discord-delete-message.js';
import * as bulk from '../../../src/ai/tools/discord-bulk-delete.js';

// Builds a ctx where the real authorize() passes (admin instruction in buffer).
export function gatedCtx({ perms = permissionFlags.ADMINISTRATOR, bufferIds = ['m-admin'], rest = {} } = {}) {
  const map = new Map();
  const client = {
    getChannel: async () => ({ guild_id: 'g1' }),
    getMessage: async () => ({ author: { id: 'a1', bot: false } }),
    getGuildMember: async () => ({ roles: ['role1'] }),
    getRoles: async () => [
      { id: 'g1', permissions: '0' },
      { id: 'role1', permissions: String(perms) },
    ],
    store: { get: async (k) => map.get(k), set: async (k, v) => void map.set(k, v) },
    logger: { warn() {} },
    ...rest,
  };
  const runtime = {
    _agentGuild: new Map(),
    channels: new Map([['c1', { authorizableIds: new Set(bufferIds) }]]),
  };
  return { ctx: { client, runtime }, map };
}

describe('deletion tools', () => {
  it('discord_delete_message deletes after authorization', async () => {
    const calls = [];
    const { ctx } = gatedCtx({ rest: { deleteMessage: async (c, m) => calls.push([c, m]) } });
    const out = JSON.parse(
      await del.execute(ctx, { channel_id: 'c1', target_message_id: 'm9', authorizing_message_id: 'm-admin' }),
    );
    assert.equal(out.ok, true);
    assert.deepEqual(calls[0], ['c1', 'm9']);
  });

  it('discord_delete_message short-circuits when authorization fails (no REST call)', async () => {
    let called = false;
    const { ctx } = gatedCtx({
      bufferIds: [],
      rest: {
        deleteMessage: async () => {
          called = true;
        },
      },
    });
    const out = JSON.parse(
      await del.execute(ctx, { channel_id: 'c1', target_message_id: 'm9', authorizing_message_id: 'm-admin' }),
    );
    assert.equal(out.ok, false);
    assert.equal(called, false);
  });

  it('discord_bulk_delete deletes the id list after authorization', async () => {
    const calls = [];
    const { ctx } = gatedCtx({ rest: { bulkDeleteMessages: async (c, ids) => calls.push([c, ids]) } });
    const out = JSON.parse(
      await bulk.execute(ctx, { channel_id: 'c1', message_ids: ['m1', 'm2'], authorizing_message_id: 'm-admin' }),
    );
    assert.equal(out.ok, true);
    assert.equal(out.deleted, 2);
    assert.deepEqual(calls[0], ['c1', ['m1', 'm2']]);
  });
});

// Builds a real Discord snowflake encoding the given timestamp.
function snowflakeAt(ms) {
  return String((BigInt(ms) - 1420070400000n) << 22n);
}
const recentId = (suffix = 0) => snowflakeAt(Date.now() - 1000 + suffix);
const expiredId = () => snowflakeAt(Date.now() - 20 * 24 * 60 * 60 * 1000);

describe('bulk delete hardening', () => {
  it('skips messages older than 14 days and bulk-deletes the rest', async () => {
    const calls = [];
    const { ctx } = gatedCtx({ rest: { bulkDeleteMessages: async (c, ids) => calls.push([c, ids]) } });
    const r1 = recentId(0);
    const r2 = recentId(1);
    const out = JSON.parse(
      await bulk.execute(ctx, {
        channel_id: 'c1',
        message_ids: [r1, r2, expiredId()],
        authorizing_message_id: 'm-admin',
      }),
    );
    assert.equal(out.ok, true);
    assert.equal(out.deleted, 2);
    assert.equal(out.skipped_expired, 1);
    assert.deepEqual(calls[0], ['c1', [r1, r2]]);
  });

  it('falls back to a single delete when only one fresh id remains', async () => {
    const calls = [];
    const { ctx } = gatedCtx({
      rest: {
        bulkDeleteMessages: async () => calls.push('bulk'),
        deleteMessage: async (c, m) => calls.push(['single', c, m]),
      },
    });
    const r1 = recentId(0);
    const out = JSON.parse(
      await bulk.execute(ctx, {
        channel_id: 'c1',
        message_ids: [r1, expiredId()],
        authorizing_message_id: 'm-admin',
      }),
    );
    assert.equal(out.ok, true);
    assert.equal(out.deleted, 1);
    assert.deepEqual(calls, [['single', 'c1', r1]]);
  });

  it('dedupes repeated ids before bulk deleting', async () => {
    const calls = [];
    const { ctx } = gatedCtx({ rest: { bulkDeleteMessages: async (c, ids) => calls.push([c, ids]) } });
    const r1 = recentId(0);
    const r2 = recentId(1);
    await bulk.execute(ctx, { channel_id: 'c1', message_ids: [r1, r2, r1], authorizing_message_id: 'm-admin' });
    assert.deepEqual(calls[0], ['c1', [r1, r2]]);
  });

  it('errors without a REST call when every message is expired', async () => {
    let called = false;
    const { ctx } = gatedCtx({
      rest: {
        bulkDeleteMessages: async () => {
          called = true;
        },
        deleteMessage: async () => {
          called = true;
        },
      },
    });
    const out = JSON.parse(
      await bulk.execute(ctx, {
        channel_id: 'c1',
        message_ids: [expiredId(), expiredId()],
        authorizing_message_id: 'm-admin',
      }),
    );
    assert.equal(out.ok, false);
    assert.equal(called, false);
  });

  it('errors on an empty id list', async () => {
    const { ctx } = gatedCtx({ rest: { bulkDeleteMessages: async () => {} } });
    const out = JSON.parse(
      await bulk.execute(ctx, { channel_id: 'c1', message_ids: [], authorizing_message_id: 'm-admin' }),
    );
    assert.equal(out.ok, false);
  });
});
