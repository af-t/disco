import { executeGuildScoped, guildIdOnlyInputSchema } from './scope.js';
const MAX_CHANNELS = 50;

export const definition = {
  name: 'discord_get_guild',
  description:
    'Fetch metadata about a Discord guild (server): name, owner, member count, and a capped list of channels.',
  input_schema: guildIdOnlyInputSchema,
};

export async function execute(ctx, { guild_id }) {
  return executeGuildScoped(ctx, guild_id, async () => {
    const guild = await ctx.client.getGuild(guild_id);
    let channels = [];
    try {
      const list = await ctx.client.getChannels(guild_id);
      channels = list.slice(0, MAX_CHANNELS).map((c) => ({ id: c.id, name: c.name, type: c.type }));
    } catch {
      // ignore missing access to channel list
    }
    return JSON.stringify({
      ok: true,
      guild: {
        id: guild.id,
        name: guild.name,
        owner_id: guild.owner_id,
        member_count: guild.approximate_member_count ?? guild.member_count ?? null,
        channels,
      },
    });
  });
}
