import test from 'node:test';
import assert from 'node:assert';
import handleMessage from '../../src/events/message_create.js';

// Use realistic Discord snowflake IDs (numeric strings)
const BOT_ID = '112233445566778899';
const USER_001 = '100000000000000001';
const USER_999 = '100000000000000999';
const CHANNEL_ID = '200000000000000001';
const GUILD_ID = '300000000000000001';

/**
 * Create a mock client for testing.
 */
function createMockClient({ userId = BOT_ID, hasStore = true, hasCommands = {} } = {}) {
  const store = new Map();

  return {
    _session: { user: { id: userId } },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    tempDM: new Map(),
    commands: hasCommands,
    store: hasStore
      ? {
          get: async (key) => store.get(key),
          set: async (key, value) => {
            store.set(key, value);
          },
          delete: async (key) => {
            store.delete(key);
          },
          has: async (key) => store.has(key),
        }
      : null,
    deleteMessage: async () => {},
    sendMessage: async (channel_id, _content) => ({ id: 'warn_placeholder', channel_id }),
    getGuildMember: async () => ({ roles: [] }),
    getRoles: async () => [],
    reply: async (msg, _content) => ({ id: 'reply_placeholder', channel_id: msg.channel_id }),
  };
}

/**
 * Create a mock message object for testing.
 */
function createMockMessage(overrides = {}) {
  return {
    id: '900000000000000001',
    channel_id: CHANNEL_ID,
    guild_id: GUILD_ID,
    content: '',
    author: { id: USER_001, username: 'TestUser', bot: false, global_name: 'TestUser' },
    attachments: [],
    ...overrides,
  };
}

// ─── Basic Filtering ───────────────────────────────────────

test('should ignore bot messages', async () => {
  const client = createMockClient();
  const msg = createMockMessage({ author: { id: 'bot_abc', username: 'SomeBot', bot: true } });

  const result = await handleMessage(client, msg);
  assert.strictEqual(result, undefined);
});

test('should ignore self messages', async () => {
  const client = createMockClient({ userId: USER_001 });
  const msg = createMockMessage({ author: { id: USER_001, username: 'Bot', bot: false } });

  const result = await handleMessage(client, msg);
  assert.strictEqual(result, undefined);
});

// ─── Anti-Link ──────────────────────────────────────────────

test('should allow whitelisted domains', async () => {
  let deleted = false;
  const client = createMockClient();
  client.deleteMessage = async () => {
    deleted = true;
  };
  client.getGuildMember = async () => ({ roles: [] });
  client.getRoles = async () => [];

  const msg = createMockMessage({
    content: 'Check this out https://github.com/af-t/disco',
    member: { roles: [] },
  });

  await handleMessage(client, msg);
  assert.strictEqual(deleted, false, 'Whitelisted domain should not be deleted');
});

test('should block disallowed domains for non-mod users', async () => {
  let deleted = false;
  let warned = false;
  const client = createMockClient();
  client.deleteMessage = async () => {
    deleted = true;
  };
  client.sendMessage = async (ch, content) => {
    if (content.includes('not allowed')) warned = true;
    return { id: 'warn_001', channel_id: ch };
  };
  client.getGuildMember = async () => ({ roles: [] });
  client.getRoles = async () => [];

  const msg = createMockMessage({
    content: 'Visit http://malicious-site.xyz now!',
  });

  await handleMessage(client, msg);
  assert.strictEqual(deleted, true, 'Disallowed domain should trigger delete');
  assert.strictEqual(warned, true, 'Warning message should be sent');
});

test('should allow disallowed domains for admin users', async () => {
  let deleted = false;
  const client = createMockClient();
  client.deleteMessage = async () => {
    deleted = true;
  };
  client.getGuildMember = async () => ({
    roles: ['admin_role'],
  });
  client.getRoles = async () => [
    { id: 'admin_role', permissions: '8' }, // ADMINISTRATOR permission
  ];

  const msg = createMockMessage({
    content: 'Visit http://suspicious-site.example.com',
  });

  await handleMessage(client, msg);
  assert.strictEqual(deleted, false, 'Admin messages should bypass anti-link');
});

test('should handle multiple URLs where one is disallowed', async () => {
  let deleted = false;
  const client = createMockClient();
  client.deleteMessage = async () => {
    deleted = true;
  };
  client.sendMessage = async (ch, _content) => ({ id: 'warn_001', channel_id: ch });
  client.getGuildMember = async () => ({ roles: [] });
  client.getRoles = async () => [];

  const msg = createMockMessage({
    content: 'https://github.com and http://evil-site.com',
  });

  await handleMessage(client, msg);
  assert.strictEqual(deleted, true, 'Mixed URLs with disallowed should be blocked');
});

test('should allow messages with no URLs', async () => {
  let deleted = false;
  const client = createMockClient();
  client.deleteMessage = async () => {
    deleted = true;
  };

  const msg = createMockMessage({ content: 'Just a normal message, no links here!' });

  await handleMessage(client, msg);
  assert.strictEqual(deleted, false);
});

// ─── Anti-Spam ─────────────────────────────────────────────

test('should delete repetitive messages (anti-spam)', async () => {
  let deleted = false;
  const client = createMockClient();
  client.deleteMessage = async () => {
    deleted = true;
  };

  const msg = createMockMessage({
    content: 'Hello everyone!', // > 5 chars
  });

  // First message should be stored
  await handleMessage(client, msg);
  assert.strictEqual(deleted, false, 'First message should not be deleted');

  // Second identical message should be deleted
  deleted = false;
  await handleMessage(client, msg);
  assert.strictEqual(deleted, true, 'Duplicate message should be deleted');
});

test('should NOT delete short repetitive messages (<= 5 chars)', async () => {
  // eslint-disable-next-line no-useless-assignment
  let deleted = false;
  const client = createMockClient();
  client.deleteMessage = async () => {
    deleted = true;
  };

  const msg = createMockMessage({ content: 'Hi' }); // < 5 chars

  await handleMessage(client, msg);
  deleted = false;
  await handleMessage(client, msg);
  assert.strictEqual(deleted, false, 'Short repetitive messages should be allowed');
});

// ─── Anti-Spam Normalization (fix M2) ───────────────────────

test('should detect spam with collapsed whitespace (normalization)', async () => {
  let deleted = false;
  const client = createMockClient();
  client.deleteMessage = async () => {
    deleted = true;
  };

  // First message: "Hello   World" (multiple spaces)
  const msg1 = createMockMessage({ content: 'Hello   World' });
  await handleMessage(client, msg1);
  assert.strictEqual(deleted, false, 'First message should not be deleted');

  // Second message: "hello world" — normalized, should match
  deleted = false;
  const msg2 = createMockMessage({ content: 'hello world' });
  await handleMessage(client, msg2);
  assert.strictEqual(deleted, true, 'Normalized duplicate (whitespace collapse + lowercase) should be deleted');
});

test('should detect spam regardless of case (normalization)', async () => {
  let deleted = false;
  const client = createMockClient();
  client.deleteMessage = async () => {
    deleted = true;
  };

  // First message: "SPAM"
  const msg1 = createMockMessage({ content: 'SPAM MESSAGE' });
  await handleMessage(client, msg1);
  assert.strictEqual(deleted, false, 'First message should not be deleted');

  // Second message: "spam message" — normalized (lowercase), should match
  deleted = false;
  const msg2 = createMockMessage({ content: 'spam message' });
  await handleMessage(client, msg2);
  assert.strictEqual(deleted, true, 'Normalized duplicate (case-insensitive) should be deleted');
});

// ─── AFK Detection ─────────────────────────────────────────

test('should clear AFK status when user sends a message', async () => {
  const client = createMockClient();
  let sentMessage = '';
  client.sendMessage = async (ch, content) => {
    sentMessage = content;
    return { id: 'afk_reply', channel_id: ch };
  };

  // First, set user as AFK
  await client.store.set(`afk:${GUILD_ID}:${USER_001}`, {
    message: 'Busy coding',
    since: Date.now(),
  });

  const msg = createMockMessage({ content: "I'm back!" });
  await handleMessage(client, msg);

  // Check AFK was cleared
  const afkData = await client.store.get(`afk:${GUILD_ID}:${USER_001}`);
  assert.strictEqual(afkData, undefined, 'AFK status should be cleared');

  // Check welcome back message
  assert.ok(sentMessage.includes('Welcome back'), 'Should send welcome back message');
  assert.ok(sentMessage.includes('TestUser'), 'Should include username');
});

test('should notify when mentioning an AFK user', async () => {
  const client = createMockClient();
  let sentMessage = '';
  client.sendMessage = async (ch, content) => {
    sentMessage = content;
    return { id: 'afk_mention', channel_id: ch };
  };

  // Set another user as AFK
  await client.store.set(`afk:${GUILD_ID}:${USER_999}`, {
    message: 'Away from keyboard',
    since: Date.now(),
  });

  const msg = createMockMessage({
    content: `<@${USER_999}> need your help!`,
    author: { id: USER_001, username: 'ActiveUser', bot: false, global_name: 'ActiveUser' },
  });

  await handleMessage(client, msg);
  assert.ok(sentMessage.includes('AFK'), 'Should notify about AFK user');
  assert.ok(sentMessage.includes(`<@${USER_999}>`), 'Should mention the AFK user');
});

// ─── Command Prefix Parsing ─────────────────────────────────

test('should parse prefixed commands (.command)', async () => {
  let executed = false;
  const client = createMockClient({
    hasCommands: {
      ping: async () => {
        executed = true;
      },
    },
  });

  const msg = createMockMessage({ content: '.ping' });
  await handleMessage(client, msg);
  assert.strictEqual(executed, true, 'Command should be executed');
});

test('should parse prefixed commands with args (.command arg1 arg2)', async () => {
  let executedArgs = [];
  const client = createMockClient({
    hasCommands: {
      echo: async (client, msg, args) => {
        executedArgs = args;
      },
    },
  });

  const msg = createMockMessage({ content: '.echo hello world' });
  await handleMessage(client, msg);
  assert.deepStrictEqual(executedArgs, ['hello', 'world']);
});

test('should parse .command subcommand', async () => {
  let executedArgs = [];
  const client = createMockClient({
    hasCommands: {
      ban: async (client, msg, args) => {
        executedArgs = args;
      },
    },
  });

  const msg = createMockMessage({ content: '.ban <@100000000000000999> spamming' });
  await handleMessage(client, msg);
  assert.ok(executedArgs.length >= 2, 'Args should contain user and reason');
});

// ─── Rate Limiting ──────────────────────────────────────────

test('should enforce rate limit (max 5 commands/sec)', async () => {
  let executedCount = 0;
  const client = createMockClient({
    hasCommands: {
      ping: async () => {
        executedCount++;
      },
    },
  });
  client.sendMessage = async () => ({ id: 'rate_limit_msg', channel_id: CHANNEL_ID });

  const msg = createMockMessage({ content: '.ping' });

  // Execute 6 times rapidly (limit is 5 for default commands)
  for (let i = 0; i < 6; i++) {
    await handleMessage(client, msg);
  }

  // Only 5 should have executed (the 6th should be rate limited)
  assert.strictEqual(executedCount, 5, 'Only 5 out of 6 commands should execute');
});

test('should enforce stricter rate limit for AI commands', async () => {
  let executedCount = 0;
  const client = createMockClient({
    hasCommands: {
      ai: async () => {
        executedCount++;
      },
    },
  });
  client.sendMessage = async () => ({ id: 'rate_limit_msg', channel_id: CHANNEL_ID });

  // Use different message content each time to bypass anti-spam dedup
  const messages = ['.ai tell me a joke', '.ai what is the weather', '.ai how are you today'];

  for (let i = 0; i < 3; i++) {
    const msg = createMockMessage({ content: messages[i] });
    await handleMessage(client, msg);
  }

  // Only 2 should have executed (the 3rd should be rate limited)
  assert.strictEqual(executedCount, 2, 'Only 2 out of 3 AI commands should execute');
});

// ─── Fallback to AI Command ─────────────────────────────────

test('should call AI command when bot is mentioned', async () => {
  let aiCalled = false;
  const client = createMockClient({
    hasCommands: {
      ai: async () => {
        aiCalled = true;
      },
    },
  });

  const msg = createMockMessage({
    content: `<@${BOT_ID}> what is the weather today?`,
  });
  await handleMessage(client, msg);
  assert.strictEqual(aiCalled, true, 'AI command should be called on mention');
});
