import { finishSend } from './send-helper.js';
import { channelScopeError } from './scope.js';
export const definition = {
  name: 'discord_send_sticker',
  description:
    'Send one to three stickers (by sticker id) to a channel, optionally with text. Call discord_list_expressions first to find available sticker ids.',
  input_schema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string' },
      sticker_ids: { type: 'array', items: { type: 'string' }, description: 'One to three sticker ids.' },
      content: { type: 'string' },
    },
    required: ['channel_id', 'sticker_ids'],
  },
};

export async function execute(ctx, { channel_id, sticker_ids, content }) {
  const scopeError = channelScopeError(ctx, channel_id);
  if (scopeError) return JSON.stringify({ ok: false, error: scopeError });
  return finishSend(ctx.runtime, ctx.client.sendMessage(channel_id, content ?? '', { sticker_ids }));
}
