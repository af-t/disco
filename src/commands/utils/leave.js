const execute = async (client, message) => {
  try {
    await client.leaveVoice(message.guild_id);
    await client.reply(message, '👋 Left voice channel.');
  } catch (err) {
    client.reply(message, `❌ Error: ${err.message}`);
  }
};

export default {
  execute,
  data: {
    name: 'leave',
    description: 'Leave voice channel',
    usage: 'leave',
    permissions: ['CONNECT']
  }
};
