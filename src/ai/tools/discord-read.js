import { sanitizeMessage, processAttachments } from './message-formatter.js';
import { formatToolError } from './error.js';

export const definition = {
  name: 'discord_read',
  description:
    'Read the full content of a specific Discord message. Use when you need a referenced message that is not in your buffer.',
  input_schema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string' },
      message_id: { type: 'string' },
    },
    required: ['channel_id', 'message_id'],
  },
};

export async function execute({ client, runtime }, { channel_id, message_id }) {
  try {
    const msg = await client.getMessage(channel_id, message_id);
    const sanitized = sanitizeMessage(msg);
    await processAttachments(runtime, msg, sanitized, channel_id);
    return JSON.stringify({ ok: true, message: sanitized });
  } catch (err) {
    return JSON.stringify({ ok: false, error: formatToolError(err) });
  }
}
