export default async (client, m) => {
  if (!m.guild_id) return;

  const channels = await client.getChannels(m.guild_id);
  const logChannel = channels.find(c => c.name === 'logs' || c.name === 'audit-log');
  if (!logChannel) return;

  const cachedMsg = await client._store?.get(`${m.channel_id}:${m.id}`);

  if (cachedMsg && !cachedMsg.author.bot) {
    const embed = {
      title: '🗑️ Message Deleted',
      description: `A message by <@${cachedMsg.author.id}> was deleted in <#${m.channel_id}>`,
      fields: [
        { name: 'Content', value: cachedMsg.content }
      ],
      timestamp: new Date().toISOString(),
      color: 0xff4b2b,
      footer: { text: `User ID: ${cachedMsg.author.id}` }
    };
    await client.sendMessage(logChannel.id, null, { embeds: [embed] });
  }
};
