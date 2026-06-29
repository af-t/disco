import { authorize } from './authorize.js';
import { executeModeration, standardModActionSchema } from './mod-record.js';

export const definition = standardModActionSchema(
  'discord_voice_disconnect_member',
  'Disconnect a member from a voice channel. Moderation action requiring MOVE_MEMBERS; pass the admin instruction as authorizing_message_id.',
);

export async function execute(ctx, input) {
  const auth = await authorize(ctx, input, 'MOVE_MEMBERS');
  if (!auth.ok) return JSON.stringify(auth);
  const reason = `${input.reason ?? 'No reason provided'} (via AI, instructed by ${auth.authorizedBy})`;
  return executeModeration(ctx, input, auth, 'voice_disconnect', reason, () =>
    ctx.client.editGuildMember(auth.guildId, input.user_id, { channel_id: null }, reason),
  );
}
