const MAX_CHANNELS = 50;

export function createDiscordGetGuildTool({ client }) {
  return {
    name: 'discord_get_guild',
    description:
      'Fetch metadata about a Discord guild (server): name, owner, member count, and a capped list of channels.',
    parallelSafe: true,
    input_schema: {
      type: 'object',
      properties: { guild_id: { type: 'string' } },
      required: ['guild_id'],
    },
    execute: async ({ guild_id }) => {
      try {
        const guild = await client.getGuild(guild_id);
        let channels = [];
        try {
          const list = await client.getChannels(guild_id);
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
        return JSON.stringify({ ok: false, error: String(err?.message ?? err) });
      }
    },
  };
}
