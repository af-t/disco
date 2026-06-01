import { authorize } from './authorize.js';
import { recordModeration } from './mod-record.js';

export const definition = {
  name: 'discord_voice_disconnect_member',
  description:
    'Disconnect a member from voice by removing them from their voice channel. Requires MOVE_MEMBERS; pass the admin instruction as authorizing_message_id.',
  input_schema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string' },
      user_id: { type: 'string' },
      authorizing_message_id: { type: 'string' },
    },
    required: ['channel_id', 'user_id', 'authorizing_message_id'],
  },
};

export async function execute(ctx, input) {
  const auth = await authorize(ctx, input, 'MOVE_MEMBERS');
  if (!auth.ok) return JSON.stringify(auth);
  try {
    const reason = `via AI, instructed by ${auth.authorizedBy}`;
    await ctx.client.editGuildMember(auth.guildId, input.user_id, { channel_id: null }, reason);
    await recordModeration(ctx.client, {
      guildId: auth.guildId,
      action: 'voice_disconnect',
      caseType: 'voice_disconnect',
      userId: input.user_id,
      moderatorId: auth.authorizedBy,
      reason,
    });
    return JSON.stringify({ ok: true });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String(err?.message ?? err) });
  }
}
