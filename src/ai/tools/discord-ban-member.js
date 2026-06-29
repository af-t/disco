import { authorize } from './authorize.js';
import { executeModeration } from './mod-record.js';

export const definition = {
  name: 'discord_ban_member',
  description:
    'Ban a member from the guild. Moderation action requiring BAN_MEMBERS; pass the admin instruction as authorizing_message_id.',
  input_schema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string' },
      user_id: { type: 'string' },
      reason: { type: 'string' },
      delete_message_seconds: {
        type: 'integer',
        description: 'Seconds of the user recent messages to purge (0-604800).',
      },
      authorizing_message_id: { type: 'string' },
    },
    required: ['channel_id', 'user_id', 'authorizing_message_id'],
  },
};

export async function execute(ctx, input) {
  const auth = await authorize(ctx, input, 'BAN_MEMBERS');
  if (!auth.ok) return JSON.stringify(auth);
  const reason = `${input.reason ?? 'No reason provided'} (via AI, instructed by ${auth.authorizedBy})`;
  return executeModeration(ctx, input, auth, 'ban', reason, async () => {
    const options = { reason };
    if (input.delete_message_seconds != null) options.delete_message_seconds = input.delete_message_seconds;
    await ctx.client.banMember(auth.guildId, input.user_id, options);
  });
}
