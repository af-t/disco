import test from 'node:test';
import assert from 'node:assert';
import https from 'node:https';
import DiscordWebhookTools from '../../src/lib/webhook.js';

test('DiscordWebhookTools should validate webhook URL', () => {
  const validUrl = 'https://discord.com/api/webhooks/123/abc';
  const tools = new DiscordWebhookTools(validUrl);
  assert.strictEqual(typeof tools, 'object');

  assert.throws(() => new DiscordWebhookTools('invalid-url'), /Invalid Discord webhook URL format/);
});

test('DiscordWebhookTools.sendMessage should call https.request', async (t) => {
  const validUrl = 'https://discord.com/api/webhooks/123/abc';
  const tools = new DiscordWebhookTools(validUrl);

  const requestMock = t.mock.method(https, 'request', (options, callback) => {
    assert.strictEqual(options.hostname, 'discord.com');
    assert.strictEqual(options.method, 'POST');

    const mockRes = {
      statusCode: 204,
      headers: { 'x-ratelimit-remaining': '29' },
      on: (event, handler) => {
        if (event === 'end') setTimeout(handler, 0);
      },
    };
    callback(mockRes);
    return {
      on: () => {},
      write: () => {},
      end: () => {},
    };
  });

  await tools.sendMessage('test message');
  assert.strictEqual(requestMock.mock.callCount(), 1);
});

test('DiscordWebhookTools.deleteMessage should call https.request with DELETE', async (t) => {
  const tools = new DiscordWebhookTools('https://discord.com/api/webhooks/123/abc');

  const requestMock = t.mock.method(https, 'request', (options, callback) => {
    assert.strictEqual(options.method, 'DELETE');
    assert.ok(options.path.includes('/messages/456'));

    const mockRes = {
      statusCode: 204,
      headers: {},
      on: (event, handler) => {
        if (event === 'end') setTimeout(handler, 0);
      },
    };
    callback(mockRes);
    return { on: () => {}, write: () => {}, end: () => {} };
  });

  await tools.deleteMessage('456');
  assert.strictEqual(requestMock.mock.callCount(), 1);
});

test('DiscordWebhookTools.editMessage should call https.request with PATCH', async (t) => {
  const tools = new DiscordWebhookTools('https://discord.com/api/webhooks/123/abc');

  const requestMock = t.mock.method(https, 'request', (options, callback) => {
    assert.strictEqual(options.method, 'PATCH');
    assert.ok(options.path.includes('/messages/456'));

    const mockRes = {
      statusCode: 200,
      headers: {},
      on: (event, handler) => {
        if (event === 'end') setTimeout(handler, 0);
      },
    };
    callback(mockRes);
    return { on: () => {}, write: () => {}, end: () => {} };
  });

  await tools.editMessage('456', { content: 'updated' });
  assert.strictEqual(requestMock.mock.callCount(), 1);
});

test('DiscordWebhookTools signature generation and verification', () => {
  const tools = new DiscordWebhookTools('https://discord.com/api/webhooks/123/abc');
  const secret = 'secret-key';
  const timestamp = '1234567890';
  const body = { id: 'abc' };

  const signature = tools.generateSignature(timestamp, body, secret);
  assert.strictEqual(typeof signature, 'string');
  assert.ok(signature.length > 0);

  const isValid = tools.verifySignature(signature, timestamp, body, secret);
  assert.strictEqual(isValid, true);

  const isInvalid = tools.verifySignature('f'.repeat(signature.length), timestamp, body, secret);
  assert.strictEqual(isInvalid, false);
});

test('verifySignature should return false for mismatched-length signature (fix M8)', () => {
  const tools = new DiscordWebhookTools('https://discord.com/api/webhooks/123/abc');
  const secret = 'secret-key';
  const timestamp = '1234567890';
  const body = { id: 'abc' };

  const validSig = tools.generateSignature(timestamp, body, secret);
  // Truncate the signature to create a length mismatch
  const shortSig = validSig.slice(0, 10);

  assert.strictEqual(
    tools.verifySignature(shortSig, timestamp, body, secret),
    false,
    'Short signature should fail length guard',
  );
  assert.strictEqual(
    tools.verifySignature(shortSig + 'extra', timestamp, body, secret),
    false,
    'Longer signature should fail length guard',
  );
});
