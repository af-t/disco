import { executeGuildScoped, guildIdOnlyInputSchema } from './scope.js';
const MAX = 100;

export const definition = {
  name: 'discord_list_expressions',
  description:
    'List the custom emojis and stickers available in a guild, with their ids. Use before discord_send_sticker, or to use a custom emoji in text (format <:name:id> or <a:name:id> for animated).',
  inputSchema: guildIdOnlyInputSchema,
};

export async function execute(ctx, { guild_id }) {
  return executeGuildScoped(ctx, guild_id, async () => {
    const [emojis, stickers] = await Promise.all([
      ctx.client.makeRequest('GET', `/guilds/${guild_id}/emojis`).catch(() => []),
      ctx.client.makeRequest('GET', `/guilds/${guild_id}/stickers`).catch(() => []),
    ]);
    return JSON.stringify({
      ok: true,
      emojis: (emojis ?? []).slice(0, MAX).map((e) => ({ id: e.id, name: e.name, animated: !!e.animated })),
      stickers: (stickers ?? []).slice(0, MAX).map((s) => ({ id: s.id, name: s.name })),
    });
  });
}
