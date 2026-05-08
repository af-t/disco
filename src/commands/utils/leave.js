const execute = async (client, message) => {
  // Check if bot is in a voice channel in this guild
  const currentConnection = client.getVoiceConnection(message.guild_id);
  if (!currentConnection) {
    return client.reply(message, '❌ I am not currently in a voice channel in this server.');
  }

  try {
    await client.leaveVoice(message.guild_id);
    await client.reply(message, '👋 Left voice channel.');
  } catch (err) {
    client.logger.error('Voice leave failed:', err);
    client.reply(message, '❌ Failed to leave the voice channel. Please try again.');
  }
};

export default {
  execute,
  data: {
    name: 'leave',
    description: 'Leave voice channel',
    slash: true,
    usage: 'leave',
    permissions: ['CONNECT'],
  },
};
