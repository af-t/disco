import test from 'node:test';
import assert from 'node:assert';
import EventEmitter from 'node:events';
import StoreClient from '../../src/store/client.js';
import { serialize, deserialize } from 'node:v8';

test('StoreClient should connect and send/receive data', async (t) => {
  const mockWs = new EventEmitter();
  mockWs.readyState = 1; // OPEN
  mockWs.send = t.mock.fn((payload, cb) => {
    const { op, id, args: _args } = JSON.parse(payload);

    // Simulate server response
    setTimeout(() => {
      let data = null;
      if (op === 'get') data = 'pong';

      const buffer = serialize({ id, data });
      mockWs.emit('message', buffer);
    }, 10);

    if (cb) cb();
  });
  mockWs.close = t.mock.fn();
  mockWs.removeAllListeners = t.mock.fn();

  const client = new StoreClient({ url: 'ws://mock' });

  // Directly set the ws and simulate listeners that client.js would add
  client._ws = mockWs;
  client._reconnect = false; // Disable reconnect for test
  client._active = true; // Manually activate for test
  client._startQueueWorker(); // Start the worker

  mockWs.on('message', (buffer) => {
    const { id, data } = deserialize(buffer);
    if (client._pendingRequests.has(id)) {
      const { resolve } = client._pendingRequests.get(id);
      resolve(data);
      client._pendingRequests.delete(id);
    }
  });

  const result = await client.get('test');
  assert.strictEqual(result, 'pong');
  assert.strictEqual(mockWs.send.mock.callCount(), 1);

  // Cleanup — wake the worker so it can exit cleanly
  client._active = false;
  client._notifier?.();
});
