const execute = async (client, message, args) => {
  const channelId = args[0];
  if (!channelId) return client.reply(message, 'Provide voice channel ID: `.join <id>`');

  try {
    await client.reply(message, `⏳ Joining <#${channelId}>...`);
    await client.joinVoice(channelId, message.guild_id);
    await client.reply(message, `✅ Connected to voice channel!`);
  } catch (err) {
    client.logger.error('Voice join failed:', err);
    await client.reply(message, `❌ Failed to join: ${err.message}`);
  }
};

export default {
  execute,
  data: {
    name: 'join',
    description: 'Join a voice channel',
    usage: 'join <channel_id>',
    permissions: ['CONNECT', 'SPEAK']
  }
};
