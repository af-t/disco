import { formatToolError } from './error.js';
export const definition = {
  name: 'discord_send_media',
  description:
    'Send a GIF, image, or file to a channel by direct media URL or local path (uploaded as an attachment). Optionally include text. For a Tenor/Giphy share link that should unfurl, use discord_send with the link in the content instead.',
  input_schema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string' },
      url: { type: 'string', description: 'Direct media URL or local file path to upload.' },
      content: { type: 'string' },
    },
    required: ['channel_id', 'url'],
  },
};

export async function execute({ client, runtime }, { channel_id, url, content }) {
  try {
    const sent = await client.sendMessage(channel_id, content ?? '', { files: [url] });
    runtime.onBotMessage(sent);
    return JSON.stringify({ ok: true, message_id: sent.id });
  } catch (err) {
    return JSON.stringify({ ok: false, error: formatToolError(err) });
  }
}
