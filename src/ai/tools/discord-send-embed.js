import { finishSend } from './send-helper.js';
import { channelScopeError } from './scope.js';
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

export async function execute(ctx, { channel_id, content, embed }) {
  const scopeError = channelScopeError(ctx, channel_id);
  if (scopeError) return JSON.stringify({ ok: false, error: scopeError });
  const built = { ...embed };
  if (embed?.image_url) built.image = { url: embed.image_url };
  if (embed?.thumbnail_url) built.thumbnail = { url: embed.thumbnail_url };
  if (embed?.footer_text) built.footer = { text: embed.footer_text };
  return finishSend(ctx.runtime, ctx.client.sendMessage(channel_id, content ?? '', { embeds: [built] }));
}
