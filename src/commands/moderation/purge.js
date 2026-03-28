const twoWeeksMs = 14 * 24 * 60 * 60 * 1000;

const execute = async (client, msg, args) => {
  let count = Number(args[0]) + 1;

  if (msg.message_reference) {
    let messages = [];
    let after = msg.message_reference.message_id;
    args[0] = 0;

    do {
      messages = await client.getMessages(msg.channel_id, { after, limit: 100 });
      after = messages.at(-1)?.id; // Get the ID of the last message
      args[0] += messages.length;
    } while (messages.length === 100);

    await client.deleteMessage(msg.channel_id, msg.message_reference.message_id);

    delete msg.message_reference;
    args[0]--;
    return execute(client, msg, args);
  }

  if (isNaN(count)) return client.deleteMessage(msg.channel_id, msg.id);

  let deleted = 0;
  let remain = count;

  while (remain > 0) {
    const messages = await client.getMessages(msg.channel_id, { limit: Math.min(remain, 100) });
    const twoWeeksAgo = Date.now() - twoWeeksMs;
    let hasTwoWeeksAgo;

    const messagesToDelete = messages.filter(m => {
      const timestamp = new Date(m.timestamp).getTime();
      if (timestamp < twoWeeksAgo) {
        hasTwoWeeksAgo = true;
        return false; // Return false to exclude from messagesToDelete
      }
      return true;
    });

    deleted += messagesToDelete.length;
    remain -= messagesToDelete.length; // Simplify remaining count calculation


    if (messagesToDelete.length > 1) {
      await client.bulkDeleteMessages(msg.channel_id, messagesToDelete.map(o => o.id));
    } else if (messagesToDelete.length === 1) {
      await client.deleteMessage(msg.channel_id, messagesToDelete[0].id);
    }

    if (messages.length < 100 || hasTwoWeeksAgo) break;
  }

  const finalDeleted = deleted;
  
  if (finalDeleted > 0) {
    const reply = await client.sendMessage(msg.channel_id, `🧹 Deleted **${finalDeleted}** messages.`);
    setTimeout(() => {
      client.deleteMessage(msg.channel_id, reply.id).catch(() => {});
    }, 3000);
  }

  return finalDeleted;
};


export default {
  data: {
    name: 'purge',
    aliases: ['rm', 'clean'],
    usage: 'purge [count]',
    permissions: ['MANAGE_MESSAGES']
  },
  execute
};
