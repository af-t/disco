const execute = async(c, d, a) => {
  let response;
  const uids = new Set();

  if (d.message_reference) try {// Ban referenced user
    const m = await c.getMessage(d.channel_id, d.message_reference.message_id);
    uids.add(m.author.id);
  } catch (error) {
    console.warn(error);
  }

  if (uids.size < 1) for (const i of a) {// Gets user ids from args
    let id = i.match(/<@!?(\d+)>/)?.[1];
    if (!id && !isNaN(Number(i))) id = i;
    if (id?.length > 15) uids.add(id);
  }

  if (uids.size < 1) {
    response = 'Please specify at least one user to ban';
  } else {
    let count = 0;
    for (const uid of uids) try {
      await c.banMember(d.guild_id, uid);
      count++;
    } catch (error) {
      console.warn(error);
    }
    response = `Banned **${count}** user${count > 1 ? 's' : ''}`;
  }

  // Feedback
  c.reply(d, response).catch(console.warn);
};

export default {
  execute,
  data: {
    name: 'ban',
    description: 'Ban a user from the server.',
    usage: 'ban {user} [reason]',
    permissions: ['BAN_MEMBERS'],
    options: [
      {
        name: 'user',
        description: 'The user to ban',
        type: 6, // USER type
        required: true
      },
      {
        name: 'reason',
        description: 'The reason for the ban',
        type: 3, // STRING type
        required: false
      }
    ]
  }
};
