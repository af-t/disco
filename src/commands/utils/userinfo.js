const execute = async (client, message, args) => {
  let userId = message.author.id;
  if (args[0]) {
    const mentionMatch = args[0].match(/<@!?(\d+)>/);
    userId = mentionMatch ? mentionMatch[1] : args[0].length > 15 ? args[0] : message.author.id;
  }

  try {
    const user = await client.getUser(userId);
    let member;
    if (message.guild_id) {
      member = await client.getGuildMember(message.guild_id, userId).catch((err) => {
        client.logger?.debug?.('Could not fetch guild member (may not be in server):', userId, err?.message);
        return null;
      });
    }

    const embed = {
      title: `${user.username}#${user.discriminator || '0'} Information`,
      thumbnail: { url: `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=1024` },
      fields: [
        { name: '👤 Username', value: user.username, inline: true },
        { name: '🆔 User ID', value: user.id, inline: true },
        {
          name: '📅 Created At',
          value: `<t:${Math.floor(Number((BigInt(user.id) >> 22n) + 1420070400000n) / 1000)}:R>`,
          inline: true,
        },
      ],
      color: 0x5865f2,
    };

    if (member) {
      embed.fields.push(
        {
          name: '📥 Joined At',
          value: `<t:${Math.floor(new Date(member.joined_at).getTime() / 1000)}:R>`,
          inline: true,
        },
        { name: '🛡️ Roles', value: `${member.roles.length} role(s)`, inline: true },
      );
      if (member.nick) embed.fields.push({ name: '📛 Nickname', value: member.nick, inline: true });
    }

    await client.reply(message, null, false, { embeds: [embed] });
  } catch (error) {
    client.logger.error(error);
    await client.reply(message, 'Failed to fetch user information.');
  }
};

export default {
  execute,
  data: {
    name: 'userinfo',
    description: 'Show information about a user.',
    slash: true,
    aliases: ['ui', 'whois', 'user'],
    usage: 'userinfo [user]',
    options: [
      {
        name: 'user',
        description: 'The user to get the information of',
        type: 6, // USER type
        required: false,
      },
    ],
  },
};
