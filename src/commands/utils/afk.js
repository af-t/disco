const execute = async (client, message, args) => {
  const guildId = message.guild_id || 'dm';
  const messageText = args.join(' ').trim() || 'AFK';

  await client.store.set(
    `afk:${guildId}:${message.author.id}`,
    {
      message: messageText,
      since: Date.now(),
    },
    { ttl: 604_800_000 },
  ); // 7 days

  await client.reply(
    message,
    `👋 **${message.author.global_name || message.author.username}** is now AFK: _${messageText}_`,
  );
};

export default {
  execute,
  data: {
    name: 'afk',
    description: 'Set your AFK status. Clears when you send a message.',
    slash: true,
    aliases: ['away'],
    usage: 'afk [message]',
    options: [
      {
        name: 'message',
        description: 'Your AFK message',
        type: 3,
        required: false,
      },
    ],
  },
};
