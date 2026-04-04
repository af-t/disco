const twoWeeksMs = 14 * 24 * 60 * 60 * 1000;

const execute = async(client, msg, args) => {
  const messagesToDelete = [];
  let deleted = 0;

  if (msg.message_reference) {
    let messages = [];
    let after = msg.message_reference.message_id;

    do {
      messages = await client.getMessages(msg.channel_id, { after, limit: 100 });
      messagesToDelete.push(...filter(messages));
      after = messages.at(-1)?.id;
    } while (messages.length === 100 && after);

    messagesToDelete.push({ id: msg.message_reference.message_id });

  } else {
    const count = Number(args[0]);
    if (isNaN(count) || count < 1) return client.deleteMessage(msg.channel_id, msg.id);

    let remain = count;
    let before = msg.id;
    while (remain > 0) {
      const messages = await client.getMessages(msg.channel_id, { before, limit: Math.min(remain, 100) });
      const filteredMsgs = filter(messages);

      remain -= filteredMsgs.length;
      messagesToDelete.push(...filteredMsgs);

      before = messages.at(-1)?.id;

      if (messages.length !== filteredMsgs.length || !before) break;
    }

    messagesToDelete.push(msg);
  }

  for (let i = 0; i < messagesToDelete.length; i += 100) {
    const chunk = messagesToDelete.slice(i, i + 100);
    if (chunk.length > 1) {
      await client.bulkDeleteMessages(msg.channel_id, chunk.map(x => x.id));
    } else {
      await client.deleteMessage(msg.channel_id, chunk[0].id);
    }

    deleted += chunk.length;
  }

  if (deleted > 0) {
    const reply = await client.reply(msg, `🧹 Deleted **${deleted - 1}** messages.`);
    if (reply?.channel_id && reply?.id) setTimeout(() => client.deleteMessage(msg.channel_id, reply.id).catch(_ => _), 3_500);
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
