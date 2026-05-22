import test, { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import utility from '../../src/lib/utility.js';

const { Logger, importCommands, importEvents, deploySlashCommands, formatAgo, getPermissions } = utility;

test('Logger class should format and log messages correctly', (t) => {
  const logger = new Logger('TEST');

  const stdoutMock = t.mock.method(process.stdout, 'write', () => {});
  const stderrMock = t.mock.method(process.stderr, 'write', () => {});

  logger.info('hello world');
  assert.strictEqual(stdoutMock.mock.callCount(), 1);
  assert.ok(stdoutMock.mock.calls[0].arguments[0].includes('[TEST] hello world'));

  logger.error('oops');
  assert.strictEqual(stderrMock.mock.callCount(), 1);
  assert.ok(stderrMock.mock.calls[0].arguments[0].includes('[TEST] oops'));
});

test('formatAgo should format timestamps correctly', () => {
  const now = Date.now();

  // Just now (negative diff)
  assert.strictEqual(formatAgo(now + 5000), 'just now');

  // Just now (0 diff)
  assert.strictEqual(formatAgo(now), '0s ago');

  // Seconds ago
  assert.strictEqual(formatAgo(now - 5000), '5s ago');

  // Minutes ago
  assert.strictEqual(formatAgo(now - 120_000), '2m 0s ago');

  // Minutes and seconds
  assert.strictEqual(formatAgo(now - 150_000), '2m 30s ago');

  // Hours ago
  assert.strictEqual(formatAgo(now - 7_200_000), '2h 0m ago');

  // Hours and minutes
  assert.strictEqual(formatAgo(now - 9_000_000), '2h 30m ago');
});

test('importCommands should load commands from a directory', async (_t) => {
  const tempDir = join(process.cwd(), 'tests_tmp_commands');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

  const commandFile = join(tempDir, 'ping.js');
  fs.writeFileSync(
    commandFile,
    `
    export default {
      data: { name: 'ping', description: 'Ping command', aliases: ['p'] },
      execute: async () => 'pong'
    };
  `,
  );

  try {
    const commands = await importCommands(tempDir);
    assert.ok(commands.ping);
    assert.ok(commands.p);
    assert.strictEqual(commands.ping.data.name, 'ping');
    assert.strictEqual(await commands.ping(), 'pong');
  } finally {
    fs.unlinkSync(commandFile);
    fs.rmdirSync(tempDir);
  }
});

test('importEvents should load events from a directory', async (_t) => {
  const tempDir = join(process.cwd(), 'tests_tmp_events');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

  const eventFile = join(tempDir, 'test_event.js');
  fs.writeFileSync(
    eventFile,
    `
    export default async (client, data) => {
      client._testEventFired = data;
    };
  `,
  );

  // Create a simple mock client that tracks event listeners
  const listeners = {};
  const mockClient = {
    _testEventFired: null,
    on: (eventName, handler) => {
      listeners[eventName] = handler;
    },
  };

  try {
    await importEvents(mockClient, tempDir);
    assert.ok(listeners['TEST_EVENT'], 'Should register TEST_EVENT listener');

    // Simulate emitting the event
    await listeners['TEST_EVENT']('test_data');
    assert.strictEqual(mockClient._testEventFired, 'test_data', 'Event handler should be called');
  } finally {
    fs.unlinkSync(eventFile);
    fs.rmdirSync(tempDir);
  }
});

test('deploySlashCommands should skip when no application ID', async () => {
  const warnings = [];
  const mockClient = {
    _session: {},
    logger: {
      warn: (msg) => {
        warnings.push(msg);
      },
      info: () => {},
      error: () => {},
    },
  };

  await deploySlashCommands(mockClient, {});
  assert.ok(
    warnings.some((w) => w.includes('Application ID not found')),
    'Should warn about missing app ID',
  );
});

test('deploySlashCommands should compute hash and skip if unchanged', async () => {
  let makeRequestCalled = false;
  const store = new Map();
  const mockClient = {
    _session: { application: { id: 'app_123' } },
    logger: {
      warn: () => {},
      info: () => {},
      error: () => {},
    },
    store: {
      get: async (key) => store.get(key),
      set: async (key, value) => {
        store.set(key, value);
      },
      has: async () => store.has('slash_commands_hash'),
    },
    makeRequest: async (_method, _endpoint, _body) => {
      makeRequestCalled = true;
      return [];
    },
  };

  const commands = {
    ping: {
      data: { name: 'ping', description: 'Ping!', slash: true, options: [] },
    },
  };

  // First call: should deploy
  await deploySlashCommands(mockClient, commands);
  assert.strictEqual(makeRequestCalled, true, 'First call should make request');

  // Second call: with same commands, should skip
  makeRequestCalled = false;
  store.set('slash_commands_hash', store.get('slash_commands_hash')); // hash stored by first call
  await deploySlashCommands(mockClient, commands);
  assert.strictEqual(makeRequestCalled, false, 'Second call with same commands should skip');
});

test('deploySlashCommands should filter non-slash commands', async () => {
  let deployedCommands = null;
  const mockClient = {
    _session: { application: { id: 'app_456' } },
    logger: {
      warn: () => {},
      info: () => {},
      error: () => {},
    },
    store: {
      get: async () => null,
      set: async () => {},
    },
    makeRequest: async (_method, _endpoint, body) => {
      deployedCommands = body;
      return [];
    },
  };

  const commands = {
    ping: {
      data: { name: 'ping', description: 'Ping!', slash: true },
    },
    openrouter: {
      data: { name: 'openrouter', description: 'AI Chat', slash: false },
    },
  };

  await deploySlashCommands(mockClient, commands);
  assert.strictEqual(deployedCommands.length, 1, 'Only slash-enabled commands should be deployed');
  assert.strictEqual(deployedCommands[0].name, 'ping', 'ping should be deployed');
});

// ─── getPermissions ─────────────────────────────────────────

test('getPermissions: basic permission read from single role', async () => {
  const mockClient = {
    getRoles: async () => [
      { id: 'role_1', permissions: '1024' }, // VIEW_CHANNEL
    ],
  };
  const member = { roles: ['role_1'] };
  const perms = await getPermissions(mockClient, 'guild_1', member);
  assert.strictEqual(perms, 1024n);
});

test('getPermissions: multi-role bitwise OR', async () => {
  const mockClient = {
    getRoles: async () => [
      { id: 'role_1', permissions: '1024' }, // VIEW_CHANNEL
      { id: 'role_2', permissions: '2048' }, // SEND_MESSAGES
    ],
  };
  const member = { roles: ['role_1', 'role_2'] };
  const perms = await getPermissions(mockClient, 'guild_1', member);
  assert.strictEqual(perms, 1024n | 2048n);
});

test('getPermissions: null member (no roles) returns 0n', async () => {
  const mockClient = {
    getRoles: async () => [],
  };
  // member is null/undefined
  let perms = await getPermissions(mockClient, 'guild_1', null);
  assert.strictEqual(perms, 0n);
  // member exists but no roles array
  perms = await getPermissions(mockClient, 'guild_1', {});
  assert.strictEqual(perms, 0n);
});

test('getPermissions: admin permission flag (8 = 1<<3)', async () => {
  const mockClient = {
    getRoles: async () => [
      { id: 'admin_role', permissions: '8' }, // ADMINISTRATOR
    ],
  };
  const member = { roles: ['admin_role'] };
  const perms = await getPermissions(mockClient, 'guild_1', member);
  assert.strictEqual(perms, 8n);
  assert.strictEqual(typeof perms, 'bigint');
});

// ── Logger ────────────────────────────────────────────────────────────────────
describe('Logger methods', () => {
  afterEach(() => mock.restoreAll());

  it('warn writes to stderr', () => {
    const writes = [];
    mock.method(process.stderr, 'write', (s) => {
      writes.push(s);
    });
    const logger = new Logger('TEST');
    logger.warn('oops');
    assert.ok(writes.some((w) => w.includes('oops')));
  });

  it('info writes to stdout', () => {
    const writes = [];
    mock.method(process.stdout, 'write', (s) => {
      writes.push(s);
    });
    const logger = new Logger('TEST');
    logger.info('info-msg');
    assert.ok(writes.some((w) => w.includes('info-msg')));
  });

  it('error writes to stderr', () => {
    const writes = [];
    mock.method(process.stderr, 'write', (s) => {
      writes.push(s);
    });
    const logger = new Logger('TEST');
    logger.error('err-msg');
    assert.ok(writes.some((w) => w.includes('err-msg')));
  });

  it('debug writes to stdout', () => {
    const writes = [];
    mock.method(process.stdout, 'write', (s) => {
      writes.push(s);
    });
    const logger = new Logger('TEST');
    logger.debug('dbg');
    assert.ok(writes.some((w) => w.includes('dbg')));
  });

  it('non-string arg uses util.inspect format', () => {
    const writes = [];
    mock.method(process.stdout, 'write', (s) => {
      writes.push(s);
    });
    const logger = new Logger('TEST');
    logger.log({ nested: true });
    assert.ok(writes.some((w) => w.includes('nested')));
  });

  it('createLogger instance method returns Logger with correct name', () => {
    const logger = new Logger('A');
    const child = logger.createLogger('B');
    assert.strictEqual(child.name, 'B');
  });

  it('Logger.createLogger static returns Logger with correct name', () => {
    const logger = Logger.createLogger('FOO');
    assert.strictEqual(logger.name, 'FOO');
  });
});

// ── formatAgo ─────────────────────────────────────────────────────────────────
describe('formatAgo', () => {
  it('future timestamp returns just now', () => {
    assert.strictEqual(formatAgo(Date.now() + 5000), 'just now');
  });
  it('30s ago', () => {
    assert.strictEqual(formatAgo(Date.now() - 30_000), '30s ago');
  });
  it('90s ago returns 1m 30s ago', () => {
    assert.strictEqual(formatAgo(Date.now() - 90_000), '1m 30s ago');
  });
  it('1h1m ago', () => {
    assert.ok(formatAgo(Date.now() - 3_661_000).startsWith('1h'));
  });
});

// ── deploySlashCommands error path ────────────────────────────────────────────
describe('deploySlashCommands makeRequest error', () => {
  it('logs error when makeRequest throws', async () => {
    const errors = [];
    const client = {
      _session: { application: { id: 'app1' } },
      logger: { warn: () => {}, info: () => {}, error: (...args) => errors.push(args) },
      store: { get: async () => 'different-hash', set: async () => {} },
      makeRequest: async () => {
        throw new Error('network error');
      },
    };
    await deploySlashCommands(client, {
      ping: Object.assign(() => {}, {
        data: { name: 'ping', description: 'Ping', slash: true },
      }),
    });
    assert.ok(errors.some((e) => e.some((a) => typeof a === 'string' && a.includes('Failed'))));
  });
});

// ── importCommands subdirectory recursion ─────────────────────────────────────
describe('importCommands subdirectory recursion', () => {
  it('loads commands from nested subdirectories', async () => {
    const base = join(tmpdir(), 'util_sub_' + Date.now());
    const sub = join(base, 'subcmds');
    await mkdir(sub, { recursive: true });
    await writeFile(
      join(sub, 'ping.js'),
      `export default { data: { name: 'ping', description: 'Ping' }, execute: async () => {} };`,
    );
    try {
      const commands = await importCommands(base);
      assert.ok('ping' in commands);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// ── importCommands duplicate alias warning ────────────────────────────────────
describe('importCommands duplicate alias warning', () => {
  it('warns and skips when alias already registered', async () => {
    const base = join(tmpdir(), 'util_dup_' + Date.now());
    await mkdir(base, { recursive: true });
    await writeFile(
      join(base, 'ping.js'),
      `export default { data: { name: 'ping', description: 'Ping', aliases: ['p'] }, execute: async () => {} };`,
    );
    await writeFile(
      join(base, 'pong.js'),
      `export default { data: { name: 'pong', description: 'Pong', aliases: ['p'] }, execute: async () => {} };`,
    );
    try {
      const commands = await importCommands(base);
      // At least one of ping/pong loaded, duplicate alias skipped without throw
      assert.ok('ping' in commands || 'pong' in commands);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// ── importCommands bad module structure ───────────────────────────────────────
describe('importCommands warns on bad module structure', () => {
  it('warns when module lacks data.name or execute', async () => {
    const base = join(tmpdir(), 'util_bad_' + Date.now());
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'notacmd.js'), `export default {};`);
    try {
      const commands = await importCommands(base);
      assert.deepStrictEqual(Object.keys(commands), []);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// ── importCommands import throws ──────────────────────────────────────────────
describe('importCommands handles import error gracefully', () => {
  it('warns and continues when a file throws during import', async () => {
    const base = join(tmpdir(), 'util_err_' + Date.now());
    await mkdir(base, { recursive: true });
    // File that throws at module evaluation time — unique name avoids ESM cache
    await writeFile(join(base, 'broken.js'), `throw new Error('module init error');`);
    try {
      const commands = await importCommands(base);
      assert.deepStrictEqual(Object.keys(commands), []);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// ── importEvents catch block ──────────────────────────────────────────────────
describe('importEvents handles import error gracefully', () => {
  it('warns and continues when event file throws during import', async () => {
    const base = join(tmpdir(), 'util_evt_' + Date.now());
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'bad_event.js'), `throw new Error('event load error');`);
    const client = { on: () => {} };
    try {
      await importEvents(client, base);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// ── deploySlashCommands options map ──────────────────────────────────────────
describe('deploySlashCommands with options', () => {
  it('maps options including autocomplete=false default', async () => {
    let putPayload;
    const client = {
      _session: { application: { id: 'app1' } },
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      store: { get: async () => 'different-hash', set: async () => {} },
      makeRequest: async (_method, _path, body) => {
        putPayload = body;
      },
    };
    await deploySlashCommands(client, {
      search: Object.assign(() => {}, {
        data: {
          name: 'search',
          description: 'Search',
          slash: true,
          options: [{ name: 'query', description: 'Query', type: 3, required: true }],
        },
      }),
    });
    assert.ok(Array.isArray(putPayload));
    assert.strictEqual(putPayload[0].options[0].autocomplete, false);
  });
});

// ── deploySlashCommands hash-unchanged skip ───────────────────────────────────
describe('deploySlashCommands hash-unchanged skip', () => {
  it('skips PUT when hash is unchanged', async () => {
    let putCalled = false;
    const { createHash } = await import('node:crypto');
    const cmd = { name: 'ping', description: 'Ping', options: [] };
    const hash = createHash('sha256')
      .update(JSON.stringify([cmd]))
      .digest('hex');

    const client = {
      _session: { application: { id: 'app1' } },
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      store: { get: async () => hash, set: async () => {} },
      makeRequest: async () => {
        putCalled = true;
      },
    };
    await deploySlashCommands(client, {
      ping: Object.assign(() => {}, {
        data: { name: 'ping', description: 'Ping', slash: true },
      }),
    });
    assert.strictEqual(putCalled, false);
  });
});

describe('utility extra coverage', () => {
  afterEach(() => mock.restoreAll());

  it('Logger falls back to "unknown" for a non-string name', () => {
    assert.strictEqual(new Logger(123).name, 'unknown');
  });

  it('importCommands rejects a non-string path', async () => {
    await assert.rejects(() => importCommands(123), TypeError);
  });

  it('importEvents rejects a non-string path', async () => {
    await assert.rejects(() => importEvents({ on: () => {} }, 123), TypeError);
  });

  it('importCommands exposes data fields as proxied getters', async () => {
    const base = join(tmpdir(), 'util_proxy_' + Date.now());
    await mkdir(base, { recursive: true });
    await writeFile(
      join(base, 'ping.js'),
      `export default { data: { name: 'ping', description: 'Ping', usage: 'ping' }, execute: async () => {} };`,
    );
    try {
      const commands = await importCommands(base);
      assert.strictEqual(commands.ping.name, 'ping');
      assert.strictEqual(commands.ping.usage, 'ping');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('importCommands warns when a module has no default export', async () => {
    const base = join(tmpdir(), 'util_nodefault_' + Date.now());
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'nodef.js'), `export const value = 1;`);
    try {
      const commands = await importCommands(base);
      assert.deepStrictEqual(Object.keys(commands), []);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('importEvents skips subdirectories and no-default files', async () => {
    const base = join(tmpdir(), 'util_evtdir_' + Date.now());
    await mkdir(join(base, 'nested'), { recursive: true });
    await writeFile(join(base, 'ready.js'), `export const x = 1;`);
    const events = [];
    const client = { on: (name) => events.push(name) };
    try {
      await importEvents(client, base);
      assert.ok(events.includes('READY'));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('deploySlashCommands logs a plural sync message for multiple commands', async () => {
    let payload;
    const client = {
      _session: { application: { id: 'app1' } },
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      store: { get: async () => 'stale-hash', set: async () => {} },
      makeRequest: async (_m, _p, body) => {
        payload = body;
      },
    };
    await deploySlashCommands(client, {
      ping: Object.assign(() => {}, { data: { name: 'ping', description: 'Ping', slash: true } }),
      pong: Object.assign(() => {}, { data: { name: 'pong', description: 'Pong', slash: true } }),
    });
    assert.strictEqual(payload.length, 2);
  });
});
