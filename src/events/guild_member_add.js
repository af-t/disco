export default async (client, member) => {
  const guildId = member.guild_id;
  const channelId = await client.store.get(`config:${guildId}:welcome_channel`);

  if (!channelId) return;

  const user = member.user;
  const embed = {
    title: `Welcome to the server!`,
    description: `Hello <@${user.id}>, welcome to **${(await client.getGuild(guildId)).name}**! We're glad to have you here.`,
    thumbnail: {
      url: user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=1024`
        : `https://cdn.discordapp.com/embed/avatars/${Number(user.discriminator) % 5}.png`,
    },
    color: 0x00ff00,
    timestamp: new Date().toISOString(),
    footer: { text: `User ID: ${user.id}` },
  };

  try {
    await client.sendMessage(channelId, '', { embeds: [embed] });
  } catch (error) {
    client.logger.error(`Failed to send welcome message in ${channelId}:`, error);
  }
};
