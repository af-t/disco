import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildSystemPrompt, buildTurnInjector, buildCommandSystemPrompt } from '../../src/ai/prompt.js';

describe('buildSystemPrompt', () => {
  it('embeds the bot username into the identity guard', () => {
    const out = buildSystemPrompt({ botUsername: 'Disco' });
    assert.match(out, /You are Disco/);
    assert.match(out, /IDENTITY GUARD/);
  });
});

describe('buildTurnInjector', () => {
  it('uses guild_id and channel name when both are present', () => {
    const out = buildTurnInjector({
      channelId: 'c1',
      channelName: 'general',
      guildId: 'g1',
      newCount: 2,
      contextCount: 5,
    });
    assert.match(out, /guild_id=g1/);
    assert.match(out, /channel_name=general/);
    assert.match(out, /2 new message/);
  });

  it('falls back to DM and unknown when guild and channel name are missing', () => {
    const out = buildTurnInjector({
      channelId: 'c1',
      channelName: null,
      guildId: null,
      newCount: 0,
      contextCount: 0,
    });
    assert.match(out, /guild_id=DM/);
    assert.match(out, /channel_name=unknown/);
  });
});

describe('buildCommandSystemPrompt', () => {
  it('names the bot and the invoking user', () => {
    const out = buildCommandSystemPrompt({ botUsername: 'Disco', userTag: 'alice' });
    assert.match(out, /You are Disco/);
    assert.match(out, /alice/);
    assert.match(out, /Skipping is not an option/);
  });
});
