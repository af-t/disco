import Engine from './engine.js';
import util from '../lib/utility.js';
import { serialize } from 'node:v8';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';

const server = createServer((req, res) => {
  res.writeHead(200);
  res.end('server ok\n');
});
const wss = new WebSocketServer({ server });

let store = null;
let connected = 0;

wss.on('connection', (ws, req) => {
  setTimeout(() => ws.close(), 180_000);
  connected++;

  ws.on('message', async(m) => {
    try {
      m = JSON.parse(m);
    } catch {
      ws.send('unsupported message');
      ws.close();
      return;
    }

    const { op, id, args } = m;

    if (op === 'new') {
      if (!store) {
        store = new Engine({ ...args[0], logger: util.Logger }, ...args.slice(1));
      }
      ws.send(serialize({ id, data: null }));
      return;
    }

    if (op === 'close') {
      ws.send(serialize({ id }));
      if (connected === 1) {
        await store.close();
        store = null;
      }
      return;
    }

    if (op in store && typeof store[op] === 'function') {
      let data;
      try {
        data = await store[op](...args);
      } finally {
        ws.send(serialize({ id, data }));
        return;
      }
    }

    if (op === 'set-attr') {
      store[op] = args;
      ws.send(serialize({ id, data: args }));
      return;
    }

    if (op === 'get-attr') {
      ws.send(serialize({ id, data: store[op] }));
      return;
    }
  });

  ws.on('close', () => connected--);
});

server.listen(process.env.STORE_SERVER_PORT || 3000);
['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, async () => { await store?.close?.(); }));
