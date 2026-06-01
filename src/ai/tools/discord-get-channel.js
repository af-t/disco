import { formatToolError } from './error.js';
function sanitize(ch) {
  if (!ch) return null;
  return {
    id: ch.id,
    name: ch.name,
    type: ch.type,
    topic: ch.topic ?? null,
    nsfw: !!ch.nsfw,
    parent_id: ch.parent_id ?? null,
    guild_id: ch.guild_id ?? null,
    position: ch.position ?? null,
  };
}

export const definition = {
  name: 'discord_get_channel',
  description: 'Fetch metadata about a Discord channel: name, topic, type, parent category, nsfw flag.',
  input_schema: {
    type: 'object',
    properties: { channel_id: { type: 'string' } },
    required: ['channel_id'],
  },
};

export async function execute({ client }, { channel_id }) {
  try {
    const ch = await client.getChannel(channel_id);
    return JSON.stringify({ ok: true, channel: sanitize(ch) });
  } catch (err) {
    return JSON.stringify({ ok: false, error: formatToolError(err) });
  }
}
