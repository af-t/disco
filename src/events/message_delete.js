export default async (client, m) => {
  if (!m.guild_id) return;

  const cached = await client._store.get(`${m.channel_id}:${m.id}`);
  if (cached && !cached.author.bot) {
    const channels = await client.getChannels(m.guild_id);
    const logChannel = channels.find(x => x.name === 'logs' || x.name === 'audit-log');
    if (!logChannel) return;

    const embed = {
      title: '🗑️ Message Deleted',
      description: `A message by <@${cached.author?.id}> was deleted in <#${m.channel_id}>`,
      fields: [
        { name: 'Content', value: cached.content }
      ],
      timestamp: new Date().toISOString(),
      color: 0xff4b2b,
      footer: { text: `User ID: ${cached.author?.id}` }
    };
    await client.sendMessage(logChannel.id, null, { embeds: [embed] });
  }
};
