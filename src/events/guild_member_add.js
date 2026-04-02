export default async (client, member) => {
  const guild_id = member.guild_id;
  const user = member.user;
  
  let channel_id = await client._store.get('config:welcome_channel_id');
  if (!channel_id) {
    const channels = await client.getChannels(guild_id);
    const welcomeChannel = channels.find(c => c.name === 'welcome');
    if (welcomeChannel) channel_id = welcomeChannel.id;
  }
  
  if (!channel_id) return;

  const rules_channel_id = await client._store.get('config:rules_channel_id') || '0';
  
  const avatarUrl = user.avatar 
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
    : `https://cdn.discordapp.com/embed/avatars/${(BigInt(user.id) >> 22n) % 6n}.png`;

  const embed = {
    title: `Welcome to the server!`,
    description: `Hey <@${user.id}>, welcome! Make sure to read the <#${rules_channel_id}>.`,
    thumbnail: { url: avatarUrl },
    color: 0x2ecc71,
    timestamp: new Date().toISOString()
  };

  await client.sendMessage(channel_id, '', { embeds: [embed] });
};
