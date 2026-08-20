import { formatToolError } from './error.js';
import { authorize } from './authorize.js';
import { recordModeration } from './mod-record.js';

const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

export const definition = {
  name: 'discord_timeout_member',
  description:
    'Time out (mute) a member so they cannot chat or speak, for a duration. Moderation action requiring ' +
    'MODERATE_MEMBERS; pass the admin instruction as authorizing_message_id.',
  inputSchema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string' },
      user_id: { type: 'string', description: 'Member to time out.' },
      duration_seconds: { type: 'integer', description: 'Timeout length in seconds (max 2419200 = 28 days).' },
      reason: { type: 'string' },
      authorizing_message_id: { type: 'string' },
    },
    required: ['channel_id', 'user_id', 'duration_seconds', 'authorizing_message_id'],
  },
};

export async function execute(ctx, input) {
  const auth = await authorize(ctx, input, 'MODERATE_MEMBERS');
  if (!auth.ok) return JSON.stringify(auth);
  try {
    const durationMs = Math.min(Math.max(1, input.duration_seconds) * 1000, MAX_TIMEOUT_MS);
    const until = new Date(Date.now() + durationMs).toISOString();
    const reason = `${input.reason ?? 'No reason provided'} (via AI, instructed by ${auth.authorizedBy})`;
    await ctx.client.editGuildMember(auth.guildId, input.user_id, { communication_disabled_until: until }, reason);
    await recordModeration(ctx.client, {
      guildId: auth.guildId,
      action: 'mute',
      caseType: 'mute',
      userId: input.user_id,
      moderatorId: auth.authorizedBy,
      reason,
      duration: durationMs,
    });
    return JSON.stringify({ ok: true, until });
  } catch (err) {
    return JSON.stringify({ ok: false, error: formatToolError(err) });
  }
}
