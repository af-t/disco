import test from 'node:test';
import assert from 'node:assert';
import { prefilter } from '../../src/ai/prefilter.js';

const baseCtx = {
  selfId: 'BOT',
  selfMention: '<@BOT>',
  channelState: { cooldownUntil: 0 },
  config: { muted_channels: [] },
  budgetExhausted: false,
};

function mkMsg(over = {}) {
  return {
    id: 'm1',
    guild_id: 'g1',
    channel_id: 'c1',
    content: 'hello',
    author: { id: 'u1', bot: false },
    message_reference: null,
    ...over,
  };
}

test('mute beats mention', () => {
  const ctx = { ...baseCtx, config: { muted_channels: ['c1'] } };
  assert.equal(prefilter(mkMsg({ content: 'yo <@BOT>' }), ctx), 'drop');
});

test('mention bypasses cooldown and budget', () => {
  const ctx = { ...baseCtx, channelState: { cooldownUntil: Date.now() + 60000 }, budgetExhausted: true };
  assert.equal(prefilter(mkMsg({ content: 'yo <@BOT> hi' }), ctx), 'pass-immediate');
});

test('reply to bot is pass-immediate', () => {
  const msg = mkMsg({
    message_reference: { message_id: 'X' },
    referenced_message: { id: 'X', author: { id: 'BOT' } },
  });
  assert.equal(prefilter(msg, baseCtx), 'pass-immediate');
});

test('reply to a non-bot user does not trigger pass-immediate', () => {
  const msg = mkMsg({
    content: 'thanks',
    message_reference: { message_id: 'X' },
    referenced_message: { id: 'X', author: { id: 'u2' } },
  });
  assert.equal(prefilter(msg, baseCtx), 'gate');
});

test('DM is pass-immediate', () => {
  assert.equal(prefilter(mkMsg({ guild_id: undefined }), baseCtx), 'pass-immediate');
});

test('cooldown drops normal message', () => {
  const ctx = { ...baseCtx, channelState: { cooldownUntil: Date.now() + 60000 } };
  assert.equal(prefilter(mkMsg(), ctx), 'drop');
});

test('budget exhausted drops normal message', () => {
  const ctx = { ...baseCtx, budgetExhausted: true };
  assert.equal(prefilter(mkMsg(), ctx), 'drop');
});

test('default case is gate', () => {
  assert.equal(prefilter(mkMsg(), baseCtx), 'gate');
});
