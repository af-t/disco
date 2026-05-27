const FLAG_LABEL = { new: 'NEW', observed: 'OBSERVED', bot: 'BOT' };

export function snapshotFromMessage(msg, { flag = 'observed' } = {}) {
  return {
    id: msg.id,
    author_id: msg.author?.id ?? 'unknown',
    author_name: msg.author?.global_name || msg.author?.username || 'unknown',
    content: msg.content ?? '',
    reply_to: msg.message_reference?.message_id ?? null,
    attachments_meta: (msg.attachments ?? []).map((a) => ({
      id: a.id,
      filename: a.filename,
      content_type: a.content_type ?? 'application/octet-stream',
      url: a.url,
      size: a.size,
    })),
    timestamp: typeof msg.timestamp === 'string' ? Date.parse(msg.timestamp) : (msg.timestamp ?? Date.now()),
    flag,
  };
}

function shortType(ct) {
  if (!ct) return 'file';
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('audio/')) return 'audio';
  if (ct.startsWith('video/')) return 'video';
  if (ct.includes('pdf')) return 'pdf';
  if (ct.startsWith('text/')) return 'text';
  return 'file';
}

function escapeAttr(v) {
  return String(v).replaceAll('"', '&quot;').replaceAll('\n', ' ');
}

export function renderEventBlock(snap, { channel_name = 'unknown', channel_id = 'unknown' } = {}) {
  const ts = new Date(snap.timestamp).toISOString();
  const att = snap.attachments_meta.length
    ? snap.attachments_meta
        .map((a) => {
          const tag = `${shortType(a.content_type)}:${a.filename}`;
          return a.saved_path ? `${tag}->${a.saved_path}` : tag;
        })
        .join('; ')
    : '';
  const attrs = [
    `id="${snap.id ?? 'unknown'}"`,
    `author="${escapeAttr(`${snap.author_name} (${snap.author_id})`)}"`,
    `channel="${escapeAttr(`${channel_name} (${channel_id})`)}"`,
    `timestamp="${ts}"`,
    `reply_to="${snap.reply_to ?? 'null'}"`,
    att ? `attachments="${escapeAttr(att)}"` : null,
    `flag="${FLAG_LABEL[snap.flag] ?? 'OBSERVED'}"`,
  ]
    .filter(Boolean)
    .join(' ');
  return `<discord-event ${attrs}>\n<content>\n${snap.content}\n</content>\n</discord-event>`;
}
