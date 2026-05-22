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
      filename: a.filename,
      content_type: a.content_type,
      size: a.size,
    })),
  };
}

export const definition = {
  name: 'discord_read',
  description:
    'Read the full content of a specific Discord message. Use when you need a referenced message that is not in your buffer.',
  parallelSafe: true,
  input_schema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string' },
      message_id: { type: 'string' },
    },
    required: ['channel_id', 'message_id'],
  },
};

export async function execute({ client }, { channel_id, message_id }) {
  try {
    const msg = await client.getMessage(channel_id, message_id);
    return JSON.stringify({ ok: true, message: sanitize(msg) });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String(err?.message ?? err) });
  }
}
