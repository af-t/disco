// Time conversation units
const TIME_UNITS = {
  s: 1000,
  m: 1000 * 60,
  h: 1000 * 60 * 60,
  d: 1000 * 60 * 60 * 24,
  w: 1000 * 60 * 60 * 24 * 7,
  M: 1000 * 60 * 60 * 24 * 30,
  y: 1000 * 60 * 60 * 24 * 365,
  ms: 1
}

function parseDuration(duration) {
  if (!duration || typeof duration !== 'string') return;
  const match = duration.match(/^(\d+)(ms|[smhdwMy])$/);
  if (!match) return;
  const [value, unit] = match.slice(1);
  const multiplier = TIME_UNITS[unit];
  if (!multiplier) return;
  return Number(value) * multiplier;
}

function extractUserID(input) {
  if (!input || typeof input !== 'string') return;
  let id = input.match(/<@!?(\d+)>/)?.[1];
  if (!id && !isNaN(Number(input))) id = input;
  if (id?.length > 15) return id;
}

const execute = async(client, message, args) => {
  let memberId = extractUserID(args[0]);
  let duration = parseDuration(args[1]);

  if (!memberId && message.message_reference) try {
    const ref = await client.getMessage(message.channel_id, message.message_reference.message_id);
    memberId = ref.author.id;
    duration = parseDuration(args[0]);
  } catch (error) {
    client.logger.warn(error);
  }

  if (!duration) {
    client.reply(message, 'Invalid duration').catch(client.logger.warn);
    return;
  }
  if (!memberId) {
    client.reply(message, 'Invalid member').catch(client.logger.warn);
    return;
  }

  try {
    await client.muteMember(message.guild_id, memberId, duration);
    await client.reply(message, `<@!${message.author.id}>\nMuted <@${memberId}>`);
    await client.deleteMessage(message.channel_id, message.id);
  } catch (error) {
    client.logger.warn(error);
    client.reply(message, `Failed to mute <@${memberId}>`).catch(client.logger.warn);
  }
};

export default {
  execute,
  data: {
    name: 'mute',
    description: 'Mute a member for a specified duration.',
    slash: true,
    usage: 'mute {member} {duration}',
    permissions: ['MUTE_MEMBERS'],
    options: [
      {
        name: 'member',
        description: 'The member to mute',
        type: 6, // USER type
        required: true
      },
      {
        name: 'duration',
        description: 'Duration (e.g., 1h, 30m)',
        type: 3, // STRING type
        required: true
      }
    ]
  }
};
