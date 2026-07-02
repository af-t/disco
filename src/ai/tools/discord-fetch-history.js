import { sanitizeMessage, processAttachments } from './message-formatter.js';
import { formatToolError } from './error.js';
import { channelScopeError } from './scope.js';
const DEFAULT_LIMIT = 20;

export const definition = {
  name: 'discord_fetch_history',
  description:
    'Fetch recent messages from a Discord channel (older than your rolling buffer). Use sparingly — only when needed for context.',
  input_schema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string' },
      before_message_id: { type: 'string', description: 'Optional. Fetch messages older than this ID.' },
      limit: { type: 'number', description: `Default ${DEFAULT_LIMIT}; the channel runtime caps the maximum.` },
    },
    required: ['channel_id'],
  },
};

export async function execute(ctx, { channel_id, before_message_id, limit }) {
  const scopeError = channelScopeError(ctx, channel_id);
  if (scopeError) return JSON.stringify({ ok: false, error: scopeError });
  try {
    const hardMax = ctx.runtime?.config?.fetchHistoryMax ?? 50;
    const n = Math.min(Math.max(1, limit ?? DEFAULT_LIMIT), hardMax);
    const qs = new URLSearchParams({ limit: String(n) });
    if (before_message_id) qs.set('before', before_message_id);
    const msgs = await ctx.client.makeRequest('GET', `/channels/${channel_id}/messages?${qs.toString()}`);
    const sanitizedMsgs = msgs.map(sanitizeMessage);

    if (ctx.runtime) {
      await Promise.all(
        msgs.map(async (raw, i) => {
          await processAttachments(ctx.runtime, raw, sanitizedMsgs[i], channel_id);
        }),
      );
    }

    return JSON.stringify({ ok: true, messages: sanitizedMsgs });
  } catch (err) {
    return JSON.stringify({ ok: false, error: formatToolError(err) });
  }
}
