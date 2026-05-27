const DEFAULT_LIMIT = 20;

function sanitize(msg) {
  return {
    id: msg.id,
    author_id: msg.author?.id,
    author_name: msg.author?.global_name || msg.author?.username,
    content: msg.content ?? '',
    timestamp: msg.timestamp,
    reply_to: msg.message_reference?.message_id ?? null,
    attachments: (msg.attachments ?? []).map((a) => ({
      id: a.id,
      filename: a.filename,
      content_type: a.content_type,
      size: a.size,
      url: a.url,
    })),
  };
}

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

export async function execute({ client, runtime }, { channel_id, before_message_id, limit }) {
  try {
    const hardMax = runtime?.config?.fetchHistoryMax ?? 50;
    const n = Math.min(Math.max(1, limit ?? DEFAULT_LIMIT), hardMax);
    const qs = new URLSearchParams({ limit: String(n) });
    if (before_message_id) qs.set('before', before_message_id);
    const msgs = await client.makeRequest('GET', `/channels/${channel_id}/messages?${qs.toString()}`);
    const sanitizedMsgs = msgs.map(sanitize);

    if (runtime) {
      await Promise.all(
        msgs.map(async (raw, i) => {
          const sanitized = sanitizedMsgs[i];
          if (Array.isArray(raw.attachments) && raw.attachments.length > 0) {
            const saved = await runtime.saveAllAttachments(raw.attachments, raw.id, channel_id);
            for (const entry of saved) {
              const att = sanitized.attachments.find((a) =>
                entry.id ? a.id === entry.id : a.filename === entry.original,
              );
              if (att) att.saved_path = entry.saved_path;
            }
          }
        }),
      );
    }

    return JSON.stringify({ ok: true, messages: sanitizedMsgs });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String(err?.message ?? err) });
  }
}
