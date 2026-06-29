import { authorize } from './authorize.js';
import { executeModeration, standardModActionSchema } from './mod-record.js';

export const definition = standardModActionSchema(
  'discord_kick_member',
  'Kick a member from the guild. Moderation action requiring KICK_MEMBERS; pass the admin instruction as authorizing_message_id.',
);

export async function execute(ctx, input) {
  const auth = await authorize(ctx, input, 'KICK_MEMBERS');
  if (!auth.ok) return JSON.stringify(auth);
  const reason = `${input.reason ?? 'No reason provided'} (via AI, instructed by ${auth.authorizedBy})`;
  return executeModeration(ctx, input, auth, 'kick', reason, () =>
    ctx.client.kickMember(auth.guildId, input.user_id, reason),
  );
}
