import { authorize } from './authorize.js';

export const definition = {
  name: 'discord_bulk_delete',
  description:
    'Bulk-delete 2 to 100 recent messages (younger than 14 days) in this channel. Moderation action requiring MANAGE_MESSAGES; pass the admin instruction as authorizing_message_id.',
  input_schema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string' },
      message_ids: { type: 'array', items: { type: 'string' }, description: '2 to 100 message ids to delete.' },
      authorizing_message_id: { type: 'string' },
    },
    required: ['channel_id', 'message_ids', 'authorizing_message_id'],
  },
};

export async function execute(ctx, input) {
  const auth = await authorize(ctx, input, 'MANAGE_MESSAGES');
  if (!auth.ok) return JSON.stringify(auth);
  try {
    await ctx.client.bulkDeleteMessages(input.channel_id, input.message_ids);
    return JSON.stringify({ ok: true, deleted: input.message_ids.length });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String(err?.message ?? err) });
  }
}
