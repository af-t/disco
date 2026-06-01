import { formatToolError } from './error.js';
import { authorize } from './authorize.js';
import { recordModeration } from './mod-record.js';

export const definition = {
  name: 'discord_voice_mute_member',
  description:
    'Server-mute or unmute a member in voice channels. Requires MUTE_MEMBERS; pass the admin instruction as authorizing_message_id.',
  input_schema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string' },
      user_id: { type: 'string' },
      mute: { type: 'boolean', description: 'true to mute, false to unmute.' },
      authorizing_message_id: { type: 'string' },
    },
    required: ['channel_id', 'user_id', 'mute', 'authorizing_message_id'],
  },
};

export async function execute(ctx, input) {
  const auth = await authorize(ctx, input, 'MUTE_MEMBERS');
  if (!auth.ok) return JSON.stringify(auth);
  try {
    const reason = `via AI, instructed by ${auth.authorizedBy}`;
    await ctx.client.editGuildMember(auth.guildId, input.user_id, { mute: input.mute }, reason);
    await recordModeration(ctx.client, {
      guildId: auth.guildId,
      action: input.mute ? 'voice_mute' : 'voice_unmute',
      caseType: input.mute ? 'voice_mute' : 'voice_unmute',
      userId: input.user_id,
      moderatorId: auth.authorizedBy,
      reason,
    });
    return JSON.stringify({ ok: true });
  } catch (err) {
    return JSON.stringify({ ok: false, error: formatToolError(err) });
  }
}
