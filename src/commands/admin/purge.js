const twoWeeksMs = 14 * 24 * 60 * 60 * 1000;

const execute = async(client, message, args) => {
  const messagesToDelete = [];
  let deleted = 0;

  if (message.message_reference) {
    let messages = [];
    let after = message.message_reference.message_id;

    do {
      messages = await client.getMessages(message.channel_id, { after, limit: 100 });
      messagesToDelete.push(...filter(messages));
      after = messages.at(-1)?.id;
    } while (messages.length === 100 && after);

    messagesToDelete.push({ id: message.message_reference.message_id });

  } else {
    const count = Number(args[0]);
    if (isNaN(count) || count < 1) return client.deleteMessage(message.channel_id, message.id);

    let remain = count;
    let before = message.id;
    while (remain > 0) {
      const messages = await client.getMessages(message.channel_id, { before, limit: Math.min(remain, 100) });
      const filteredMsgs = filter(messages);

      remain -= filteredMsgs.length;
      messagesToDelete.push(...filteredMsgs);

      before = messages.at(-1)?.id;

      if (messages.length !== filteredMsgs.length || !before) break;
    }

    messagesToDelete.push(message);
  }

  for (let i = 0; i < messagesToDelete.length; i += 100) {
    const chunk = messagesToDelete.slice(i, i + 100);
    if (chunk.length > 1) {
      await client.bulkDeleteMessages(message.channel_id, chunk.map(x => x.id));
    } else {
      await client.deleteMessage(message.channel_id, chunk[0].id);
    }

    deleted += chunk.length;
  }

  if (deleted > 0) {
    const content = `🧹 Deleted **${deleted - 1}** messages.`;
    const reply = message.isInteraction ? await client.reply(msg, content) : await client.sendMessage(message.channel_id, content);
    if (reply?.channel_id && reply?.id) setTimeout(() => client.deleteMessage(message.channel_id, reply.id).catch(_ => _), 3_500);
  }
};

const filter = (messages) => {
  const twoWeeksAgo = Date.now() - twoWeeksMs;
  return messages.filter((m) => {
    const timestamp   = new Date(m.timestamp).getTime();
    return timestamp >= twoWeeksAgo;
  });
};

export default {
  data: {
    name: 'purge',
    description: 'Delete a specified number of messages from the channel.',
    slash: true,
    aliases: ['rm', 'clean'],
    usage: 'purge [count]',
    permissions: ['MANAGE_MESSAGES'],
    options: [
      {
        name: 'count',
        description: 'Number of messages to delete',
        type: 4, // INTEGER type
        required: false
      }
    ]
  },
  execute
};
