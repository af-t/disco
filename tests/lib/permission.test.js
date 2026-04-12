import test from 'node:test';
import assert from 'node:assert';
import permissionFlags from '../../src/lib/permission.js';

test('permissionFlags should contain expected Discord permissions', () => {
  assert.strictEqual(permissionFlags.CREATE_INSTANT_INVITE, 1n << 0n);
  assert.strictEqual(permissionFlags.KICK_MEMBERS, 1n << 1n);
  assert.strictEqual(permissionFlags.ADMINISTRATOR, 1n << 3n);
  assert.strictEqual(permissionFlags.SEND_MESSAGES, 1n << 11n);
  assert.strictEqual(permissionFlags.USE_APPLICATION_COMMANDS, 1n << 31n);
  assert.ok('MODERATE_MEMBERS' in permissionFlags);
});
