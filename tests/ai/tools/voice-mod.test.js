import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as vmute from '../../../src/ai/tools/discord-voice-mute-member.js';
import * as vdeaf from '../../../src/ai/tools/discord-voice-deafen-member.js';
import * as vdisc from '../../../src/ai/tools/discord-voice-disconnect-member.js';
import { gatedCtx } from './test_helper.js';

describe('voice moderation tools', () => {
  it('discord_voice_mute_member sets mute with an attributed audit reason', async () => {
    const calls = [];
    const { ctx } = gatedCtx({
      rest: { editGuildMember: async (g, u, body, reason) => calls.push([g, u, body, reason]) },
    });
    const out = JSON.parse(
      await vmute.execute(ctx, { channel_id: 'c1', user_id: 'u9', mute: true, authorizing_message_id: 'm-admin' }),
    );
    assert.equal(out.ok, true);
    assert.deepEqual(calls[0][2], { mute: true });
    assert.match(calls[0][3], /instructed by a1/);
  });

  it('discord_voice_deafen_member sets deaf', async () => {
    const calls = [];
    const { ctx } = gatedCtx({ rest: { editGuildMember: async (g, u, body) => calls.push([g, u, body]) } });
    const out = JSON.parse(
      await vdeaf.execute(ctx, { channel_id: 'c1', user_id: 'u9', deaf: true, authorizing_message_id: 'm-admin' }),
    );
    assert.equal(out.ok, true);
    assert.deepEqual(calls[0][2], { deaf: true });
  });

  it('discord_voice_disconnect_member sets channel_id null', async () => {
    const calls = [];
    const { ctx } = gatedCtx({ rest: { editGuildMember: async (g, u, body) => calls.push([g, u, body]) } });
    const out = JSON.parse(
      await vdisc.execute(ctx, { channel_id: 'c1', user_id: 'u9', authorizing_message_id: 'm-admin' }),
    );
    assert.equal(out.ok, true);
    assert.deepEqual(calls[0][2], { channel_id: null });
  });
});
