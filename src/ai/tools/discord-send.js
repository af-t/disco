import { finishSend } from './send-helper.js';
import { channelScopeError } from './scope.js';
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

export async function execute(ctx, { channel_id, content }) {
  const scopeError = channelScopeError(ctx, channel_id);
  if (scopeError) return JSON.stringify({ ok: false, error: scopeError });
  return finishSend(ctx.runtime, ctx.client.sendMessage(channel_id, content));
}
