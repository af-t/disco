const execute = async(client, message, args) => {
  let response;
  const uids = new Set();

  if (message.message_reference) try {// Unmute referenced user
    const m = await client.getMessage(message.channel_id, message.message_reference.message_id);
    uids.add(m.author.id);
  } catch (error) {
    client.logger.warn(error);
  }

  if (uids.size < 1) for (const i of args) {// Gets user ids from args
    let id = i.match(/<@!?(\d+)>/)?.[1];
    if (!id && !isNaN(Number(i))) id = i;
    if (id?.length > 15) uids.add(id);
  }

  if (uids.size < 1) {
    response = 'Please specify at least one user to unmute';
  } else {
    let count = 0;
    for (const uid of uids) try {
      await client.unmuteMember(message.guild_id, uid);
      count++;
    } catch (error) {
      client.logger.warn(error);
    }
    response = `Unmuted **${count}** user${count > 1 ? 's' : ''}`;
  }

  // Feedback
  client.reply(message, response).catch(client.logger.warn);
};

export default {
  execute,
  data: {
    name: 'unmute',
    description: 'Unmute a member in the server.',
    slash: true,
    usage: 'unmute {users}',
    permissions: ['MUTE_MEMBERS'],
    options: [
      {
        name: 'user',
        description: 'The user to unmute',
        type: 6, // USER type
        required: true
      }
    ]
  }
};
