import { formatToolError } from './error.js';
import { guildScopeError } from './scope.js';
const MAX_CHANNELS = 50;

export const definition = {
  name: 'discord_get_guild',
  description:
    'Fetch metadata about a Discord guild (server): name, owner, member count, and a capped list of channels.',
  input_schema: {
    type: 'object',
    properties: { guild_id: { type: 'string' } },
    required: ['guild_id'],
  },
};

export async function execute(ctx, { guild_id }) {
  const scopeError = guildScopeError(ctx, guild_id);
  if (scopeError) return JSON.stringify({ ok: false, error: scopeError });
  try {
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
  } catch (err) {
    return JSON.stringify({ ok: false, error: formatToolError(err) });
  }
}
