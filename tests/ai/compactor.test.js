import test from 'node:test';
import assert from 'node:assert';
import { shouldCompact, compact } from '../../src/ai/compactor.js';

test('shouldCompact returns false below threshold', () => {
  const msgs = Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  assert.equal(shouldCompact(msgs, 100), false);
});

test('shouldCompact returns true above threshold', () => {
  const msgs = Array.from({ length: 101 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  assert.equal(shouldCompact(msgs, 100), true);
});

test('compact preserves the tail and replaces head with summary', async () => {
  const msgs = Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  let summarizerCalls = 0;
  const summarizer = async (toSummarize) => {
    summarizerCalls++;
    return `SUMMARY of ${toSummarize.length} msgs`;
  };
  const out = await compact(msgs, { keepTail: 10, summarizer });
  assert.equal(summarizerCalls, 1);
  assert.equal(out.length, 11);
  assert.equal(out[0].role, 'system');
  assert.match(out[0].content, /\[compacted:/);
  assert.equal(out[out.length - 1].content, 'm29');
});

test('compact returns input untouched if length <= keepTail', async () => {
  const msgs = Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  const out = await compact(msgs, { keepTail: 10, summarizer: async () => 'x' });
  assert.deepEqual(out, msgs);
});
