//Constants
const titles = ['Server Avatar', 'User Avatar'];

//Helper function to get Discord CDN Url
const getCdnUrl = (uid, aid) => `https://cdn.discordapp.com/avatars/${uid}/${aid}`;

//Main function
const execute = async (client, message, args) => {
  const uids = new Set(); // .size never be below 1
  const embeds = [];

  for (let i = 0; i < args.length; i++) {
    let uid = args[i].match(/<@!?(\d+)>/)?.[1];
    if (!uid && !isNaN(Number(args[i]))) uid = args[i];
    if (uid && uid.length > 15) uids.add(uid);
  }

  if (uids.size < 1 && message.message_reference) try {
    const mref = await client.getMessage(message.message_reference.channel_id, message.message_reference.message_id);
    uids.add(mref.author.id);
  } catch (error) {
    // message doesn't exist or has been deleted
    client.logger.warn(error);
  }

  if (uids.size < 1) uids.add(message.author.id);

  for (const uid of uids) {// Prosess ids to embeds
    let avatar, nick, title = titles[0];
    try {
      const meta = (message.member && uid === message.author.id) ? message.member : await client.getGuildMember(message.guild_id, uid);
      avatar = meta.avatar || meta.user.avatar;
      nick = meta.nick || meta.user.username;

      if (!(avatar && nick)) throw 1; // the part that will probably never triggered
    } catch {
      try {
        const meta = await client.getUser(uid);
        avatar = meta.avatar;
        nick = meta.username;
        title = titles[1];
      } catch (error) {
        client.logger.warn(error);
      }
    }

    embeds.push({
      author: {
        name: nick,
        icon_url: getCdnUrl(uid, avatar)
      },
      image: {
        width: 1024,
        height: 1024,
        url: getCdnUrl(uid, avatar) + '.png?size=4096'
      },
      title,
      type: 'rich'
    });
  }

  // Send results
  client.reply(message, null, false, { embeds }).catch(client.logger.warn);
};

export default {
  execute,
  data: {
    name: 'avatar',
    description: 'Get the avatar of a user or the server.',
    slash: true,
    aliases: ['av', 'pp', 'pfp'],
    usage: 'avatar [user]',
    options: [
      {
        name: 'user',
        description: 'The user to get the avatar of',
        type: 6, // USER type
        required: false
      }
    ]
  }
}
