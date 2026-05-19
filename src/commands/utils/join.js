import permissionFlags from '../../lib/permission.js';

const execute = async (client, message, args) => {
  const channelId = args[0];
  if (!channelId)
    return client.reply(message, 'Please provide a voice channel ID or mention. Usage: `.join <channel_id>`');

  let targetChannel;

  try {
    const mentionMatch = channelId.match(/<#(\d+)>/);
    const resolvedId = mentionMatch ? mentionMatch[1] : channelId;

    targetChannel = await client.getChannel(resolvedId);
    if (!targetChannel) {
      return client.reply(message, 'Channel not found. Please provide a valid voice channel.');
    }

    // Discord channel types: 2 = GUILD_VOICE, 13 = GUILD_STAGE_VOICE
    if (targetChannel.type !== 2 && targetChannel.type !== 13) {
      return client.reply(
        message,
        'The specified channel is not a voice channel. Please provide a valid voice channel.',
      );
    }

    // Verify the channel is in the same guild
    if (targetChannel.guild_id !== message.guild_id) {
      return client.reply(message, 'The specified channel is not in this server.');
    }

    // Check bot permissions in the guild
    if (message.guild_id && message.member) {
      try {
        const botMember = await client.getGuildMember(message.guild_id, client._session.user.id);
        let botPerms = 0n;
        const guildRoles = await client.getRoles(message.guild_id);
        for (const roleId of botMember.roles) {
          const role = guildRoles.find((r) => r.id === roleId);
          if (role) botPerms |= BigInt(role.permissions);
        }

        const hasConnect = (botPerms & permissionFlags.CONNECT) === permissionFlags.CONNECT;
        const hasSpeak = (botPerms & permissionFlags.SPEAK) === permissionFlags.SPEAK;
        const isAdmin = (botPerms & permissionFlags.ADMINISTRATOR) === permissionFlags.ADMINISTRATOR;

        if (!isAdmin) {
          if (!hasConnect)
            return client.reply(message, '❌ I do not have the **CONNECT** permission to join that voice channel.');
          if (!hasSpeak)
            return client.reply(message, '❌ I do not have the **SPEAK** permission in that voice channel.');
        }
      } catch (permError) {
        client.logger?.debug?.('Could not verify bot permissions:', permError.message);
        // Proceed anyway since the error might be due to cache
      }
    }
  } catch (err) {
    client.logger.error('Voice channel validation failed:', err);
    return client.reply(message, '❌ Invalid channel. Please provide a valid voice channel.');
  }

  try {
    await client.reply(message, `⏳ Joining <#${channelId}>...`);
    await client.joinVoice(targetChannel.id, message.guild_id);
    await client.reply(message, '✅ Connected to voice channel!');
  } catch (err) {
    client.logger.error('Voice join failed:', err);
    await client.reply(message, '❌ Failed to join the voice channel. Please try again.');
  }
};

export default {
  execute,
  data: {
    name: 'join',
    description: 'Join a voice channel',
    slash: true,
    usage: 'join <channel_id>',
    permissions: ['CONNECT', 'SPEAK'],
    options: [
      {
        name: 'channel',
        description: 'The voice channel to join',
        type: 7, // CHANNEL type
        required: true,
        channel_types: [2], // Voice channels only
      },
    ],
  },
};
