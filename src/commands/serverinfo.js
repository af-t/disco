const execute = async (client, message) => {
  if (!message.guild_id) return client.reply(message, 'This command can only be used in a server.');

  try {
    const guild = await client.getGuild(message.guild_id, { with_counts: true });
    const channels = await client.getChannels(message.guild_id);
    const roles = await client.getRoles(message.guild_id);

    const embed = {
      title: `${guild.name} - Server Information`,
      thumbnail: { url: `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=1024` },
      fields: [
        { name: '🆔 Server ID', value: guild.id, inline: true },
        { name: '👑 Owner ID', value: guild.owner_id, inline: true },
        { name: '📅 Created At', value: `<t:${Math.floor(Number((BigInt(guild.id) >> 22n) + 1420070400000n) / 1000)}:R>`, inline: true },
        { name: '👥 Members', value: `${guild.approximate_member_count || 'N/A'} total`, inline: true },
        { name: '📁 Channels', value: `${channels.length} total`, inline: true },
        { name: '🛡️ Roles', value: `${roles.length} total`, inline: true },
        { name: '✨ Boosts', value: `Level ${guild.premium_tier} (${guild.premium_subscription_count || 0} boosts)`, inline: true }
      ],
      color: 0x5865F2
    };

    if (guild.banner) embed.image = { url: `https://cdn.discordapp.com/banners/${guild.id}/${guild.banner}.png?size=1024` };

    await client.reply(message, null, false, { embeds: [embed] });
  } catch (error) {
    console.error(error);
    await client.reply(message, 'Failed to fetch server information.');
  }
};

export default {
  execute,
  data: {
    name: 'serverinfo',
    description: 'Show information about the server.',
    aliases: ['si', 'server'],
    usage: 'serverinfo'
  }
};