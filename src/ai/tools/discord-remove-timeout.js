import { formatToolError } from './error.js';
import { authorize } from './authorize.js';
import { recordModeration } from './mod-record.js';

export const definition = {
  name: 'discord_remove_timeout',
  description:
    'Remove an active timeout (unmute) from a member. Requires MODERATE_MEMBERS; pass the admin instruction as authorizing_message_id.',
  input_schema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string' },
      user_id: { type: 'string' },
      reason: { type: 'string' },
      authorizing_message_id: { type: 'string' },
    },
    required: ['channel_id', 'user_id', 'authorizing_message_id'],
  },
};

export async function execute(ctx, input) {
  const auth = await authorize(ctx, input, 'MODERATE_MEMBERS');
  if (!auth.ok) return JSON.stringify(auth);
  try {
    const reason = `${input.reason ?? 'No reason provided'} (via AI, instructed by ${auth.authorizedBy})`;
    await ctx.client.editGuildMember(auth.guildId, input.user_id, { communication_disabled_until: null }, reason);
    await recordModeration(ctx.client, {
      guildId: auth.guildId,
      action: 'unmute',
      caseType: 'unmute',
      userId: input.user_id,
      moderatorId: auth.authorizedBy,
      reason,
    });
    return JSON.stringify({ ok: true });
  } catch (err) {
    return JSON.stringify({ ok: false, error: formatToolError(err) });
  }
}
