const execute = async(client, message, args) => {
  let response;
  const uids = new Set();
  const reason = [];

  if (message.message_reference) try {// Ban referenced user
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
    response = 'Please specify at least one user to kick';
  } else {
    let count = 0;
    for (const uid of uids) try {
      await client.kickMember(message.guild_id, uid, reason.join(' '));
      count++;
    } catch (error) {
      client.logger.warn(error);
    }
    response = `Kicked **${count}** user${count > 1 ? 's' : ''}`;
  }

  // Feedback
  client.reply(message, response).catch(client.logger.warn);
};

export default {
  execute,
  data: {
    name: 'kick',
    description: 'Kick a user from the server.',
    slash: true,
    usage: 'kick {user} [reason]',
    permissions: ['KICK_MEMBERS'],
    options: [
      {
        name: 'user',
        description: 'The user to kick',
        type: 6, // USER type
        required: true
      },
      {
        name: 'reason',
        description: 'The reason for the kick',
        type: 3, // STRING type
        required: false
      }
    ]
  }
};
