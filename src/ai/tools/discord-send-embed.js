import { formatToolError } from './error.js';
export const definition = {
  name: 'discord_send_embed',
  description:
    'Send a rich embed (title, description, fields, color, image, thumbnail, footer) to a channel, optionally with leading text. Use for structured or visually distinct messages.',
  input_schema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string' },
      content: { type: 'string', description: 'Optional text shown above the embed.' },
      embed: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          url: { type: 'string' },
          color: { type: 'integer', description: 'Decimal color, e.g. 3447003 for blue.' },
          fields: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, value: { type: 'string' }, inline: { type: 'boolean' } },
              required: ['name', 'value'],
            },
          },
          image_url: { type: 'string' },
          thumbnail_url: { type: 'string' },
          footer_text: { type: 'string' },
        },
      },
    },
    required: ['channel_id', 'embed'],
  },
};

export async function execute({ client, runtime }, { channel_id, content, embed }) {
  try {
    const built = {
      title: embed.title,
      description: embed.description,
      url: embed.url,
      color: embed.color,
      fields: embed.fields,
      image: embed.image_url ? { url: embed.image_url } : undefined,
      thumbnail: embed.thumbnail_url ? { url: embed.thumbnail_url } : undefined,
      footer: embed.footer_text ? { text: embed.footer_text } : undefined,
    };
    const sent = await client.sendMessage(channel_id, content ?? '', { embeds: [built] });
    runtime.onBotMessage(sent);
    return JSON.stringify({ ok: true, message_id: sent.id });
  } catch (err) {
    return JSON.stringify({ ok: false, error: formatToolError(err) });
  }
}
