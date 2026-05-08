import test from 'node:test';
import assert from 'node:assert';
import permissionFlags from '../../src/lib/permission.js';

test('permissionFlags should have correct bit values for key permissions', () => {
  assert.strictEqual(permissionFlags.CREATE_INSTANT_INVITE, 1n << 0n);
  assert.strictEqual(permissionFlags.KICK_MEMBERS, 1n << 1n);
  assert.strictEqual(permissionFlags.BAN_MEMBERS, 1n << 2n);
  assert.strictEqual(permissionFlags.ADMINISTRATOR, 1n << 3n);
  assert.strictEqual(permissionFlags.VIEW_CHANNEL, 1n << 10n);
  assert.strictEqual(permissionFlags.SEND_MESSAGES, 1n << 11n);
  assert.strictEqual(permissionFlags.MANAGE_MESSAGES, 1n << 13n);
  assert.strictEqual(permissionFlags.CONNECT, 1n << 20n);
  assert.strictEqual(permissionFlags.SPEAK, 1n << 21n);
  assert.strictEqual(permissionFlags.MODERATE_MEMBERS, 1n << 40n);
});

test('ADMINISTRATOR permission should be 8n', () => {
  assert.strictEqual(permissionFlags.ADMINISTRATOR, 8n);
});

test('MANAGE_MESSAGES permission should be at bit 13', () => {
  assert.strictEqual(permissionFlags.MANAGE_MESSAGES, 8192n);
});

test('permission combination should work with bitwise OR', () => {
  const combined = permissionFlags.BAN_MEMBERS | permissionFlags.KICK_MEMBERS;
  assert.ok((combined & permissionFlags.BAN_MEMBERS) === permissionFlags.BAN_MEMBERS);
  assert.ok((combined & permissionFlags.KICK_MEMBERS) === permissionFlags.KICK_MEMBERS);
  assert.ok(!(combined & permissionFlags.ADMINISTRATOR));
});

test('ADMINISTRATOR bit check identifies admin', () => {
  const adminPerms = 8n; // ADMINISTRATOR
  assert.strictEqual((adminPerms & 8n) === 8n, true);
});

test('ADMINISTRATOR bit check identifies non-admin', () => {
  const basicPerms = permissionFlags.VIEW_CHANNEL | permissionFlags.SEND_MESSAGES;
  assert.strictEqual((basicPerms & 8n) === 8n, false);
});

test('permissionFlags should contain MODERATE_MEMBERS', () => {
  assert.ok('MODERATE_MEMBERS' in permissionFlags);
});

test('permissionFlags should contain SEND_POLLS', () => {
  assert.ok('SEND_POLLS' in permissionFlags);
});
