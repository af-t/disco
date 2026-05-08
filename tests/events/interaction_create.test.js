import test from 'node:test';
import assert from 'node:assert';
import handleInteraction from '../../src/events/interaction_create.js';

const BOT_ID = '112233445566778899';
const USER_ID = '100000000000000001';
const GUILD_ID = '300000000000000001';
const CHANNEL_ID = '200000000000000001';
const APP_ID = '112233445566778800';

function createMockClient({ commands = {}, store = new Map(), guildMember = null, roles = [] } = {}) {
  const storeData = store;

  // Convert raw command configs into callable commands with properties
  const wrappedCommands = {};
  for (const [name, config] of Object.entries(commands)) {
    const fn = config.execute || (async () => {});
    fn.data = config.data;
    fn.permissions = config.permissions || [];
    // Proxy data properties onto the function
    if (config.data) {
      for (const key of Object.keys(config.data)) {
        Object.defineProperty(fn, key, {
          enumerable: true,
          get: () => config.data[key],
        });
      }
    }
    wrappedCommands[name] = fn;
    // Also register aliases
    if (config.data?.aliases) {
      for (const alias of config.data.aliases) {
        wrappedCommands[alias.toLowerCase()] = fn;
      }
    }
  }

  return {
    _session: {
      user: { id: BOT_ID },
      application: { id: APP_ID },
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    commands: wrappedCommands,
    store: {
      get: async (key) => storeData.get(key),
      set: async (key, value, _ttl) => {
        storeData.set(key, value);
      },
      delete: async (key) => {
        storeData.delete(key);
      },
      has: async (key) => storeData.has(key),
    },
    createInteractionResponse: async (_interactionId, _token, _body) => {
      return { id: 'response_001' };
    },
    editOriginalInteractionResponse: async (_appId, _token, _body) => {
      return { id: 'edit_001' };
    },
    getGuildMember: async (_guildId, _userId) => guildMember,
    getRoles: async (_guildId) => roles,
    makeRequest: async () => ({}),
  };
}

function createMockInteraction(overrides = {}) {
  return {
    id: 'interaction_001',
    token: 'interaction_token_abc',
    channel_id: CHANNEL_ID,
    guild_id: GUILD_ID,
    type: 2, // APPLICATION_COMMAND
    data: {
      name: 'ping',
      options: [],
    },
    member: {
      user: { id: USER_ID, username: 'TestUser' },
      roles: ['member_role'],
    },
    ...overrides,
  };
}

// ─── Basic Command Dispatch ──────────────────────────────

test('should execute matched slash command', async () => {
  let executed = false;
  const client = createMockClient({
    commands: {
      ping: {
        data: { name: 'ping', description: 'Ping!' },
        permissions: [],
        execute: async () => {
          executed = true;
        },
      },
    },
  });

  const interaction = createMockInteraction({ data: { name: 'ping', options: [] } });
  await handleInteraction(client, interaction);
  assert.strictEqual(executed, true, 'Command should be executed');
});

test('should pass parsed options as args', async () => {
  let receivedArgs = [];
  const client = createMockClient({
    commands: {
      echo: {
        data: { name: 'echo', description: 'Echo!' },
        permissions: [],
        execute: async (_client, _msg, args) => {
          receivedArgs = args;
        },
      },
    },
  });

  const interaction = createMockInteraction({
    data: {
      name: 'echo',
      options: [
        { name: 'text', value: 'hello', type: 3 },
        { name: 'count', value: 42, type: 4 },
      ],
    },
  });

  await handleInteraction(client, interaction);
  assert.deepStrictEqual(receivedArgs, ['hello', '42'], 'Args should be parsed from options');
});

test('should handle subcommands', async () => {
  let receivedArgs = [];
  const client = createMockClient({
    commands: {
      case: {
        data: { name: 'case', description: 'Case management' },
        permissions: [],
        execute: async (_client, _msg, args) => {
          receivedArgs = args;
        },
      },
    },
  });

  const interaction = createMockInteraction({
    data: {
      name: 'case',
      options: [{ name: 'view', type: 1, options: [{ name: 'number', value: 5, type: 4 }] }],
    },
  });

  await handleInteraction(client, interaction);
  assert.deepStrictEqual(receivedArgs, ['view', '5'], 'Subcommand should be included in args');
});

// ─── Permission Check (C1 fix) ───────────────────────────

test('should reject command if user lacks permission', async () => {
  let executed = false;
  const client = createMockClient({
    commands: {
      ban: {
        data: { name: 'ban', description: 'Ban user' },
        permissions: ['BAN_MEMBERS'],
        execute: async () => {
          executed = true;
        },
      },
    },
    guildMember: { roles: ['member_role'] },
    roles: [{ id: 'member_role', permissions: '0' }], // No permissions
  });

  const interaction = createMockInteraction({ data: { name: 'ban', options: [] } });
  await handleInteraction(client, interaction);
  assert.strictEqual(executed, false, 'Command should not execute without proper permissions');
});

test('should allow command if user has admin permission', async () => {
  let executed = false;
  const client = createMockClient({
    commands: {
      ban: {
        data: { name: 'ban', description: 'Ban user' },
        permissions: ['BAN_MEMBERS'],
        execute: async () => {
          executed = true;
        },
      },
    },
    guildMember: { roles: ['admin_role'] },
    roles: [{ id: 'admin_role', permissions: '8' }], // ADMINISTRATOR
  });

  const interaction = createMockInteraction({
    data: { name: 'ban', options: [] },
    member: { user: { id: USER_ID, username: 'Admin' }, roles: ['admin_role'] },
  });
  await handleInteraction(client, interaction);
  assert.strictEqual(executed, true, 'Admin should bypass permission check');
});

test('should allow command if user has matching permission', async () => {
  let executed = false;
  const client = createMockClient({
    commands: {
      ban: {
        data: { name: 'ban', description: 'Ban user' },
        permissions: ['BAN_MEMBERS'],
        execute: async () => {
          executed = true;
        },
      },
    },
    guildMember: { roles: ['mod_role'] },
    roles: [{ id: 'mod_role', permissions: '4' }], // BAN_MEMBERS = 1 << 2 = 4
  });

  const interaction = createMockInteraction({
    data: { name: 'ban', options: [] },
    member: { user: { id: USER_ID, username: 'Mod' }, roles: ['mod_role'] },
  });
  await handleInteraction(client, interaction);
  assert.strictEqual(executed, true, 'User with BAN_MEMBERS should execute ban');
});

// ─── Rate Limiting (M4 fix) ──────────────────────────────

test('should rate limit slash commands', async () => {
  let executedCount = 0;
  const client = createMockClient({
    commands: {
      ping: {
        data: { name: 'ping', description: 'Ping' },
        permissions: [],
        execute: async () => {
          executedCount++;
        },
      },
    },
  });

  const interaction = createMockInteraction({ data: { name: 'ping', options: [] } });

  // 6 rapid invocations — should only execute 5 (DEFAULT rate limit)
  for (let i = 0; i < 6; i++) {
    await handleInteraction(client, interaction);
  }

  assert.strictEqual(executedCount, 5, 'Only 5 commands should execute within rate limit');
});

// ─── Deferred Response (M5 fix) ──────────────────────────

test('should support deferred response for mock message', async () => {
  let deferred = false;
  const client = createMockClient({
    commands: {
      slow: {
        data: { name: 'slow', description: 'Slow command' },
        permissions: [],
        execute: async (_client, msg) => {
          await msg.defer();
          deferred = true;
        },
      },
    },
  });

  const interaction = createMockInteraction({ data: { name: 'slow', options: [] } });
  await handleInteraction(client, interaction);
  assert.strictEqual(deferred, true, 'Defer should be callable from mock message');
});

// ─── Autocomplete Handling ───────────────────────────────

test('should handle autocomplete for help command', async () => {
  let autocompleteResponse = null;
  const client = createMockClient({
    commands: {
      ping: {
        data: { name: 'ping', description: 'Ping the bot' },
      },
      purge: {
        data: { name: 'purge', description: 'Delete messages' },
      },
    },
  });
  // Override to capture autocomplete response
  client.createInteractionResponse = async (id, token, body) => {
    autocompleteResponse = body;
    return {};
  };

  const interaction = createMockInteraction({
    type: 4, // AUTOCOMPLETE
    data: {
      name: 'help',
      options: [{ name: 'command', value: 'pi', focused: true }],
    },
  });

  await handleInteraction(client, interaction);
  assert.ok(autocompleteResponse, 'Should send autocomplete response');
  assert.strictEqual(autocompleteResponse.type, 8, 'Type should be AUTOCOMPLETE_RESULT');
  assert.ok(autocompleteResponse.data.choices.length > 0, 'Should have at least one choice');
});

test('should ignore unknown command', async () => {
  const client = createMockClient({ commands: {} });
  const interaction = createMockInteraction({ data: { name: 'nonexistent', options: [] } });
  // Should not throw
  await handleInteraction(client, interaction);
  assert.ok(true, 'Should handle unknown command gracefully');
});
