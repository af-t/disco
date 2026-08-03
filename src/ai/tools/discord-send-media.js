import { finishSend } from './send-helper.js';
import { channelScopeError, scopedMediaPath } from './scope.js';
export const definition = {
  name: 'discord_send_media',
  description:
    'Send a GIF, image, or file to a channel by direct media URL or local path (uploaded as an attachment). Optionally include text. For a Tenor/Giphy share link that should unfurl, use discord_send with the link in the content instead.',
  inputSchema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string' },
      url: { type: 'string', description: 'Direct media URL or local file path to upload.' },
      content: { type: 'string' },
    },
    required: ['channel_id', 'url'],
  },
};

export async function execute(ctx, { channel_id, url, content }) {
  const scopeError = channelScopeError(ctx, channel_id);
  if (scopeError) return JSON.stringify({ ok: false, error: scopeError });
  const scoped = await scopedMediaPath(ctx, url);
  if (!scoped.ok) return JSON.stringify(scoped);
  return finishSend(ctx.runtime, ctx.client.sendMessage(channel_id, content ?? '', { files: [scoped.url] }));
}
