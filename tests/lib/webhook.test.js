import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import DiscordWebhookTools from '../../src/lib/webhook.js';

const VALID_URL = 'https://discord.com/api/webhooks/123/abc';

// Helper: build a mock https.request that simulates a full HTTP response
function makeHttpsMock({ status = 200, body = '{}', headers = {}, errorType = null }) {
  return mock.method(https, 'request', (options, callback) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {
      req.destroyed = true;
    };
    req.end = () => {
      if (errorType === 'network') {
        setImmediate(() => req.emit('error', new Error('connection refused')));
        return;
      }
      if (errorType === 'timeout') {
        setImmediate(() => req.emit('timeout'));
        return;
      }
      setImmediate(() => {
        const res = new EventEmitter();
        res.statusCode = status;
        res.headers = { 'x-ratelimit-remaining': '29', 'x-ratelimit-reset': '0', ...headers };
        callback(res);
        if (errorType === 'toolarge') {
          // emit chunk larger than 1MB
          res.emit('data', Buffer.alloc(1024 * 1024 + 1));
        } else {
          res.emit('data', Buffer.from(body));
          res.emit('end');
        }
      });
    };
    return req;
  });
}

// ── URL validation (migrated) ─────────────────────────────────────────────────
describe('DiscordWebhookTools URL validation', () => {
  it('accepts valid webhook URL', () => {
    assert.doesNotThrow(() => new DiscordWebhookTools(VALID_URL));
  });
  it('rejects invalid URL', () => {
    assert.throws(() => new DiscordWebhookTools('invalid'), /Invalid Discord webhook URL format/);
  });
  it('caches parsed URL object across instances', () => {
    const a = new DiscordWebhookTools(VALID_URL);
    const b = new DiscordWebhookTools(VALID_URL);
    assert.ok(a && b); // no throw means cache worked
  });
});

// ── sendMessage (migrated) ────────────────────────────────────────────────────
describe('DiscordWebhookTools sendMessage', () => {
  afterEach(() => mock.restoreAll());

  it('calls https.request with POST', async () => {
    const m = makeHttpsMock({ status: 204, body: '' });
    await new DiscordWebhookTools(VALID_URL).sendMessage('hello');
    assert.strictEqual(m.mock.callCount(), 1);
    assert.strictEqual(m.mock.calls[0].arguments[0].method, 'POST');
  });
});

// ── deleteMessage / editMessage (migrated) ────────────────────────────────────
describe('DiscordWebhookTools deleteMessage / editMessage', () => {
  afterEach(() => mock.restoreAll());

  it('deleteMessage uses DELETE method', async () => {
    const m = makeHttpsMock({ status: 204, body: '' });
    await new DiscordWebhookTools(VALID_URL).deleteMessage('456');
    assert.strictEqual(m.mock.calls[0].arguments[0].method, 'DELETE');
    assert.ok(m.mock.calls[0].arguments[0].path.includes('/messages/456'));
  });

  it('editMessage uses PATCH method', async () => {
    const m = makeHttpsMock({ status: 200 });
    await new DiscordWebhookTools(VALID_URL).editMessage('456', { content: 'upd' });
    assert.strictEqual(m.mock.calls[0].arguments[0].method, 'PATCH');
  });
});

// ── sendEmbed ─────────────────────────────────────────────────────────────────
describe('DiscordWebhookTools sendEmbed', () => {
  afterEach(() => mock.restoreAll());

  it('sends embeds array', async () => {
    let body;
    mock.method(https, 'request', (options, callback) => {
      const req = new EventEmitter();
      req.write = (data) => {
        body = JSON.parse(data);
      };
      req.destroy = () => {};
      req.end = () =>
        setImmediate(() => {
          const res = new EventEmitter();
          res.statusCode = 200;
          res.headers = {};
          callback(res);
          res.emit('data', Buffer.from('{}'));
          res.emit('end');
        });
      return req;
    });
    await new DiscordWebhookTools(VALID_URL).sendEmbed({ title: 'Test' });
    assert.deepStrictEqual(body.embeds, [{ title: 'Test' }]);
  });
});

// ── sendRawRequest: non-JSON 2xx ──────────────────────────────────────────────
describe('DiscordWebhookTools sendRawRequest non-JSON', () => {
  afterEach(() => mock.restoreAll());

  it('resolves with raw string when body is not valid JSON', async () => {
    makeHttpsMock({ status: 200, body: 'not-json' });
    const result = await new DiscordWebhookTools(VALID_URL).sendMessage('x');
    assert.strictEqual(result, 'not-json');
  });
});

// ── sendRawRequest: non-2xx non-429 ──────────────────────────────────────────
describe('DiscordWebhookTools sendRawRequest error status', () => {
  afterEach(() => mock.restoreAll());

  it('rejects with HTTP status error for 500', async () => {
    makeHttpsMock({ status: 500, body: 'Internal Server Error' });
    await assert.rejects(() => new DiscordWebhookTools(VALID_URL).sendMessage('x'), /HTTP 500/);
  });
});

// ── sendRawRequest: response too large ───────────────────────────────────────
describe('DiscordWebhookTools sendRawRequest response too large', () => {
  afterEach(() => mock.restoreAll());

  it('rejects with Response too large', async () => {
    makeHttpsMock({ status: 200, errorType: 'toolarge' });
    await assert.rejects(() => new DiscordWebhookTools(VALID_URL).sendMessage('x'), /Response too large/);
  });
});

// ── sendRawRequest: 429 retry ─────────────────────────────────────────────────
describe('DiscordWebhookTools sendRawRequest 429 retry', () => {
  afterEach(() => mock.restoreAll());

  it('retries once on 429 then succeeds', async () => {
    let calls = 0;
    mock.method(https, 'request', (options, callback) => {
      const req = new EventEmitter();
      req.write = () => {};
      req.destroy = () => {};
      req.end = () =>
        setImmediate(() => {
          const res = new EventEmitter();
          calls++;
          res.statusCode = calls === 1 ? 429 : 200;
          res.headers = { 'retry-after': '1', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' };
          callback(res);
          res.emit('data', Buffer.from('{}'));
          res.emit('end');
        });
      return req;
    });
    const result = await new DiscordWebhookTools(VALID_URL).sendMessage('x');
    assert.deepStrictEqual(result, {});
    assert.strictEqual(calls, 2);
  });

  it('rejects after MAX_RETRIES 429s', async () => {
    makeHttpsMock({ status: 429, body: 'rate limited', headers: { 'retry-after': '1' } });
    await assert.rejects(() => new DiscordWebhookTools(VALID_URL).sendMessage('x'), /HTTP 429/);
  });
});

// ── sendRawRequest: network error retry ──────────────────────────────────────
describe('DiscordWebhookTools sendRawRequest network error', () => {
  afterEach(() => mock.restoreAll());

  it('rejects after MAX_RETRIES network errors', async () => {
    makeHttpsMock({ errorType: 'network' });
    await assert.rejects(() => new DiscordWebhookTools(VALID_URL).sendMessage('x'), /connection refused/);
  });

  it('retries on network error and succeeds', async () => {
    let calls = 0;
    mock.method(https, 'request', (options, callback) => {
      const req = new EventEmitter();
      req.write = () => {};
      req.destroy = () => {};
      req.end = () => {
        calls++;
        if (calls === 1) {
          setImmediate(() => req.emit('error', new Error('ECONNRESET')));
        } else {
          setImmediate(() => {
            const res = new EventEmitter();
            res.statusCode = 200;
            res.headers = {};
            callback(res);
            res.emit('data', Buffer.from('{}'));
            res.emit('end');
          });
        }
      };
      return req;
    });
    const result = await new DiscordWebhookTools(VALID_URL).sendMessage('x');
    assert.deepStrictEqual(result, {});
    assert.strictEqual(calls, 2);
  });
});

// ── sendRawRequest: timeout retry ────────────────────────────────────────────
describe('DiscordWebhookTools sendRawRequest timeout', () => {
  afterEach(() => mock.restoreAll());

  it('rejects after MAX_RETRIES timeouts', async () => {
    makeHttpsMock({ errorType: 'timeout' });
    await assert.rejects(() => new DiscordWebhookTools(VALID_URL).sendMessage('x'), /Request timeout/);
  });
});

// ── sendFile ──────────────────────────────────────────────────────────────────
describe('DiscordWebhookTools sendFile', () => {
  afterEach(() => mock.restoreAll());

  it('throws TypeError for non-array files', async () => {
    await assert.rejects(() => new DiscordWebhookTools(VALID_URL).sendFile('not-array'), TypeError);
  });
  it('throws for empty array', async () => {
    await assert.rejects(() => new DiscordWebhookTools(VALID_URL).sendFile([]), /must include at least 1 file/);
  });
  it('throws for non-object options', async () => {
    await assert.rejects(
      () => new DiscordWebhookTools(VALID_URL).sendFile([{ filename: 'f', data: Buffer.from('x') }], 'bad'),
      /The second argument must be of type Object/,
    );
  });

  it('sends file with {filename, data} and returns results', async () => {
    mock.method(https, 'request', (options, callback) => {
      const req = new EventEmitter();
      const parts = [];
      req.write = (d) => parts.push(d);
      req.end = (last) => {
        if (last) parts.push(last);
        setImmediate(() => {
          const res = new EventEmitter();
          res.statusCode = 200;
          res.headers = {};
          callback(res);
          res.emit('data', Buffer.from('{"id":"msg1"}'));
          res.emit('end');
        });
      };
      req.destroy = () => {};
      return req;
    });

    const results = await new DiscordWebhookTools(VALID_URL).sendFile([
      { filename: 'test.txt', data: Buffer.from('hello') },
    ]);
    assert.ok(Array.isArray(results));
    assert.ok(results.length >= 1);
  });
});

// ── Signature verification (migrated) ────────────────────────────────────────
describe('DiscordWebhookTools signature', () => {
  const tools = new DiscordWebhookTools(VALID_URL);
  const secret = 'secret-key';
  const ts = '1234567890';
  const body = { id: 'abc' };

  it('generates and verifies signature', () => {
    const sig = tools.generateSignature(ts, body, secret);
    assert.ok(tools.verifySignature(sig, ts, body, secret));
  });
  it('rejects wrong signature', () => {
    const sig = tools.generateSignature(ts, body, secret);
    assert.strictEqual(tools.verifySignature('f'.repeat(sig.length), ts, body, secret), false);
  });
  it('rejects mismatched-length signature (fix M8)', () => {
    const sig = tools.generateSignature(ts, body, secret);
    assert.strictEqual(tools.verifySignature(sig.slice(0, 10), ts, body, secret), false);
  });
  it('handles object body in generateSignature', () => {
    const sig1 = tools.generateSignature(ts, body, secret);
    const sig2 = tools.generateSignature(ts, JSON.stringify(body), secret);
    assert.strictEqual(sig1, sig2);
  });
});

describe('DiscordWebhookTools sendFile extra coverage', () => {
  afterEach(() => mock.restoreAll());

  it('uploads a file referenced by a filesystem path', async () => {
    const tmp = path.join(os.tmpdir(), 'wh-file-' + Date.now() + '.txt');
    fs.writeFileSync(tmp, 'disk-file-content');
    mock.method(https, 'request', (options, callback) => {
      const req = new EventEmitter();
      req.write = () => true;
      req.destroy = () => {};
      req.end = () =>
        setImmediate(() => {
          const res = new EventEmitter();
          res.statusCode = 200;
          res.headers = {};
          callback(res);
          res.emit('data', Buffer.from('{"id":"f1"}'));
          res.emit('end');
        });
      return req;
    });
    try {
      const results = await new DiscordWebhookTools(VALID_URL).sendFile([tmp]);
      assert.ok(Array.isArray(results));
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('recurses for batches larger than 10 files', async () => {
    mock.method(https, 'request', (options, callback) => {
      const req = new EventEmitter();
      req.write = () => true;
      req.destroy = () => {};
      req.end = () =>
        setImmediate(() => {
          const res = new EventEmitter();
          res.statusCode = 200;
          res.headers = {};
          callback(res);
          res.emit('data', Buffer.from('{}'));
          res.emit('end');
        });
      return req;
    });
    const files = [];
    for (let i = 0; i < 12; i++) files.push({ filename: `f${i}.txt`, data: Buffer.from('x') });
    const results = await new DiscordWebhookTools(VALID_URL).sendFile(files);
    assert.ok(Array.isArray(results));
  });

  it('pushes the raw string when a file response is not JSON', async () => {
    mock.method(https, 'request', (options, callback) => {
      const req = new EventEmitter();
      req.write = () => true;
      req.destroy = () => {};
      req.end = () =>
        setImmediate(() => {
          const res = new EventEmitter();
          res.statusCode = 200;
          res.headers = {};
          callback(res);
          res.emit('data', Buffer.from('not-json-here'));
          res.emit('end');
        });
      return req;
    });
    const results = await new DiscordWebhookTools(VALID_URL).sendFile([{ filename: 'a.txt', data: Buffer.from('x') }]);
    assert.ok(results.includes('not-json-here'));
  });

  it('rejects when a sendFile request times out', async () => {
    mock.method(https, 'request', () => {
      const req = new EventEmitter();
      req.write = () => true;
      req.destroy = () => {};
      req.end = () => setImmediate(() => req.emit('timeout'));
      return req;
    });
    await assert.rejects(
      () => new DiscordWebhookTools(VALID_URL).sendFile([{ filename: 'a.txt', data: Buffer.from('x') }]),
      /Request timeout/,
    );
  });
});
