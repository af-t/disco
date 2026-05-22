import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert';

afterEach(() => mock.restoreAll());

describe('ai/index init', () => {
  it('returns null when AI_NATURAL_MODE is not enabled', async () => {
    const prev = process.env.AI_NATURAL_MODE;
    process.env.AI_NATURAL_MODE = '0';
    const { init } = await import('../../src/ai/index.js');
    const result = await init({ _session: { user: { id: 'B', username: 'Bot' } }, store: {} });
    assert.equal(result, null);
    process.env.AI_NATURAL_MODE = prev;
  });
});
