import test from 'node:test';
import assert from 'node:assert';
import intentBits from '../../src/lib/intents.js';

test('intentBits should contain expected Discord intents', () => {
  assert.strictEqual(intentBits.GUILDS, 1 << 0);
  assert.strictEqual(intentBits.GUILD_MEMBERS, 1 << 1);
  assert.strictEqual(intentBits.GUILD_MESSAGES, 1 << 9);
  assert.strictEqual(intentBits.MESSAGE_CONTENT, 1 << 15);
  assert.ok('GUILD_MESSAGE_POLLS' in intentBits);
});
