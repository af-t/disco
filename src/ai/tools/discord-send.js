import { finishSend } from './send-helper.js';
export const definition = {
  name: 'discord_send',
  description:
    'Send a new message to a Discord channel you have access to. Use for fresh statements not tied to a specific reply target.',
  input_schema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'Target channel ID.' },
      content: { type: 'string', description: 'Message text (max 2000 chars).' },
    },
    required: ['channel_id', 'content'],
  },
};

export async function execute({ client, runtime }, { channel_id, content }) {
  return finishSend(runtime, client.sendMessage(channel_id, content));
}
