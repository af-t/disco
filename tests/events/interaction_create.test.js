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

  it('denies a permissioned command invoked in a DM (no guild_id)', async () => {
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
    });
    const responses = [];
    client.createInteractionResponse = async (id, tok, body) => {
      responses.push(body);
    };

    await handleInteraction(
      client,
      createMockInteraction({
        data: { name: 'ban', options: [] },
        guild_id: undefined,
        member: null,
        user: { id: USER_ID },
      }),
    );
    assert.strictEqual(executed.length, 0);
    assert.ok(responses.some((r) => r.data?.content?.match(/guild/i)));
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
  function setupRateLimitTest() {
    const client = createMockClient({
      commands: {
        ping: { data: { name: 'ping', description: 'x' }, execute: async () => {}, permissions: [] },
      },
    });
    const responses = [];
    client.createInteractionResponse = async (id, tok, body) => {
      responses.push(body);
    };
    return { client, responses };
  }

  it('sends rate limit response after DEFAULT threshold', async () => {
    const { client, responses } = setupRateLimitTest();

    for (let i = 0; i < 6; i++) {
      await handleInteraction(client, createMockInteraction({ data: { name: 'ping', options: [] } }));
    }
    assert.ok(responses.some((r) => r.data?.content?.includes('slow down')));
  });

  it('silently drops when already notified', async () => {
    const { client, responses } = setupRateLimitTest();

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

describe('interaction_create defer failure', () => {
  afterEach(() => mock.restoreAll());

  it('reply() uses createInteractionResponse type 4 when defer() API call fails', async () => {
    const type4Responses = [];
    const editCalls = [];

    const client = createMockClient({
      commands: {
        slow: {
          data: { name: 'slow', description: 'x' },
          permissions: [],
          execute: async (_c, msg) => {
            await msg.defer(true).catch(() => {}); // swallow defer failure
            await msg.reply('hello'); // must use type 4, not editOriginal
          },
        },
      },
    });

    client.createInteractionResponse = async (_id, _tok, body) => {
      if (body.type === 5) throw new Error('failed to defer');
      type4Responses.push(body);
    };
    client.editOriginalInteractionResponse = async (_appId, _tok, body) => {
      editCalls.push(body);
    };

    await handleInteraction(client, createMockInteraction({ data: { name: 'slow', options: [] } }));

    assert.ok(
      type4Responses.some((r) => r.type === 4 && r.data?.content === 'hello'),
      'reply should fall back to createInteractionResponse type 4 when defer failed',
    );
    assert.strictEqual(editCalls.length, 0, 'editOriginalInteractionResponse must not be called');
  });
});

describe('interaction_create extra coverage', () => {
  afterEach(() => mock.restoreAll());

  it('autocomplete returns early when client.commands is missing', async () => {
    const client = createMockClient();
    client.commands = null;
    const responses = [];
    client.createInteractionResponse = async (...a) => responses.push(a);
    await handleInteraction(client, {
      id: 'i1',
      token: 't',
      type: 4,
      data: { name: 'help', options: [{ name: 'command', focused: true, value: 'p' }] },
    });
    assert.strictEqual(responses.length, 0);
  });

  it('resolves the member via interaction.user when interaction.member is null', async () => {
    const executed = [];
    const client = createMockClient({
      commands: {
        ban: {
          data: { name: 'ban', description: 'Ban', permissions: ['BAN_MEMBERS'] },
          permissions: ['BAN_MEMBERS'],
          execute: async () => executed.push(1),
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
        member: null,
        user: { id: USER_ID, username: 'ViaUser' },
      }),
    );
    assert.strictEqual(executed.length, 1);
  });

  it('applies the HEAVY rate limit to AI slash commands', async () => {
    let count = 0;
    const client = createMockClient({
      commands: {
        summarize: {
          data: { name: 'summarize', description: 'x' },
          permissions: [],
          execute: async () => count++,
        },
      },
    });
    client.createInteractionResponse = async () => {};
    for (let i = 0; i < 4; i++) {
      await handleInteraction(client, createMockInteraction({ data: { name: 'summarize', options: [] } }));
    }
    assert.strictEqual(count, 2); // HEAVY = 2/sec
  });

  it('resets the rate-limit window after one second', async () => {
    const executed = [];
    const store = new Map();
    store.set(`request_limit:${USER_ID}`, { notified: true, time: Date.now() - 2000, count: 99 });
    const client = createMockClient({
      commands: {
        ping: { data: { name: 'ping', description: 'x' }, permissions: [], execute: async () => executed.push(1) },
      },
      store,
    });
    client.createInteractionResponse = async () => {};
    await handleInteraction(client, createMockInteraction({ data: { name: 'ping', options: [] } }));
    assert.strictEqual(executed.length, 1);
  });

  it('parses an interaction with no options block', async () => {
    let receivedArgs = null;
    const client = createMockClient({
      commands: {
        ping: {
          data: { name: 'ping', description: 'x' },
          permissions: [],
          execute: async (_c, _m, args) => {
            receivedArgs = args;
          },
        },
      },
    });
    client.createInteractionResponse = async () => {};
    await handleInteraction(client, createMockInteraction({ data: { name: 'ping' } }));
    assert.deepStrictEqual(receivedArgs, []);
  });

  it('reply shim accepts an object payload', async () => {
    const responses = [];
    const client = createMockClient({
      commands: {
        ping: {
          data: { name: 'ping', description: 'x' },
          permissions: [],
          execute: async (_c, msg) => {
            await msg.reply({ content: 'obj', embeds: [] });
          },
        },
      },
    });
    client.createInteractionResponse = async (id, tok, body) => responses.push(body);
    await handleInteraction(client, createMockInteraction({ data: { name: 'ping', options: [] } }));
    assert.ok(responses.some((r) => r.data?.content === 'obj'));
  });

  it('defer(false) produces a non-ephemeral deferred response', async () => {
    const responses = [];
    const client = createMockClient({
      commands: {
        slow: {
          data: { name: 'slow', description: 'x' },
          permissions: [],
          execute: async (_c, msg) => {
            await msg.defer(false);
          },
        },
      },
    });
    client.createInteractionResponse = async (id, tok, body) => responses.push(body);
    await handleInteraction(client, createMockInteraction({ data: { name: 'slow', options: [] } }));
    assert.ok(responses.some((r) => r.type === 5 && r.data === undefined));
  });

  it('command error swallows a failing editOriginalInteractionResponse', async () => {
    const errors = [];
    const client = createMockClient({
      commands: {
        boom: {
          data: { name: 'boom', description: 'x' },
          permissions: [],
          execute: async (_c, msg) => {
            await msg.defer();
            throw new Error('cmd failed');
          },
        },
      },
    });
    client.logger.error = (...a) => errors.push(a);
    client.createInteractionResponse = async () => {};
    client.editOriginalInteractionResponse = async () => {
      throw new Error('expired');
    };
    await handleInteraction(client, createMockInteraction({ data: { name: 'boom', options: [] } }));
    assert.ok(errors.length > 0);
  });
});

describe('interaction_create auto-defer', () => {
  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  function setupDeferMocks(client, responses, edits) {
    client.createInteractionResponse = async (_id, _tok, body) => {
      responses.push(body);
      return {};
    };
    client.editOriginalInteractionResponse = async (_app, _tok, body) => {
      edits.push(body);
      return {};
    };
  }

  it('auto-defers a slow command so a late reply still lands', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const responses = [];
    const edits = [];

    const client = createMockClient({
      commands: {
        slow: {
          data: { name: 'slow', description: 'x' },
          permissions: [],
          execute: async (_c, msg) => {
            // cross Discord's 3s window before responding
            mock.timers.tick(2500);
            await Promise.resolve();
            await Promise.resolve();
            await msg.reply('done');
          },
        },
      },
    });
    setupDeferMocks(client, responses, edits);

    await handleInteraction(client, createMockInteraction({ data: { name: 'slow', options: [] } }));

    assert.ok(
      responses.some((r) => r.type === 5),
      'should send a deferred (type 5) response before the deadline',
    );
    assert.ok(
      edits.some((e) => e.content === 'done'),
      'the late reply should edit the original deferred response',
    );
    assert.ok(!responses.some((r) => r.type === 4), 'must not attempt an immediate type 4 response after deferring');
  });

  it('replies immediately and never auto-defers a fast command', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const responses = [];

    const client = createMockClient({
      commands: {
        fast: {
          data: { name: 'fast', description: 'x' },
          permissions: [],
          execute: async (_c, msg) => {
            await msg.reply('hi');
          },
        },
      },
    });
    client.createInteractionResponse = async (_id, _tok, body) => {
      responses.push(body);
      return {};
    };

    await handleInteraction(client, createMockInteraction({ data: { name: 'fast', options: [] } }));
    // the auto-defer timer must already be cleared
    mock.timers.tick(5000);
    await Promise.resolve();

    assert.ok(responses.some((r) => r.type === 4 && r.data?.content === 'hi'));
    assert.ok(!responses.some((r) => r.type === 5), 'fast command must not auto-defer');
  });

  it('reports an error via editOriginal when a command throws after auto-defer', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const responses = [];
    const edits = [];

    const client = createMockClient({
      commands: {
        slowboom: {
          data: { name: 'slowboom', description: 'x' },
          permissions: [],
          execute: async () => {
            // cross the deadline, then fail without replying
            mock.timers.tick(2000);
            await Promise.resolve();
            await Promise.resolve();
            throw new Error('kaboom');
          },
        },
      },
    });
    setupDeferMocks(client, responses, edits);

    await handleInteraction(client, createMockInteraction({ data: { name: 'slowboom', options: [] } }));

    assert.ok(
      responses.some((r) => r.type === 5),
      'the slow command should have auto-deferred',
    );
    assert.ok(
      edits.some((e) => typeof e.content === 'string' && e.content.includes('error')),
      'the error must be delivered by editing the deferred response',
    );
    assert.ok(!responses.some((r) => r.type === 4), 'must not send an immediate error after deferring');
  });

  it('falls back to an error response when reply itself fails before deferring', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const responses = [];
    let firstCall = true;

    const client = createMockClient({
      commands: {
        replyfail: {
          data: { name: 'replyfail', description: 'x' },
          permissions: [],
          execute: async (_c, msg) => {
            await msg.reply('result'); // this send fails below
          },
        },
      },
    });
    client.createInteractionResponse = async (_id, _tok, body) => {
      responses.push(body);
      // first type 4 (the real reply) fails, the fallback error is the second
      if (firstCall) {
        firstCall = false;
        throw new Error('send failed');
      }
      return {};
    };

    await handleInteraction(client, createMockInteraction({ data: { name: 'replyfail', options: [] } }));

    assert.strictEqual(responses.length, 2, 'a failed reply should trigger one fallback error response');
    assert.ok(
      responses[1].type === 4 && responses[1].data?.content?.includes('error'),
      'the fallback must carry the error message',
    );
  });
});
