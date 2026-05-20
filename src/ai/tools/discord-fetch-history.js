const DEFAULT_LIMIT = 20;

function sanitize(msg) {
  return {
    id: msg.id,
    author_id: msg.author?.id,
    author_name: msg.author?.global_name || msg.author?.username,
    content: msg.content ?? '',
    timestamp: msg.timestamp,
    reply_to: msg.message_reference?.message_id ?? null,
    attachments: (msg.attachments ?? []).map((a) => ({ filename: a.filename, content_type: a.content_type })),
  };
}

export function createDiscordFetchHistoryTool({ client, runtime }) {
  const hardMax = runtime?.config?.fetchHistoryMax ?? 50;
  return {
    name: 'discord_fetch_history',
    description:
      'Fetch recent messages from a Discord channel (older than your rolling buffer). Use sparingly — only when needed for context.',
    parallelSafe: true,
    input_schema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string' },
        before_message_id: { type: 'string', description: 'Optional. Fetch messages older than this ID.' },
        limit: { type: 'number', description: `Default ${DEFAULT_LIMIT}, max ${hardMax}.` },
      },
      required: ['channel_id'],
    },
    execute: async ({ channel_id, before_message_id, limit }) => {
      try {
        const n = Math.min(Math.max(1, limit ?? DEFAULT_LIMIT), hardMax);
        const qs = new URLSearchParams({ limit: String(n) });
        if (before_message_id) qs.set('before', before_message_id);
        const msgs = await client.makeRequest('GET', `/channels/${channel_id}/messages?${qs.toString()}`);
        return JSON.stringify({ ok: true, messages: msgs.map(sanitize) });
      } catch (err) {
        return JSON.stringify({ ok: false, error: String(err?.message ?? err) });
      }
    },
  };
}
