import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createCase } from '../../src/lib/case.js';

// Memory store whose async get/set yield to the event loop, so an
// unsynchronized read-modify-write on the counter would interleave.
function memoryClient() {
  const map = new Map();
  return {
    store: {
      get: async (k) => map.get(k),
      set: async (k, v) => void map.set(k, v),
    },
    _map: map,
  };
}

describe('createCase', () => {
  it('assigns sequential ids and persists each case', async () => {
    const client = memoryClient();
    const id1 = await createCase(client, 'g1', 'ban', 'u1', 'mod1', 'first');
    const id2 = await createCase(client, 'g1', 'kick', 'u2', 'mod1', 'second');
    assert.equal(id1, 1);
    assert.equal(id2, 2);
    assert.equal(client._map.get('modcase:g1:1').user_id, 'u1');
    assert.equal(client._map.get('modcase:g1:2').user_id, 'u2');
  });

  it('gives every concurrent case a unique id in the same guild', async () => {
    const client = memoryClient();
    const ids = await Promise.all(
      Array.from({ length: 10 }, (_, i) => createCase(client, 'g1', 'ban', `u${i}`, 'mod1')),
    );
    assert.equal(new Set(ids).size, 10);
    assert.deepEqual(
      [...ids].sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    // Every case record survives — none overwritten by a colliding id.
    for (let i = 1; i <= 10; i++) {
      assert.ok(client._map.get(`modcase:g1:${i}`));
    }
  });

  it('keeps separate counters per guild', async () => {
    const client = memoryClient();
    const [a, b] = await Promise.all([
      createCase(client, 'g1', 'ban', 'u1', 'mod1'),
      createCase(client, 'g2', 'ban', 'u1', 'mod1'),
    ]);
    assert.equal(a, 1);
    assert.equal(b, 1);
  });
});
