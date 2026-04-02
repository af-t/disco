//Constants
const titles = ['Server Avatar', 'User Avatar'];

//Helper function to get Discord CDN Url
const getCdnUrl = (uid, aid) => `https://cdn.discordapp.com/avatars/${uid}/${aid}`;

//Main function
const execute = async (c, m, a) => {
  const uids = new Set(); // .size never be below 1
  const embeds = [];

  for (let i = 0; i < a.length; i++) {
    let uid = a[i].match(/<@!?(\d+)>/)?.[1];
    if (!uid && !isNaN(Number(a[i]))) uid = a[i];
    if (uid.length > 15) uids.add(uid);
  }

  if (uids.size < 1 && m.message_reference) try {
    const mref = await c.getMessage(m.message_reference.channel_id, m.message_reference.message_id);
    uids.add(mref.author.id);
  } catch (error) {
    // message doesn't exist or has been deleted
    console.warn(error);
  }

  if (uids.size < 1) uids.add(m.author.id);

  for (const uid of uids) {// Prosess ids to embeds
    let avatar, nick, title = titles[0];
    try {
      const meta = (m.member && uid === m.author.id) ? m.member : await c.getGuildMember(m.guild_id, uid);
      avatar = meta.avatar || meta.user.avatar;
      nick = meta.nick || meta.user.username;

      if (!(avatar && nick)) throw 1; // the part that will probably never triggered
    } catch {
      try {
        const meta = await c.getUser(uid);
        avatar = meta.avatar;
        nick = meta.username;
        title = titles[1];
      } catch (error) {
        console.warn(error);
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
  c.reply(m, null, false, { embeds }).catch(console.warn);
};

export default {
  execute,
  data: {
    name: 'avatar',
    description: 'Get the avatar of a user or the server.',
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
