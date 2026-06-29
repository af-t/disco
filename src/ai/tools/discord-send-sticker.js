import { finishSend } from './send-helper.js';
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

export async function execute({ client, runtime }, { channel_id, sticker_ids, content }) {
  return finishSend(runtime, client.sendMessage(channel_id, content ?? '', { sticker_ids }));
}
