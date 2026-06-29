export function sanitizeMessage(msg) {
  if (!msg) return null;
  return {
    id: msg.id,
    channel_id: msg.channel_id,
    author: msg.author
      ? { id: msg.author.id, username: msg.author.username, global_name: msg.author.global_name, bot: !!msg.author.bot }
      : null,
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

export async function processAttachments(runtime, msg, sanitized, channel_id) {
  if (runtime && sanitized && Array.isArray(msg.attachments) && msg.attachments.length > 0) {
    const saved = await runtime.saveAllAttachments(msg.attachments, msg.id, channel_id);
    for (const entry of saved) {
      const att = sanitized.attachments.find((a) => (entry.id ? a.id === entry.id : a.filename === entry.original));
      if (att) att.saved_path = entry.saved_path;
    }
  }
}
