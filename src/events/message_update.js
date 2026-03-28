export default async (client, m) => {
  if (!m.guild_id || m.author?.bot) return;

  // Cari channel log
  const channels = await client.getChannels(m.guild_id);
  const logChannel = channels.find(c => c.name === 'logs' || c.name === 'audit-log');
  if (!logChannel) return;

  // Ambil data lama dari cache
  const oldMsg = await client._store?.get(`${m.channel_id}:${m.id}:old`);
  if (oldMsg?.content === m.content) return; // Jika tidak ada perubahan isi

  const embed = {
    title: '📝 Message Updated',
    description: `A message by <@${m.author.id}> was edited in <#${m.channel_id}>`,
    fields: [
      { name: 'Original Content', value: oldMsg?.content || '*Original not in cache*' },
      { name: 'New Content', value: m.content || '*No content*' }
    ],
    timestamp: new Date().toISOString(),
    color: 0xffcc33,
    footer: { text: `User ID: ${m.author.id}` }
  };

  await client.sendMessage(logChannel.id, null, { embeds: [embed] });
};