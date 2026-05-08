export default async (client, member) => {
  const guildId = member.guild_id;
  const channelId = await client.store.get(`config:${guildId}:leave_channel`);

  if (!channelId) return;

  const user = member.user;
  const embed = {
    title: `Goodbye!`,
    description: `**${user.username}#${user.discriminator || '0'}** has left the server. We'll miss you!`,
    thumbnail: {
      url: user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=1024`
        : `https://cdn.discordapp.com/embed/avatars/${Number(user.discriminator) % 5}.png`,
    },
    color: 0xff0000,
    timestamp: new Date().toISOString(),
    footer: { text: `User ID: ${user.id}` },
  };

  try {
    await client.sendMessage(channelId, '', { embeds: [embed] });
  } catch (error) {
    client.logger.error(`Failed to send leave message in ${channelId}:`, error);
  }
};
