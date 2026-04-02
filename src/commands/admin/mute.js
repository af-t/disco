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

const execute = async(c, d, a) => {
  let memberId = extractUserID(a[0]);
  let duration = parseDuration(a[1]);

  if (!memberId && d.message_reference) try {
    const ref = await c.getMessage(d.channel_id, d.message_reference.message_id);
    memberId = ref.author.id;
    duration = parseDuration(a[0]);
  } catch (error) {
    console.warn(error);
  }

  if (!duration) {
    c.reply(d, 'Invalid duration').catch(console.warn);
    return;
  }
  if (!memberId) {
    c.reply(d, 'Invalid member').catch(console.warn);
    return;
  }

  try {
    await c.muteMember(d.guild_id, memberId, duration);
    await c.reply(d, `<@!${d.author.id}>\nMuted <@${memberId}>`);
    await c.deleteMessage(d.channel_id, d.id);
  } catch (error) {
    console.warn(error);
    c.reply(d, `Failed to mute <@${memberId}>`).catch(console.warn);
  }
};

export default {
  execute,
  data: {
    name: 'mute',
    description: 'Mute a member for a specified duration.',
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
