import Engine from './engine.js';
import util from '../lib/utility.js';
import { serialize } from 'node:v8';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { join } from 'node:path';

const { unrefTimeout } = util;

const server = createServer((req, res) => {
  res.writeHead(204);
  res.end();
});
const wss = new WebSocketServer({ server });
const requestLog = new Map();

const SERVER_DISK_PATH = process.env.STORE_DATA_PATH || join(process.cwd(), 'storage', 'db');

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
  ws._socket?.setNoDelay?.(true);

  // Close connection after 5 minutes of silence
  const IDLE_TIMEOUT_MS = 300_000;
  let idleTimer = null;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = unrefTimeout(() => ws.close(), IDLE_TIMEOUT_MS);
  };
  resetIdle();

  ws.on('message', async (m) => {
    resetIdle(); // reset idle timer on every message
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
        const clientConfig = args[0] || {};
        delete clientConfig.diskPath;
        store = new Engine({ ...clientConfig, diskPath: SERVER_DISK_PATH, logger: util.Logger }, ...args.slice(1));
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

    if (op === 'set-attr') {
      const [attributeName, value] = args;
      if (typeof attributeName !== 'string' || attributeName.length === 0) {
        throw new TypeError('Attribute name must be a non-empty string');
      }
      store[attributeName] = value;
      ws.send(serialize({ id, data: true }));
      return;
    }

    if (op === 'get-attr') {
      const [attributeName] = args;
      if (typeof attributeName !== 'string' || attributeName.length === 0) {
        throw new TypeError('Attribute name must be a non-empty string');
      }
      ws.send(serialize({ id, data: store[attributeName] }));
      return;
    }

    if (op === 'sync') {
      const [sinceSeq] = args;
      const result = store.getInvalidations(sinceSeq);
      ws.send(serialize({ id, data: result }));
      return;
    }

    if (op in store && typeof store[op] === 'function') {
      let data;
      try {
        data = await store[op](...args);
      } finally {
        ws.send(serialize({ id, data }));
      }
      if (op === 'set' || op === 'delete' || op === 'clear') {
        try {
          const seq = store.getCurrentSeq?.() ?? 0;
          const key = op === 'clear' ? '*' : args[0];
          const entries = [{ seq, key, op }];
          const payload = serialize({ op: 'invalidate', entries });
          for (const client of wss.clients) {
            if (client !== ws && client.readyState === 1) client.send(payload);
          }
        } catch {}
      }
      return;
    }
  });

  ws.on('close', () => {
    clearTimeout(idleTimer);
    requestLog.delete(clientIp);
  });
});

server.listen(process.env.STORE_SERVER_PORT || 3000);
['SIGTERM', 'SIGINT'].forEach((sig) =>
  process.on(sig, async () => {
    await new Promise((resolve) => setTimeout(resolve, 2500)); // wait 2.5 sec before shutdown
    await store?.close?.();
    for (const [ip, socket] of requestLog.entries()) {
      socket.destroy();
      requestLog.delete(ip);
    }

    server.close();
  }),
);
