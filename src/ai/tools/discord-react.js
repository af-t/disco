export const definition = {
  name: 'discord_react',
  description:
    'Add a single emoji reaction to a Discord message. Use for lightweight acknowledgement when text would be overkill.',
  input_schema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string' },
      message_id: { type: 'string' },
      emoji: { type: 'string', description: 'Unicode emoji (e.g. 👍) or custom emoji in name:id form.' },
    },
    required: ['channel_id', 'message_id', 'emoji'],
  },
};

export async function execute({ client }, { channel_id, message_id, emoji }) {
  try {
    const encoded = encodeURIComponent(emoji);
    await client.makeRequest('PUT', `/channels/${channel_id}/messages/${message_id}/reactions/${encoded}/@me`);
    return JSON.stringify({ ok: true });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String(err?.message ?? err) });
  }
}
