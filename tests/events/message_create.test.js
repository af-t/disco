import test, { describe, it, mock, afterEach } from 'node:test';
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

// ── Anti-link moderation (additional coverage) ────────────────────────────────
describe('message_create anti-link', () => {
  afterEach(() => {
    mock.restoreAll();
    mock.timers.reset();
  });

  it('deletes message with disallowed link (non-mod user)', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const client = createMockClient();
    const deleted = [];
    client.deleteMessage = async (cid, mid) => {
      deleted.push(mid);
    };
    client.sendMessage = async () => ({ id: 'warn-msg' });

    const m = createMockMessage({ content: 'check this http://evil.example.com' });
    await handleMessage(client, m);
    assert.ok(deleted.includes(m.id));
  });

  it('allows disallowed link for user with MANAGE_MESSAGES', async () => {
    // MANAGE_MESSAGES = 1 << 13 = 8192
    const client = createMockClient();
    client.getRoles = async () => [{ id: 'r1', permissions: String(8192) }];
    client.getGuildMember = async () => ({ roles: ['r1'] });
    const deleted = [];
    client.deleteMessage = async (cid, mid) => {
      deleted.push(mid);
    };

    const m = createMockMessage({ content: 'http://evil.example.com' });
    await handleMessage(client, m);
    assert.strictEqual(deleted.length, 0);
  });

  it('allows message with only allowlisted domains', async () => {
    const client = createMockClient();
    const deleted = [];
    client.deleteMessage = async (cid, mid) => {
      deleted.push(mid);
    };

    const m = createMockMessage({ content: 'https://github.com/foo' });
    await handleMessage(client, m);
    assert.strictEqual(deleted.length, 0);
  });
});

// ── Anti-spam (additional coverage) ──────────────────────────────────────────
describe('message_create anti-spam', () => {
  it('deletes repeated message (length > 5)', async () => {
    const client = createMockClient();
    const deleted = [];
    client.deleteMessage = async (cid, mid) => {
      deleted.push(mid);
    };

    const content = 'repeated spam message';
    const m1 = createMockMessage({ content });
    const m2 = createMockMessage({ id: 'msg-002', content });

    await handleMessage(client, m1);
    await handleMessage(client, m2);
    assert.ok(deleted.includes('msg-002'));
  });

  it('does not delete when content length <= 5', async () => {
    const client = createMockClient();
    const deleted = [];
    client.deleteMessage = async (cid, mid) => {
      deleted.push(mid);
    };

    const m1 = createMockMessage({ content: 'hi' });
    const m2 = createMockMessage({ id: 'msg-002', content: 'hi' });

    await handleMessage(client, m1);
    await handleMessage(client, m2);
    assert.strictEqual(deleted.length, 0);
  });
});

// ── AFK hooks (additional coverage) ──────────────────────────────────────────
describe('message_create AFK hooks', () => {
  afterEach(() => {
    mock.restoreAll();
    mock.timers.reset();
  });

  it('clears own AFK and sends welcome back message', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const client = createMockClient();
    const since = Date.now() - 60_000;
    await client.store.set(`afk:${GUILD_ID}:${USER_001}`, { since, message: 'sleeping' });

    const sent = [];
    client.sendMessage = async (cid, content) => {
      sent.push(typeof content === 'string' ? content : JSON.stringify(content));
      return { id: 'w' };
    };
    client.deleteMessage = async () => {};

    const m = createMockMessage({ content: 'im back' });
    await handleMessage(client, m);

    assert.ok(sent.some((s) => s.includes('Welcome back')));
    assert.strictEqual(await client.store.get(`afk:${GUILD_ID}:${USER_001}`), undefined);
  });

  it('notifies about AFK-mentioned user', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    // Use a different user id than USER_001 to avoid self-AFK clear
    const OTHER_USER = '999999999999999999';
    const client = createMockClient();
    const since = Date.now() - 30_000;
    await client.store.set(`afk:${GUILD_ID}:${OTHER_USER}`, { since, message: 'brb' });

    const sent = [];
    client.sendMessage = async (cid, content) => {
      sent.push(typeof content === 'string' ? content : JSON.stringify(content));
      return { id: 'w' };
    };
    client.deleteMessage = async () => {};

    const m = createMockMessage({ content: `hey <@${OTHER_USER}>` });
    await handleMessage(client, m);

    // Should send the AFK notification line with "is AFK"
    assert.ok(sent.some((s) => s.includes('is AFK')));
  });

  it('skips self-mention in AFK notify', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const client = createMockClient();
    // user is AFK but mentions themselves; notify should not fire for self
    await client.store.set(`afk:${GUILD_ID}:${USER_001}`, { since: Date.now(), message: 'away' });
    const sent = [];
    client.sendMessage = async (cid, content) => {
      sent.push(typeof content === 'string' ? content : JSON.stringify(content));
      return { id: 'w' };
    };
    client.deleteMessage = async () => {};

    // message mentions self (USER_001) while USER_001 is AFK
    const m = createMockMessage({ content: `hey <@${USER_001}>` });
    await handleMessage(client, m);

    // AFK notify skipped for self-mention; only welcome-back may fire
    const afkNotifications = sent.filter((s) => s.includes('is AFK'));
    assert.strictEqual(afkNotifications.length, 0);
  });
});

// ── Rate limiting (additional coverage) ───────────────────────────────────────
describe('message_create rate limiting', () => {
  afterEach(() => {
    mock.restoreAll();
    mock.timers.reset();
  });

  it('sends rate limit reply after DEFAULT threshold', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const client = createMockClient({
      hasCommands: {
        // unknowncmd has no permissions so DEFAULT rate applies
        unknowncmd: async () => {},
      },
    });
    const replies = [];
    client.sendMessage = async (cid, content) => {
      replies.push(typeof content === 'string' ? content : '');
      return { id: 'r' };
    };
    client.deleteMessage = async () => {};

    // fire 6 messages rapidly (DEFAULT = 5/s); 6th triggers rate limit
    for (let i = 0; i < 6; i++) {
      await handleMessage(client, createMockMessage({ content: `.unknowncmd arg${i}` }));
    }
    // Should have sent a rate-limit notice
    assert.ok(replies.some((r) => r.includes('slow down')));
  });
});

// ── parseMessage formats (additional coverage) ────────────────────────────────
describe('message_create parseMessage formats', () => {
  afterEach(() => mock.restoreAll());

  it('bot mention triggers AI command', async () => {
    const aiCalls = [];
    const client = createMockClient({
      hasCommands: {
        ai: async () => {
          aiCalls.push(1);
        },
      },
    });
    const botId = client._session.user.id;
    const m = createMockMessage({ content: `<@${botId}> hello there` });
    await handleMessage(client, m);
    assert.strictEqual(aiCalls.length, 1);
  });

  it('prefix with space (". cmd") parses correctly', async () => {
    const executed = [];
    const client = createMockClient({
      hasCommands: {
        help: async () => {
          executed.push(1);
        },
      },
    });
    // ". help" format (prefix as standalone token)
    const m = createMockMessage({ content: '. help' });
    await handleMessage(client, m);
    assert.strictEqual(executed.length, 1);
  });
});

// ── Permission check (additional coverage) ────────────────────────────────────
describe('message_create permission check', () => {
  afterEach(() => mock.restoreAll());

  it('denies permissioned command when user lacks role', async () => {
    const replies = [];
    const client = createMockClient();
    // command with permissions declared
    client.commands.ban = Object.assign(async () => {}, {
      permissions: ['BAN_MEMBERS'],
    });
    client.reply = async (m, content) => {
      replies.push(typeof content === 'string' ? content : JSON.stringify(content));
    };
    client.getRoles = async () => [{ id: 'r1', permissions: '0' }];
    client.getGuildMember = async () => ({ roles: ['r1'] });

    await handleMessage(client, createMockMessage({ content: '.ban someone' }));
    assert.ok(replies.some((r) => r.includes('permission')));
  });

  it('ADMINISTRATOR bypasses specific permission', async () => {
    const executed = [];
    const client = createMockClient();
    client.commands.ban = Object.assign(
      async () => {
        executed.push(1);
      },
      {
        permissions: ['BAN_MEMBERS'],
      },
    );
    // ADMINISTRATOR = 1 << 3 = 8
    client.getRoles = async () => [{ id: 'r1', permissions: '8' }];
    client.getGuildMember = async () => ({ roles: ['r1'] });

    await handleMessage(client, createMockMessage({ content: '.ban someone' }));
    assert.strictEqual(executed.length, 1);
  });

  it('denies permissioned command in DMs (non-guild, naturalMode)', async () => {
    const replies = [];
    const client = createMockClient();
    // naturalMode active so parseDMCommand runs and returns a cmd
    client.aiRuntime = { onMessage: async () => {} };
    client.commands.ban = Object.assign(async () => {}, {
      permissions: ['BAN_MEMBERS'],
    });
    client.reply = async (m, content) => {
      replies.push(typeof content === 'string' ? content : JSON.stringify(content));
    };
    // DM: no guild_id — permissions block should deny since !isGuildMessage
    await handleMessage(client, createMockMessage({ content: '.ban someone', guild_id: undefined }));
    assert.ok(replies.some((r) => r.includes('permission')));
  });
});

// ── naturalMode DM ─────────────────────────────────────────────────────────────
describe('message_create naturalMode DM', () => {
  it('dispatches DM to aiRuntime.onMessage when naturalMode active', async () => {
    const onMessageCalls = [];
    const client = createMockClient();
    client.aiRuntime = {
      onMessage: async (m) => {
        onMessageCalls.push(m);
      },
    };

    // guild_id undefined = DM; with aiRuntime set, parseDMCommand runs then naturalMode path fires
    const m = createMockMessage({ content: 'hello', guild_id: undefined });
    await handleMessage(client, m);
    assert.strictEqual(onMessageCalls.length, 1);
  });

  it('executes DM prefix command when naturalMode active', async () => {
    const executed = [];
    const client = createMockClient();
    client.aiRuntime = { onMessage: async () => {} };
    client.commands.ping = async () => {
      executed.push(1);
    };

    // .ping in DM with aiRuntime — parseDMCommand finds cmd, executes it
    const m = createMockMessage({ content: '.ping', guild_id: undefined });
    await handleMessage(client, m);
    assert.strictEqual(executed.length, 1);
  });
});

// ── parseDM timer (lines 18-36, 222-223) ──────────────────────────────────────
describe('message_create parseDM timer', () => {
  afterEach(() => {
    mock.restoreAll();
    mock.timers.reset();
  });

  it('batches DM content and resolves after 7s timer', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const aiCalls = [];
    const client = createMockClient({
      hasCommands: {
        ai: async (c, m, a, raw) => {
          aiCalls.push(raw);
        },
      },
    });
    // no aiRuntime → parseDM path (!isGuildMessage && !naturalMode)

    const m = createMockMessage({ content: 'hello world', guild_id: undefined });
    // handleMessage awaits parseDM which awaits the 7s setTimeout
    const handlePromise = handleMessage(client, m);

    // Tick the mocked timer to fire the 7000ms callback
    mock.timers.tick(7000);
    // Drain the microtask/macrotask queue so the promise resolves
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    await handlePromise;
    assert.strictEqual(aiCalls.length, 1);
    assert.ok(aiCalls[0].includes('hello world'));
  });

  it('returns {} immediately for second DM while reading=true', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const client = createMockClient({
      hasCommands: { ai: async () => {} },
    });

    const m1 = createMockMessage({ content: 'first message', guild_id: undefined });
    const m2 = createMockMessage({ content: 'second message', guild_id: undefined });

    // Start first DM — sets reading=true then waits for the 7s timer
    const p1 = handleMessage(client, m1);

    // Second DM while reading=true → parseDM returns {} immediately, handler returns
    const p2 = handleMessage(client, m2);
    await p2; // resolves immediately because parsed = {} → no cmd, no useAI

    // Tick timer to let first promise resolve too
    mock.timers.tick(7000);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await p1;
  });
});

// ── parseMessage standalone ". " prefix (lines 51-52) ─────────────────────────
describe('message_create parseMessage dot-space no command', () => {
  afterEach(() => mock.restoreAll());

  it('returns early when message is just a standalone period with no command', async () => {
    const client = createMockClient();
    // ". " — prefix is a standalone token but nothing follows it
    const m = createMockMessage({ content: '. ' });
    const result = await handleMessage(client, m);
    // no cmd, no useAI → handler falls through silently
    assert.strictEqual(result, undefined);
  });
});

// ── anti-link invalid URL catch block (lines 130-131) ─────────────────────────
describe('message_create anti-link invalid URL catch', () => {
  afterEach(() => {
    mock.restoreAll();
    mock.timers.reset();
  });

  it('treats malformed URL where new URL() throws as disallowed', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const deleted = [];
    const client = createMockClient();
    client.deleteMessage = async (cid, mid) => {
      deleted.push(mid);
    };
    client.sendMessage = async () => ({ id: 'warn1' });
    client.getGuildMember = async () => ({ roles: [] });
    client.getRoles = async () => [];

    // https://bad[bracket matches the URL regex but new URL() throws a TypeError
    const m = createMockMessage({ content: 'check this: https://bad[bracket' });
    await handleMessage(client, m);
    // invalid URL treated as disallowed → message deleted
    assert.ok(deleted.includes(m.id));
  });
});

// ── rate limit counter reset (lines 242-245) ──────────────────────────────────
describe('message_create rate limit counter reset', () => {
  afterEach(() => mock.restoreAll());

  it('resets rate limit counter when last command was > 1 second ago', async () => {
    const executed = [];
    const client = createMockClient({
      hasCommands: {
        ping: async () => {
          executed.push(1);
        },
      },
    });

    // Pre-populate the store with an old timestamp (2s ago) and saturated count
    const oldCached = {
      notified: false,
      time: Date.now() - 2000, // 2 seconds ago → window expired
      count: 10, // artificially high — would normally block
    };
    await client.store.set(`request_limit:${USER_001}`, oldCached, true);

    const m = createMockMessage({ content: '.ping' });
    await handleMessage(client, m);

    // Counter was reset (count went from 10 → 1 after reset), so command executes
    assert.strictEqual(executed.length, 1);
  });
});

// ── member with no roles denies permissioned command (line 265) ───────────────
describe('message_create member with no roles', () => {
  afterEach(() => mock.restoreAll());

  it('denies permissioned command when getGuildMember returns member without roles', async () => {
    const replies = [];
    const client = createMockClient();
    client.commands.ban = Object.assign(async () => {}, {
      permissions: ['BAN_MEMBERS'],
    });
    client.reply = async (m, content) => {
      replies.push(content);
    };
    // member object exists but has no .roles property → !member?.roles is true
    client.getGuildMember = async () => ({ id: 'u1' });

    const m = createMockMessage({ content: '.ban target' });
    await handleMessage(client, m);

    assert.ok(replies.some((r) => typeof r === 'string' && r.includes('permission')));
  });
});

// ── unknown permission flag warning (lines 278-280) ───────────────────────────
describe('message_create unknown permission flag', () => {
  afterEach(() => mock.restoreAll());

  it('warns and denies command when permission name is not in permissionFlags', async () => {
    const warnings = [];
    const replies = [];
    const client = createMockClient();
    client.commands.special = Object.assign(async () => {}, {
      permissions: ['TOTALLY_FAKE_PERM'],
    });
    client.logger.warn = (...args) => {
      warnings.push(args.join(' '));
    };
    client.reply = async (m, content) => {
      replies.push(content);
    };
    client.getGuildMember = async () => ({ roles: ['r1'] });
    client.getRoles = async () => [{ id: 'r1', permissions: '0' }];

    const m = createMockMessage({ content: '.special arg' });
    await handleMessage(client, m);

    assert.ok(warnings.some((w) => w.includes('Unknown permission')));
    assert.ok(replies.some((r) => typeof r === 'string' && r.includes('permission')));
  });
});

// ── commands.ai fallback for unknown command (lines 296-298) ──────────────────
describe('message_create commands.ai fallback', () => {
  afterEach(() => mock.restoreAll());

  it('calls commands.ai when the command is not in client.commands', async () => {
    const aiCalls = [];
    const client = createMockClient({
      hasCommands: {
        ai: async (c, m, a, raw) => {
          aiCalls.push(raw);
        },
      },
    });
    // 'nonexistent' is not in client.commands, but commands.ai exists

    const m = createMockMessage({ content: '.nonexistent some args' });
    await handleMessage(client, m);

    assert.strictEqual(aiCalls.length, 1);
  });
});

describe('message_create extra coverage', () => {
  afterEach(() => {
    mock.restoreAll();
    mock.timers.reset();
  });

  it('handles a naturalMode DM with no content', async () => {
    const calls = [];
    const client = createMockClient();
    client.aiRuntime = { onMessage: async (m) => calls.push(m) };
    await handleMessage(client, createMockMessage({ content: undefined, guild_id: undefined }));
    assert.strictEqual(calls.length, 1);
  });

  it('handles a naturalMode DM that is just a bare prefix', async () => {
    const client = createMockClient();
    client.aiRuntime = { onMessage: async () => {} };
    const result = await handleMessage(client, createMockMessage({ content: '.', guild_id: undefined }));
    assert.strictEqual(result, undefined);
  });

  it('logs an error when naturalMode onMessage rejects', async () => {
    const errors = [];
    const client = createMockClient();
    client.logger.error = (...a) => errors.push(a);
    client.aiRuntime = {
      onMessage: async () => {
        throw new Error('runtime fail');
      },
    };
    await handleMessage(client, createMockMessage({ content: 'hello there', guild_id: undefined }));
    await new Promise((r) => setImmediate(r));
    assert.ok(errors.length > 0);
  });

  it('warns when AFK welcome auto-delete fails and uses the username fallback', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const warns = [];
    const sent = [];
    const client = createMockClient();
    client.logger.warn = (...a) => warns.push(a);
    await client.store.set(`afk:${GUILD_ID}:${USER_001}`, { since: Date.now() - 1000, message: 'x' });
    client.sendMessage = async (cid, content) => {
      sent.push(content);
      return { id: 'w', channel_id: cid };
    };
    client.deleteMessage = async () => {
      throw new Error('delete failed');
    };
    const m = createMockMessage({ content: 'back now', author: { id: USER_001, username: 'PlainUser', bot: false } });
    await handleMessage(client, m);
    mock.timers.tick(5000);
    await new Promise((r) => setImmediate(r));
    assert.ok(sent.some((s) => s.includes('PlainUser')));
    assert.ok(warns.some((w) => w.some((a) => typeof a === 'string' && a.includes('AFK welcome'))));
  });

  it('warns when AFK mention notice auto-delete fails', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const warns = [];
    const OTHER = '999999999999999999';
    const client = createMockClient();
    client.logger.warn = (...a) => warns.push(a);
    await client.store.set(`afk:${GUILD_ID}:${OTHER}`, { since: Date.now() - 1000, message: 'brb' });
    client.sendMessage = async (cid) => ({ id: 'w', channel_id: cid });
    client.deleteMessage = async () => {
      throw new Error('delete failed');
    };
    await handleMessage(client, createMockMessage({ content: `yo <@${OTHER}> ping` }));
    mock.timers.tick(10000);
    await new Promise((r) => setImmediate(r));
    assert.ok(warns.some((w) => w.some((a) => typeof a === 'string' && a.includes('AFK mention'))));
  });

  it('warns when anti-link warning auto-delete fails', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const warns = [];
    const client = createMockClient();
    client.logger.warn = (...a) => warns.push(a);
    client.deleteMessage = async (cid, mid) => {
      if (mid === 'warn-x') throw new Error('delete failed');
    };
    client.sendMessage = async () => ({ id: 'warn-x' });
    client.getGuildMember = async () => ({ roles: [] });
    client.getRoles = async () => [];
    await handleMessage(client, createMockMessage({ content: 'spam http://evil.example.com' }));
    mock.timers.tick(5000);
    await new Promise((r) => setImmediate(r));
    assert.ok(warns.some((w) => w.some((a) => typeof a === 'string' && a.includes('link warning'))));
  });

  it('drops silently after a rate-limit notice and uses the username fallback', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const replies = [];
    const client = createMockClient({ hasCommands: { ping: async () => {} } });
    client.sendMessage = async (cid, content) => {
      replies.push(typeof content === 'string' ? content : '');
      return { id: 'r' };
    };
    client.deleteMessage = async () => {};
    for (let i = 0; i < 8; i++) {
      await handleMessage(
        client,
        createMockMessage({ content: `.ping x${i}`, author: { id: USER_001, username: 'NoNick', bot: false } }),
      );
    }
    const notices = replies.filter((r) => r.includes('slow down'));
    assert.strictEqual(notices.length, 1);
    assert.ok(notices[0].includes('NoNick'));
  });
});
