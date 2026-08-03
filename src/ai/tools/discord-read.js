import { sanitizeMessage, processAttachments } from './message-formatter.js';
import { formatToolError } from './error.js';
import { channelScopeError } from './scope.js';

export const definition = {
  name: 'discord_read',
  description:
    'Read the full content of a specific Discord message. Use when you need a referenced message that is not in your buffer.',
  inputSchema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string' },
      message_id: { type: 'string' },
    },
    required: ['channel_id', 'message_id'],
  },
};

export async function execute(ctx, { channel_id, message_id }) {
  const scopeError = channelScopeError(ctx, channel_id);
  if (scopeError) return JSON.stringify({ ok: false, error: scopeError });
  try {
    const msg = await ctx.client.getMessage(channel_id, message_id);
    const sanitized = sanitizeMessage(msg);
    await processAttachments(ctx.runtime, msg, sanitized, channel_id);
    return JSON.stringify({ ok: true, message: sanitized });
  } catch (err) {
    return JSON.stringify({ ok: false, error: formatToolError(err) });
  }
}
