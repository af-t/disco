import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import Engine from '../../src/store/engine.js';

test('StoreManager (Engine) should set and get values', async () => {
  const diskPath = join(process.cwd(), 'tests_tmp_engine');
  const engine = new Engine({ diskPath });
  await engine.ready();

  try {
    await engine.set('foo', { bar: 123 });
    const val = await engine.get('foo');
    assert.deepStrictEqual(val, { bar: 123 });

    const hasFoo = await engine.has('foo');
    assert.strictEqual(hasFoo, true);

    await engine.delete('foo');
    const valAfterDelete = await engine.get('foo');
    assert.strictEqual(valAfterDelete, undefined);
  } finally {
    await engine.close();
    await fs.rm(diskPath, { recursive: true, force: true });
  }
});

test('StoreManager should clear all data', async () => {
  const diskPath = join(process.cwd(), 'tests_tmp_engine_clear');
  const engine = new Engine({ diskPath });
  await engine.ready();

  try {
    await engine.set('a', 1);
    await engine.set('b', 2);
    await engine.clear();

    assert.strictEqual(await engine.get('a'), undefined);
    assert.strictEqual(await engine.get('b'), undefined);
  } finally {
    await engine.close();
    await fs.rm(diskPath, { recursive: true, force: true });
  }
});

test('StoreManager (Engine) should return metadata and stats', async () => {
  const diskPath = join(process.cwd(), 'tests_tmp_engine_meta');
  const engine = new Engine({ diskPath });
  await engine.ready();

  try {
    await engine.set('meta', 'data');
    const meta = await engine.metadata('meta');
    assert.strictEqual(meta.location, 0); // LOCATION.MEMORY
    assert.ok(meta.created > 0);

    const stats = await engine.getStats();
    assert.strictEqual(stats.storage.totalItems, 1);
    assert.strictEqual(stats.storage.itemsInMemory, 1);
  } finally {
    await engine.close();
    await fs.rm(diskPath, { recursive: true, force: true });
  }
});
