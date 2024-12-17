const execute = async(c, d, a) => {
  let response;
  const uids = new Set();

  if (d.message_reference) try {// Unban referenced user
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
    response = 'Please specify at least one user to unban';
  } else {
    let count = 0;
    for (const uid of uids) try {
      await c.unbanMember(d.guild_id, uid);
      count++;
    } catch (error) {
      console.warn(error);
    }
    response = `Removed ban for **${count}** user${count > 1 ? 's' : ''}`;
  }

  // Feedback
  c.reply(d, response).catch(console.warn);
};

export default {
  execute,
  data: {
    name: 'unban',
    usage: 'unban {users}',
    permissions: ['BAN_MEMBERS']
  }
};
