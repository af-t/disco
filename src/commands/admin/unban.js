const execute = async(client, message, args) => {
  let response;
  const uids = new Set();
  const reason = [];

  if (message.message_reference) try {// Unban referenced user
    const m = await client.getMessage(message.channel_id, message.message_reference.message_id);
    uids.add(m.author.id);
    reason.push(...args);
  } catch (error) {
    client.logger.warn(error);
  }

  if (uids.size < 1) for (const i of args) {// Gets user ids from args
    let id = i.match(/<@!?(\d+)>/)?.[1];
    if (!id && !isNaN(Number(i))) id = i;
    if (id?.length > 15) uids.add(id);
    else reason.push(i);
  }

  if (uids.size < 1) {
    response = 'Please specify at least one user to unban';
  } else {
    let count = 0;
    const unbanReason = reason.join(' ');
    for (const uid of uids) try {
      await client.unbanMember(message.guild_id, uid, unbanReason);
      count++;
    } catch (error) {
      client.logger.warn(error);
    }
    response = `Removed ban for **${count}** user${count > 1 ? 's' : ''}`;
  }

  // Feedback
  client.reply(message, response).catch(client.logger.warn);
};

export default {
  execute,
  data: {
    name: 'unban',
    description: 'Unban a user from the server.',
    slash: true,
    usage: 'unban {user}',
    permissions: ['BAN_MEMBERS'],
    options: [
      {
        name: 'user',
        description: 'The user ID to unban',
        type: 3, // STRING type (since they are not in the guild, USER type might not work as easily with autocomplete if not cached)
        required: true
      }
    ]
  }
};
