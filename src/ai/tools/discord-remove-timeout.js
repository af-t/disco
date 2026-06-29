import { authorize } from './authorize.js';
import { executeModeration, standardModActionSchema } from './mod-record.js';

export const definition = standardModActionSchema(
  'discord_remove_timeout',
  'Remove a timeout from a member in the guild. Moderation action requiring MODERATE_MEMBERS; pass the admin instruction as authorizing_message_id.',
);

export async function execute(ctx, input) {
  const auth = await authorize(ctx, input, 'MODERATE_MEMBERS');
  if (!auth.ok) return JSON.stringify(auth);
  const reason = `${input.reason ?? 'No reason provided'} (via AI, instructed by ${auth.authorizedBy})`;
  return executeModeration(ctx, input, auth, 'unmute', reason, () =>
    ctx.client.editGuildMember(auth.guildId, input.user_id, { communication_disabled_until: null }, reason),
  );
}
