import { formatToolError } from './error.js';
import { authorize } from './authorize.js';
import { recordModeration } from './mod-record.js';

export const definition = {
  name: 'discord_voice_deafen_member',
  description:
    'Server-deafen or undeafen a member in voice channels. Requires DEAFEN_MEMBERS; pass the admin instruction as authorizing_message_id.',
  input_schema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string' },
      user_id: { type: 'string' },
      deaf: { type: 'boolean', description: 'true to deafen, false to undeafen.' },
      authorizing_message_id: { type: 'string' },
    },
    required: ['channel_id', 'user_id', 'deaf', 'authorizing_message_id'],
  },
};

export async function execute(ctx, input) {
  const auth = await authorize(ctx, input, 'DEAFEN_MEMBERS');
  if (!auth.ok) return JSON.stringify(auth);
  try {
    const reason = `via AI, instructed by ${auth.authorizedBy}`;
    await ctx.client.editGuildMember(auth.guildId, input.user_id, { deaf: input.deaf }, reason);
    await recordModeration(ctx.client, {
      guildId: auth.guildId,
      action: input.deaf ? 'voice_deafen' : 'voice_undeafen',
      caseType: input.deaf ? 'voice_deafen' : 'voice_undeafen',
      userId: input.user_id,
      moderatorId: auth.authorizedBy,
      reason,
    });
    return JSON.stringify({ ok: true });
  } catch (err) {
    return JSON.stringify({ ok: false, error: formatToolError(err) });
  }
}
