import { formatToolError } from './error.js';
import { authorize } from './authorize.js';

export const definition = {
  name: 'discord_edit_guild',
  description:
    'Edit guild (server) settings. Admin action requiring MANAGE_GUILD; pass the admin instruction as authorizing_message_id.',
  inputSchema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string' },
      options: { type: 'object', description: 'Discord guild fields (name, description, afk_channel_id, ...).' },
      authorizing_message_id: { type: 'string' },
    },
    required: ['channel_id', 'options', 'authorizing_message_id'],
  },
};

export async function execute(ctx, input) {
  const auth = await authorize(ctx, input, 'MANAGE_GUILD');
  if (!auth.ok) return JSON.stringify(auth);
  try {
    await ctx.client.modifyGuild(auth.guildId, input.options ?? {});
    return JSON.stringify({ ok: true });
  } catch (err) {
    return JSON.stringify({ ok: false, error: formatToolError(err) });
  }
}
