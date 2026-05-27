function sanitize(msg) {
  if (!msg) return null;
  return {
    id: msg.id,
    channel_id: msg.channel_id,
    author: msg.author
      ? { id: msg.author.id, username: msg.author.username, global_name: msg.author.global_name, bot: !!msg.author.bot }
      : null,
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
    const sanitized = sanitize(msg);
    if (runtime && sanitized && Array.isArray(msg.attachments) && msg.attachments.length > 0) {
      const saved = await runtime.saveAllAttachments(msg.attachments, msg.id, channel_id);
      for (const entry of saved) {
        const att = sanitized.attachments.find((a) => (entry.id ? a.id === entry.id : a.filename === entry.original));
        if (att) att.saved_path = entry.saved_path;
      }
    }
    return JSON.stringify({ ok: true, message: sanitized });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String(err?.message ?? err) });
  }
}
