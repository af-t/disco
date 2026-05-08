import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { join } from 'node:path';
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
