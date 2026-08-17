import { after, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deserialize } from 'node:v8';

let connectionHandler;
let shutdownHandler;
let store;

class FakeEngine {
  constructor() {
    store = this;
  }

  async ping(value) {
    return value;
  }

  async close() {
    return true;
  }
}

mock.module('../../src/store/engine.js', { exports: { default: FakeEngine } });
mock.module('node:http', {
  exports: {
    createServer() {
      return {
        listen() {},
        close() {},
        on(signal, handler) {
          if (signal === 'SIGTERM') shutdownHandler = handler;
        },
      };
    },
  },
});
mock.module('ws', {
  exports: {
    WebSocketServer: class {
      constructor() {}

      on(event, handler) {
        if (event === 'connection') connectionHandler = handler;
      }
    },
  },
});

await import('../../src/store/server.js');

const openConnections = [];

function connect() {
  const listeners = new Map();
  const ws = {
    _socket: { setNoDelay() {} },
    sent: [],
    on(event, handler) {
      listeners.set(event, handler);
    },
    send(payload) {
      this.sent.push(deserialize(payload));
    },
    close() {
      listeners.get('close')?.();
    },
  };
  const req = { socket: { remoteAddress: `test-${Math.random()}`, setNoDelay() {} } };
  connectionHandler(ws, req);
  openConnections.push(ws);
  return { ws, message: listeners.get('message') };
}

async function request(ws, message, op, args) {
  await message(JSON.stringify({ id: `${op}-${Math.random()}`, op, args }));
  return ws.sent.at(-1);
}

describe('store server attribute operations', () => {
  it('sets and gets the requested attribute without creating operation-named properties', async () => {
    const { ws, message } = connect();
    await request(ws, message, 'new', [{}]);
    const setResponse = await request(ws, message, 'set-attr', ['maxMemory', 123]);
    const getResponse = await request(ws, message, 'get-attr', ['maxMemory']);

    assert.equal(setResponse.data, true);
    assert.equal(getResponse.data, 123);
    assert.strictEqual(store.maxMemory, 123);
    assert.equal('set-attr' in store, false);
    assert.equal('get-attr' in store, false);
  });

  it('rejects empty and non-string attribute names', async () => {
    const { ws, message } = connect();
    await request(ws, message, 'new', [{}]);

    await assert.rejects(
      () => request(ws, message, 'set-attr', ['', 123]),
      /Attribute name must be a non-empty string/,
    );
    await assert.rejects(() => request(ws, message, 'get-attr', [123]), /Attribute name must be a non-empty string/);
  });

  it('continues dispatching existing store operations', async () => {
    const { ws, message } = connect();
    await request(ws, message, 'new', [{}]);
    const response = await request(ws, message, 'ping', ['pong']);

    assert.equal(store instanceof FakeEngine, true);
    assert.equal(response.data, 'pong');
  });
});

it('documents STORE_SERVER_URL with a WebSocket URL', async () => {
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');

  assert.match(readme, /`STORE_SERVER_URL`\s+\| No\s+\| `ws:\/\/localhost:3000`/);
  assert.doesNotMatch(readme, /`STORE_SERVER_URL`\s+\| No\s+\| `https?:\/\//);
});

after(async () => {
  openConnections.forEach((ws) => ws.close());
  await shutdownHandler?.();
});
