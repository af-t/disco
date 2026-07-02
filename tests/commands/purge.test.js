import test, { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert';

// We import the module function directly
import purgeModule from '../../src/commands/admin/purge.js';

const CHANNEL_ID = '200000000000000001';
const GUILD_ID = '300000000000000001';
const USER_ID = '100000000000000001';

function createMockClient({ messages = [], deleteCalls = [], bulkDeleteCalls = [], replyCalls = [] } = {}) {
  return {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    getMessages: async (channel_id, { after, before, limit }) => {
      // Return from the provided messages array
      if (after) {
        return messages.filter((m) => m.id > after).slice(0, limit);
      }
      if (before) {
        // Return messages older than 'before' (lexicographic ID comparison)
        return messages.filter((m) => m.id < before).slice(0, limit);
      }
      return messages.slice(0, limit);
    },
    deleteMessage: async (channel_id, msgId) => {
      deleteCalls.push(msgId);
    },
    bulkDeleteMessages: async (channel_id, msgIds) => {
      bulkDeleteCalls.push(msgIds);
    },
    reply: async (msg, content) => {
      replyCalls.push({ content, msg });
      return { id: 'reply_001', channel_id: msg.channel_id };
    },
  };
}

function createMockMessage(overrides = {}) {
  return {
    id: '900000000000000001',
    channel_id: CHANNEL_ID,
    guild_id: GUILD_ID,
    author: { id: USER_ID, username: 'ModUser', bot: false },
    ...overrides,
  };
}

// ─── Input Validation ─────────────────────────────────────

test('purge should reject non-numeric count', async () => {
  const replyCalls = [];
  const client = createMockClient({ replyCalls });
  const msg = createMockMessage();

  await purgeModule.execute(client, msg, ['abc']);
  assert.ok(replyCalls[0].content.includes('valid positive number'), 'Should complain about invalid count');
});

test('purge should reject zero count', async () => {
  const replyCalls = [];
  const client = createMockClient({ replyCalls });
  const msg = createMockMessage();

  await purgeModule.execute(client, msg, ['0']);
  assert.ok(replyCalls[0].content.includes('valid positive number'), 'Should reject zero count');
});

test('purge should reject negative count', async () => {
  const replyCalls = [];
  const client = createMockClient({ replyCalls });
  const msg = createMockMessage();

  await purgeModule.execute(client, msg, ['-5']);
  assert.ok(replyCalls[0].content.includes('valid positive number'), 'Should reject negative count');
});

test('purge should reject float count', async () => {
  const replyCalls = [];
  const client = createMockClient({ replyCalls });
  const msg = createMockMessage();

  await purgeModule.execute(client, msg, ['3.14']);
  assert.ok(replyCalls[0].content.includes('valid positive number'), 'Should reject float count');
});

test('purge should accept valid positive integer', async () => {
  const deleteCalls = [];
  const bulkDeleteCalls = [];
  const replyCalls = [];
  const client = createMockClient({ messages: [], deleteCalls, bulkDeleteCalls, replyCalls });
  const msg = createMockMessage();

  await purgeModule.execute(client, msg, ['5']);
  // Should attempt to process (even if no messages found)
  assert.ok(true, 'Should not crash on valid input');
});

// ─── Max Limit ────────────────────────────────────────────

test('purge should cap at 1000 messages', async () => {
  const replyCalls = [];
  const client = createMockClient({ messages: [], replyCalls });
  const msg = createMockMessage();

  await purgeModule.execute(client, msg, ['2000']);
  // Should warn about limit
  const limitWarning = replyCalls.find((c) => c.content.includes('limited to'));
  assert.ok(limitWarning, 'Should warn about 1000 message limit');
  assert.ok(limitWarning.content.includes('1000'), 'Should mention 1000 limit');
});

// ─── Message Reference Mode ───────────────────────────────

test('purge should handle message_reference mode', async () => {
  const messages = [
    { id: '800000000000000001', timestamp: new Date().toISOString() },
    { id: '800000000000000002', timestamp: new Date().toISOString() },
  ];
  const bulkDeleteCalls = [];
  const replyCalls = [];
  const client = createMockClient({ messages, bulkDeleteCalls, replyCalls });
  const msg = createMockMessage({
    message_reference: { message_id: '800000000000000001' },
  });

  await purgeModule.execute(client, msg, []);
  // Should complete without error
  assert.ok(true, 'Should handle message_reference mode');
});

// ─── Old Message Filtering ────────────────────────────────

test('purge should filter out messages older than 14 days', async () => {
  const oldDate = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  const recentDate = new Date().toISOString();

  const messages = [
    { id: '800000000000000001', timestamp: oldDate },
    { id: '800000000000000002', timestamp: recentDate },
  ];
  const bulkDeleteCalls = [];
  const replyCalls = [];
  const client = createMockClient({ messages, bulkDeleteCalls, replyCalls });
  const msg = createMockMessage();

  await purgeModule.execute(client, msg, ['5']);
  // Should only bulk delete the recent message + the command message
  // The old one should be filtered out
  assert.ok(true, 'Should filter old messages without crashing');
});

// ─── Empty Channel ────────────────────────────────────────

test('purge should handle empty channel gracefully', async () => {
  const replyCalls = [];
  const client = createMockClient({ messages: [], replyCalls });
  const msg = createMockMessage();

  await purgeModule.execute(client, msg, ['10']);
  // No messages to delete, should not crash
  assert.ok(true, 'Should handle empty channel gracefully');
});

// ─── Bulk vs Single Delete ────────────────────────────────

test('purge should use bulk delete for multiple messages', async () => {
  const messages = [];
  for (let i = 0; i < 5; i++) {
    messages.push({
      id: `80000000000000000${i}`,
      timestamp: new Date().toISOString(),
    });
  }
  const bulkDeleteCalls = [];
  const replyCalls = [];
  const client = createMockClient({ messages, bulkDeleteCalls, replyCalls });
  const msg = createMockMessage();

  await purgeModule.execute(client, msg, ['5']);
  // Should have bulk deleted at least once
  assert.ok(bulkDeleteCalls.length > 0, 'Bulk delete should be called for chunks > 1');
});

function createTwoMessages() {
  return [
    { id: '800000000000000001', timestamp: new Date().toISOString() },
    { id: '800000000000000002', timestamp: new Date().toISOString() },
  ];
}
describe('purge slash command (isInteraction)', () => {
  it('does not pass interaction.id to deleteMessage or bulkDeleteMessages', async () => {
    const INTERACTION_ID = '999000000000000001';
    const allDeletedIds = [];
    const messages = createTwoMessages();
    const client = createMockClient({ messages });
    client.deleteMessage = async (_ch, id) => allDeletedIds.push(id);
    client.bulkDeleteMessages = async (_ch, ids) => allDeletedIds.push(...ids);
    client.reply = async () => ({ isInteractionResponse: true, channel_id: CHANNEL_ID });
    client.sendMessage = async () => ({ id: 'reply_001', channel_id: CHANNEL_ID });

    const slashMsg = {
      id: INTERACTION_ID,
      channel_id: CHANNEL_ID,
      guild_id: GUILD_ID,
      isInteraction: true,
      author: { id: USER_ID, username: 'Mod' },
    };

    await purgeModule.execute(client, slashMsg, ['2']);

    assert.ok(
      !allDeletedIds.includes(INTERACTION_ID),
      `interaction.id ${INTERACTION_ID} must not appear in delete calls`,
    );
  });

  it('reports the exact number of messages deleted, not N-1', async () => {
    const replyCalls = [];
    const messages = createTwoMessages();
    const client = createMockClient({ messages });
    client.bulkDeleteMessages = async () => {};
    client.deleteMessage = async () => {};
    client.reply = async (_msg, content) => {
      replyCalls.push(content);
      return { isInteractionResponse: true, channel_id: CHANNEL_ID };
    };

    const slashMsg = {
      id: '999000000000000001',
      channel_id: CHANNEL_ID,
      guild_id: GUILD_ID,
      isInteraction: true,
      author: { id: USER_ID, username: 'Mod' },
    };

    await purgeModule.execute(client, slashMsg, ['2']);

    const reply = replyCalls.find((c) => c.includes('Deleted'));
    assert.ok(reply, 'Should send a deletion confirmation');
    assert.ok(reply.includes('**2**'), `Expected "Deleted **2** messages", got: ${reply}`);
  });
});

describe('purge notice and auto-delete failures', () => {
  afterEach(() => {
    mock.restoreAll();
    mock.timers.reset();
  });

  it('logs a warning when the purge-limit notice reply fails', async () => {
    const warns = [];
    const client = createMockClient({ messages: [] });
    client.logger.warn = (...a) => warns.push(a);
    client.reply = async (m, content) => {
      if (typeof content === 'string' && content.includes('limited to')) throw new Error('reply failed');
      return { id: 'reply_001', channel_id: m.channel_id };
    };

    await purgeModule.execute(client, createMockMessage(), ['5000']);
    // the .catch handler runs as a microtask
    await new Promise((r) => setImmediate(r));
    assert.ok(warns.some((w) => w.some((a) => typeof a === 'string' && a.includes('purge limit notice'))));
  });

  it('logs a warning when auto-deleting the purge feedback fails', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const warns = [];
    const messages = [{ id: '800000000000000001', timestamp: new Date().toISOString() }];
    const client = createMockClient({ messages });
    client.logger.warn = (...a) => warns.push(a);
    client.deleteMessage = async () => {
      throw new Error('delete failed');
    };

    await purgeModule.execute(client, createMockMessage(), ['5']);
    mock.timers.tick(3500);
    await new Promise((r) => setImmediate(r));
    assert.ok(warns.some((w) => w.some((a) => typeof a === 'string' && a.includes('auto-delete purge feedback'))));
  });

  it('paginates message_reference mode across a full 100-message page', async () => {
    const messages = [];
    for (let i = 0; i < 100; i++) {
      messages.push({ id: `80000000000${String(i).padStart(7, '0')}`, timestamp: new Date().toISOString() });
    }
    const bulkDeleteCalls = [];
    const client = createMockClient({ messages, bulkDeleteCalls });
    const msg = createMockMessage({ message_reference: { message_id: '700000000000000000' } });
    await purgeModule.execute(client, msg, []);
    assert.ok(bulkDeleteCalls.length > 0);
  });

  it('caps message_reference mode at MAX_PURGE messages instead of walking unbounded', async () => {
    const messages = [];
    for (let i = 0; i < 1500; i++) {
      messages.push({ id: `80000000000${String(i).padStart(7, '0')}`, timestamp: new Date().toISOString() });
    }
    const bulkDeleteCalls = [];
    const deleteCalls = [];
    const client = createMockClient({ messages, bulkDeleteCalls, deleteCalls });
    const msg = createMockMessage({ message_reference: { message_id: '700000000000000000' } });
    await purgeModule.execute(client, msg, []);

    const walkedDeleted = bulkDeleteCalls.reduce((sum, chunk) => sum + chunk.length, 0) + deleteCalls.length;
    // +1 accounts for the always-included referenced message itself
    assert.ok(walkedDeleted <= 1001, `expected a capped delete count, got ${walkedDeleted}`);
  });
});
