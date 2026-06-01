import { authorize } from './authorize.js';

export const definition = {
  name: 'discord_manage_channel',
  description:
    'Create, edit, or delete a channel. Admin action requiring MANAGE_CHANNELS; pass the admin instruction as authorizing_message_id.',
  input_schema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'Channel where the instruction was given (for authorization).' },
      action: { type: 'string', enum: ['create', 'edit', 'delete'] },
      target_channel_id: { type: 'string', description: 'For edit/delete: the channel to act on.' },
      options: {
        type: 'object',
        description: 'For create/edit: Discord channel fields (name, topic, type, parent_id, ...).',
      },
      authorizing_message_id: { type: 'string' },
    },
    required: ['channel_id', 'action', 'authorizing_message_id'],
  },
};

export async function execute(ctx, input) {
  const auth = await authorize(ctx, input, 'MANAGE_CHANNELS');
  if (!auth.ok) return JSON.stringify(auth);
  try {
    switch (input.action) {
      case 'create': {
        const created = await ctx.client.createChannel(auth.guildId, input.options ?? {});
        return JSON.stringify({ ok: true, channel_id: created?.id ?? null });
      }
      case 'edit':
        if (!input.target_channel_id)
          return JSON.stringify({ ok: false, error: 'target_channel_id required for edit' });
        await ctx.client.editChannel(input.target_channel_id, input.options ?? {});
        return JSON.stringify({ ok: true });
      case 'delete':
        if (!input.target_channel_id)
          return JSON.stringify({ ok: false, error: 'target_channel_id required for delete' });
        await ctx.client.deleteChannel(input.target_channel_id);
        return JSON.stringify({ ok: true });
      default:
        return JSON.stringify({ ok: false, error: `unknown action ${input.action}` });
    }
  } catch (err) {
    return JSON.stringify({ ok: false, error: String(err?.message ?? err) });
  }
}
