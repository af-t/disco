import { authorize } from './authorize.js';
import { executeModeration, standardModActionSchema } from './mod-record.js';

export const definition = standardModActionSchema(
  'discord_voice_mute_member',
  'Mute a member in a voice channel. Moderation action requiring MUTE_MEMBERS; pass the admin instruction as authorizing_message_id.',
);

export async function execute(ctx, input) {
  const auth = await authorize(ctx, input, 'MUTE_MEMBERS');
  if (!auth.ok) return JSON.stringify(auth);
  const reason = `${input.reason ?? 'No reason provided'} (via AI, instructed by ${auth.authorizedBy})`;
  return executeModeration(ctx, input, auth, 'voice_mute', reason, () =>
    ctx.client.editGuildMember(auth.guildId, input.user_id, { mute: input.mute }, reason),
  );
}
