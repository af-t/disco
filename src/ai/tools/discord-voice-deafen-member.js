import { authorize } from './authorize.js';
import { executeModeration, standardModActionSchema } from './mod-record.js';

export const definition = standardModActionSchema(
  'discord_voice_deafen_member',
  'Deafen a member in a voice channel. Moderation action requiring DEAFEN_MEMBERS; pass the admin instruction as authorizing_message_id.',
);

export async function execute(ctx, input) {
  const auth = await authorize(ctx, input, 'DEAFEN_MEMBERS');
  if (!auth.ok) return JSON.stringify(auth);
  const reason = `${input.reason ?? 'No reason provided'} (via AI, instructed by ${auth.authorizedBy})`;
  return executeModeration(ctx, input, auth, 'voice_deafen', reason, () =>
    ctx.client.editGuildMember(auth.guildId, input.user_id, { deaf: input.deaf }, reason),
  );
}
