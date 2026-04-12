import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { join } from 'node:path';
import utility from '../../src/lib/utility.js';

const { Logger, importCommands } = utility;

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

test('importCommands should load commands from a directory', async (t) => {
  const tempDir = join(process.cwd(), 'tests_tmp_commands');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
  
  const commandFile = join(tempDir, 'ping.js');
  fs.writeFileSync(commandFile, `
    export default {
      data: { name: 'ping', description: 'Ping command', aliases: ['p'] },
      execute: async () => 'pong'
    };
  `);

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
