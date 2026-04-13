import Engine from './engine.js';
import util from '../lib/utility.js';
import { serialize } from 'node:v8';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';

const server = createServer((req, res) => {
  res.writeHead(204);
  res.end();
});
const wss = new WebSocketServer({ server });
const requestLog = new Map();

let store = null;

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  if (requestLog.has(clientIp)) {
    const socket = requestLog.get(clientIp);
    socket.destroy();
    requestLog.delete(clientIp);
  }
  requestLog.set(clientIp, req.socket);

  req.socket.setNoDelay(true);
  ws._socket.setNoDelay(true);

  // Apply timeout
  setTimeout(() => req.socket.destroy(), 180_000).unref();

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
      if (requestLog.size === 1) {
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

  ws.on('close', () => requestLog.delete(clientIp));
});

server.listen(process.env.STORE_SERVER_PORT || 3000);
['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, async () => {
  await store?.close?.();
  for (const [ip, socket] of requestLog.entries()) {
    socket.destroy();
    requestLog.delete(ip);
  }

  server.close();
}));
