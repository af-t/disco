import { authorize } from './authorize.js';

export const definition = {
  name: 'discord_delete_message',
  description:
    'Delete a single message in this channel. Moderation action: only valid when an admin/mod with MANAGE_MESSAGES instructed it in chat; pass their instruction id as authorizing_message_id.',
  input_schema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'Channel where the instruction was given and the target lives.' },
      target_message_id: { type: 'string', description: 'The message to delete.' },
      authorizing_message_id: { type: 'string', description: 'Id of the admin instruction authorizing this.' },
    },
    required: ['channel_id', 'target_message_id', 'authorizing_message_id'],
  },
};

export async function execute(ctx, input) {
  const auth = await authorize(ctx, input, 'MANAGE_MESSAGES');
  if (!auth.ok) return JSON.stringify(auth);
  try {
    await ctx.client.deleteMessage(input.channel_id, input.target_message_id);
    return JSON.stringify({ ok: true });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String(err?.message ?? err) });
  }
}
