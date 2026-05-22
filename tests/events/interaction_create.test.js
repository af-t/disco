import test from 'node:test';
import { describe, it, mock, afterEach } from 'node:test';
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

// ── Type filtering ─────────────────────────────────────────────────────────────
describe('interaction_create type filtering', () => {
  it('ignores interaction type 3 (MESSAGE_COMPONENT)', async () => {
    const client = createMockClient();
    const responses = [];
    client.createInteractionResponse = async (...a) => {
      responses.push(a);
    };
    await handleInteraction(client, createMockInteraction({ type: 3 }));
    assert.strictEqual(responses.length, 0);
  });

  it('returns early when client.commands is null', async () => {
    const client = createMockClient();
    client.commands = null;
    const responses = [];
    client.createInteractionResponse = async (...a) => {
      responses.push(a);
    };
    await handleInteraction(client, createMockInteraction({ type: 2 }));
    assert.strictEqual(responses.length, 0);
  });
});

// ── Autocomplete (type 4) ─────────────────────────────────────────────────────
describe('interaction_create autocomplete', () => {
  afterEach(() => mock.restoreAll());

  it('returns help command choices filtered by query', async () => {
    const client = createMockClient({
      commands: {
        ping: { data: { name: 'ping', description: 'Pong' }, execute: async () => {} },
        ban: { data: { name: 'ban', description: 'Ban user' }, execute: async () => {} },
      },
    });
    const responses = [];
    client.createInteractionResponse = async (id, token, body) => {
      responses.push(body);
    };

    await handleInteraction(client, {
      id: 'i1',
      token: 'tok',
      type: 4,
      data: {
        name: 'help',
        options: [{ name: 'command', focused: true, value: 'pi' }],
      },
    });

    assert.strictEqual(responses.length, 1);
    assert.strictEqual(responses[0].type, 8);
    assert.ok(responses[0].data.choices.every((c) => c.name.includes('pi')));
  });

  it('non-help autocomplete returns without response', async () => {
    const client = createMockClient({
      commands: { ping: { data: { name: 'ping', description: 'x' }, execute: async () => {} } },
    });
    const responses = [];
    client.createInteractionResponse = async (...a) => {
      responses.push(a);
    };

    await handleInteraction(client, {
      id: 'i1',
      token: 'tok',
      type: 4,
      data: { name: 'other', options: [{ name: 'x', focused: true, value: '' }] },
    });
    assert.strictEqual(responses.length, 0);
  });
});

// ── Unknown command ───────────────────────────────────────────────────────────
describe('interaction_create unknown command', () => {
  it('returns without error for unknown command name', async () => {
    const client = createMockClient({ commands: {} });
    const responses = [];
    client.createInteractionResponse = async (...a) => {
      responses.push(a);
    };
    await handleInteraction(client, createMockInteraction({ data: { name: 'unknown', options: [] } }));
    assert.strictEqual(responses.length, 0);
  });
});

// ── Permission check ──────────────────────────────────────────────────────────
describe('interaction_create permission check', () => {
  it('responds with Unable to verify when member is null', async () => {
    const client = createMockClient({
      commands: {
        ban: {
          data: { name: 'ban', description: 'Ban', permissions: ['BAN_MEMBERS'] },
          permissions: ['BAN_MEMBERS'],
          execute: async () => {},
        },
      },
      guildMember: null,
    });
    const responses = [];
    client.createInteractionResponse = async (id, tok, body) => {
      responses.push(body);
    };

    await handleInteraction(
      client,
      createMockInteraction({
        data: { name: 'ban', options: [] },
        member: null,
      }),
    );
    assert.ok(responses.some((r) => r.data?.content?.includes('Unable to verify')));
  });

  it('denies when user lacks permission', async () => {
    const client = createMockClient({
      commands: {
        ban: {
          data: { name: 'ban', description: 'Ban', permissions: ['BAN_MEMBERS'] },
          permissions: ['BAN_MEMBERS'],
          execute: async () => {},
        },
      },
      guildMember: { roles: ['r1'] },
      roles: [{ id: 'r1', permissions: '0' }],
    });
    const responses = [];
    client.createInteractionResponse = async (id, tok, body) => {
      responses.push(body);
    };

    await handleInteraction(
      client,
      createMockInteraction({
        data: { name: 'ban', options: [] },
        member: { roles: ['r1'], user: { id: USER_ID } },
      }),
    );
    assert.ok(responses.some((r) => r.data?.content?.includes('do not have permission')));
  });

  it('ADMINISTRATOR bypasses permission check', async () => {
    const executed = [];
    const client = createMockClient({
      commands: {
        ban: {
          data: { name: 'ban', description: 'Ban', permissions: ['BAN_MEMBERS'] },
          permissions: ['BAN_MEMBERS'],
          execute: async () => {
            executed.push(1);
          },
        },
      },
      guildMember: { roles: ['r1'] },
      roles: [{ id: 'r1', permissions: '8' }],
    });
    client.createInteractionResponse = async () => {};

    await handleInteraction(
      client,
      createMockInteraction({
        data: { name: 'ban', options: [] },
        member: { roles: ['r1'], user: { id: USER_ID } },
      }),
    );
    assert.strictEqual(executed.length, 1);
  });

  it('warns on unknown permission name', async () => {
    const warns = [];
    const client = createMockClient({
      commands: {
        x: {
          data: { name: 'x', description: 'x', permissions: ['FAKE_PERM'] },
          permissions: ['FAKE_PERM'],
          execute: async () => {},
        },
      },
      guildMember: { roles: ['r1'] },
      roles: [{ id: 'r1', permissions: '0' }],
    });
    client.logger.warn = (...a) => {
      warns.push(a);
    };
    client.createInteractionResponse = async () => {};

    await handleInteraction(
      client,
      createMockInteraction({
        data: { name: 'x', options: [] },
        member: { roles: ['r1'], user: { id: USER_ID } },
      }),
    );
    assert.ok(warns.some((w) => w.some((a) => typeof a === 'string' && a.includes('Unknown permission'))));
  });
});

// ── Rate limiting ─────────────────────────────────────────────────────────────
describe('interaction_create rate limiting', () => {
  it('sends rate limit response after DEFAULT threshold', async () => {
    const client = createMockClient({
      commands: {
        ping: { data: { name: 'ping', description: 'x' }, execute: async () => {}, permissions: [] },
      },
    });
    const responses = [];
    client.createInteractionResponse = async (id, tok, body) => {
      responses.push(body);
    };

    for (let i = 0; i < 6; i++) {
      await handleInteraction(client, createMockInteraction({ data: { name: 'ping', options: [] } }));
    }
    assert.ok(responses.some((r) => r.data?.content?.includes('slow down')));
  });

  it('silently drops when already notified', async () => {
    const client = createMockClient({
      commands: {
        ping: { data: { name: 'ping', description: 'x' }, execute: async () => {}, permissions: [] },
      },
    });
    const responses = [];
    client.createInteractionResponse = async (id, tok, body) => {
      responses.push(body);
    };

    for (let i = 0; i < 7; i++) {
      await handleInteraction(client, createMockInteraction({ data: { name: 'ping', options: [] } }));
    }
    const noticeCount = responses.filter((r) => r.data?.content?.includes('slow down')).length;
    assert.strictEqual(noticeCount, 1);
  });
});

// ── mockMessage shim ──────────────────────────────────────────────────────────
describe('interaction_create mockMessage shim', () => {
  it('reply() uses createInteractionResponse (non-deferred)', async () => {
    const responses = [];
    const client = createMockClient({
      commands: {
        ping: {
          data: { name: 'ping', description: 'x' },
          execute: async (c, msg) => {
            await msg.reply('pong');
          },
          permissions: [],
        },
      },
    });
    client.createInteractionResponse = async (id, tok, body) => {
      responses.push(body);
    };

    await handleInteraction(client, createMockInteraction({ data: { name: 'ping', options: [] } }));
    assert.ok(responses.some((r) => r.type === 4 && r.data?.content === 'pong'));
  });

  it('defer() + reply() uses editOriginalInteractionResponse', async () => {
    const edits = [];
    const client = createMockClient({
      commands: {
        slow: {
          data: { name: 'slow', description: 'x' },
          execute: async (c, msg) => {
            await msg.defer();
            await msg.reply('done');
          },
          permissions: [],
        },
      },
    });
    client.createInteractionResponse = async () => {};
    client.editOriginalInteractionResponse = async (appId, tok, body) => {
      edits.push(body);
    };

    await handleInteraction(client, createMockInteraction({ data: { name: 'slow', options: [] } }));
    assert.ok(edits.some((e) => e.content === 'done'));
  });

  it('command error: logs and edits if deferred', async () => {
    const errors = [];
    const edits = [];
    const client = createMockClient({
      commands: {
        boom: {
          data: { name: 'boom', description: 'x' },
          execute: async (c, msg) => {
            await msg.defer();
            throw new Error('cmd failed');
          },
          permissions: [],
        },
      },
    });
    client.logger.error = (...a) => {
      errors.push(a);
    };
    client.createInteractionResponse = async () => {};
    client.editOriginalInteractionResponse = async (appId, tok, body) => {
      edits.push(body);
    };

    await handleInteraction(client, createMockInteraction({ data: { name: 'boom', options: [] } }));
    assert.ok(errors.length > 0);
    assert.ok(edits.some((e) => e.content?.includes('error')));
  });

  it('command error: non-deferred just logs', async () => {
    const errors = [];
    const client = createMockClient({
      commands: {
        boom: {
          data: { name: 'boom', description: 'x' },
          execute: async () => {
            throw new Error('boom');
          },
          permissions: [],
        },
      },
    });
    client.logger.error = (...a) => {
      errors.push(a);
    };
    client.createInteractionResponse = async () => {};

    await handleInteraction(client, createMockInteraction({ data: { name: 'boom', options: [] } }));
    assert.ok(errors.length > 0);
  });
});
