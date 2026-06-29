import { finishSend } from './send-helper.js';
export const definition = {
  name: 'discord_reply',
  description:
    'Reply to a specific message in a Discord channel. Preferred in busy channels so the recipient is unambiguous.',
  input_schema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'Channel containing the message to reply to.' },
      message_id: { type: 'string', description: 'Message ID to reply to.' },
      content: { type: 'string', description: 'Reply text (max 2000 chars).' },
    },
    required: ['channel_id', 'message_id', 'content'],
  },
};

export async function execute({ client, runtime }, { channel_id, message_id, content }) {
  return finishSend(runtime, client.reply({ channel_id, id: message_id }, content));
}
