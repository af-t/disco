const execute = async (client, message, args) => {
  if (!message.guild_id) return client.reply(message, 'This command can only be used in a server.');

  const type = args[0]?.toLowerCase();
  const channelMention = args[1];

  if (!['welcome', 'leave'].includes(type)) {
    return client.reply(message, 'Please specify a type: `welcome` or `leave`.');
  }

  let channelId = channelMention?.match(/<#(\d+)>/)?.[1];
  if (!channelId && !isNaN(Number(channelMention))) channelId = channelMention;

  if (!channelId) {
    return client.reply(message, `Usage: \`.setchannel ${type} #channel\``);
  }

  try {
    // Verify channel exists and is in this guild
    const channels = await client.getChannels(message.guild_id);
    const targetChannel = channels.find(c => c.id === channelId);

    if (!targetChannel) {
      return client.reply(message, 'Invalid channel or channel not in this server.');
    }

    await client.store.set(`config:${message.guild_id}:${type}_channel`, channelId);
    await client.reply(message, `✅ Successfully set the **${type}** channel to <#${channelId}>.`);
  } catch (error) {
    client.logger.error('Error in setchannel command:', error);
    await client.reply(message, 'An error occurred while setting the channel.');
  }
};

export default {
  execute,
  data: {
    name: 'setchannel',
    //description: 'Configure channels for welcome or leave messages.',
    usage: 'setchannel {welcome|leave} {#channel}',
    permissions: ['MANAGE_GUILD'],
    options: [
      {
        name: 'type',
        description: 'Type of channel to set',
        type: 3, // STRING
        required: true,
        choices: [
          { name: 'Welcome', value: 'welcome' },
          { name: 'Leave', value: 'leave' }
        ]
      },
      {
        name: 'channel',
        description: 'The channel to use',
        type: 7, // CHANNEL
        required: true
      }
    ]
  }
};
