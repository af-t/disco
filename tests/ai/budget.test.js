import test, { describe, it } from 'node:test';
import assert from 'node:assert';
import { createBudget } from '../../src/ai/budget.js';

function makeStoreMock() {
  const data = new Map();
  return {
    data,
    async get(k) {
      return data.get(k);
    },
    async set(k, v) {
      data.set(k, v);
    },
  };
}

test('first call initializes counter to 1 and reports not exhausted', async () => {
  const store = makeStoreMock();
  const budget = createBudget({ store, limit: 5, clock: () => Date.parse('2026-05-19T10:00:00Z') });
  assert.equal(await budget.exhausted('g1'), false);
  await budget.increment('g1');
  assert.equal((await budget.current('g1')).count, 1);
});

test('exhausted returns true at limit', async () => {
  const store = makeStoreMock();
  const budget = createBudget({ store, limit: 2, clock: () => Date.parse('2026-05-19T10:00:00Z') });
  await budget.increment('g1');
  await budget.increment('g1');
  assert.equal(await budget.exhausted('g1'), true);
});

test('new UTC day resets counter implicitly via key rotation', async () => {
  let now = Date.parse('2026-05-19T23:59:00Z');
  const store = makeStoreMock();
  const budget = createBudget({ store, limit: 3, clock: () => now });
  await budget.increment('g1');
  await budget.increment('g1');
  assert.equal((await budget.current('g1')).count, 2);

  now = Date.parse('2026-05-20T00:00:01Z');
  assert.equal((await budget.current('g1')).count, 0);
  assert.equal(await budget.exhausted('g1'), false);
});

test('different guilds have isolated counters', async () => {
  const store = makeStoreMock();
  const budget = createBudget({ store, limit: 10, clock: () => Date.parse('2026-05-19T10:00:00Z') });
  await budget.increment('g1');
  await budget.increment('g1');
  await budget.increment('g2');
  assert.equal((await budget.current('g1')).count, 2);
  assert.equal((await budget.current('g2')).count, 1);
});

describe('createBudget guildId guards', () => {
  it('current returns zero count and null key when guildId is missing', async () => {
    const budget = createBudget({ store: makeStoreMock(), limit: 5 });
    assert.deepStrictEqual(await budget.current(), { count: 0, key: null });
  });

  it('increment is a no-op when guildId is missing', async () => {
    const store = makeStoreMock();
    const budget = createBudget({ store, limit: 5 });
    await budget.increment();
    assert.strictEqual(store.data.size, 0);
  });

  it('exhausted returns false when guildId is missing', async () => {
    const budget = createBudget({ store: makeStoreMock(), limit: 1 });
    assert.strictEqual(await budget.exhausted(), false);
  });
});
