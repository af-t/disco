import { createCase } from '../../lib/case.js';
import { postModLog } from '../../lib/modlog.js';
import { extractUserID } from './adminUtils.js';

// Time conversation units
const TIME_UNITS = {
  s: 1000,
  m: 1000 * 60,
  h: 1000 * 60 * 60,
  d: 1000 * 60 * 60 * 24,
  w: 1000 * 60 * 24 * 7,
  M: 1000 * 60 * 60 * 24 * 30,
  y: 1000 * 60 * 60 * 24 * 365,
  ms: 1,
};

function parseDuration(duration) {
  if (!duration || typeof duration !== 'string') return;
  const match = duration.match(/^(\d+)(ms|[smhdwMy])$/);
  if (!match) return;
  const [value, unit] = match.slice(1);
  const multiplier = TIME_UNITS[unit];
  if (!multiplier) return;
  return Number(value) * multiplier;
}

const execute = async (client, message, args) => {
  let memberId = extractUserID(args[0]);
  let duration = parseDuration(args[1]);
  let isReplyCase = false;

  if (!memberId && message.message_reference)
    try {
      const ref = await client.getMessage(message.channel_id, message.message_reference.message_id);
      memberId = ref.author.id;
      duration = parseDuration(args[0]);
      isReplyCase = true;
    } catch (error) {
      client.logger.warn(error);
    }

  if (!memberId) {
    client
      .reply(
        message,
        'Please specify a valid user to mute. Usage: `.mute @user <duration>` (e.g., `.mute @user 10m`, `.mute @user 1h`)',
      )
      .catch((err) => client.logger?.warn?.('Failed to send member error:', err));
    return;
  }
  if (!duration) {
    client
      .reply(message, 'Invalid duration format. Please use a valid duration (e.g., `10m`, `1h`, `7d`, `30s`).')
      .catch((err) => client.logger?.warn?.('Failed to send duration error:', err));
    return;
  }

  try {
    await client.muteMember(message.guild_id, memberId, duration);
    const muteReason = (isReplyCase ? args.slice(1) : args.slice(2)).join(' ').trim() || 'No reason';
    const caseId = await createCase(
      client,
      message.guild_id,
      'mute',
      memberId,
      message.author.id,
      muteReason,
      duration,
    );
    await postModLog(client, message.guild_id, {
      action: 'mute',
      userId: memberId,
      moderatorId: message.author.id,
      reason: muteReason,
      caseId,
      duration,
    });
    await client.reply(message, `<@!${message.author.id}>\nMuted <@${memberId}>`);
    await client.deleteMessage(message.channel_id, message.id);
  } catch (error) {
    client.logger.warn(error);
    client
      .reply(message, `Failed to mute <@${memberId}>`)
      .catch((err) => client.logger?.warn?.('Failed to send mute error:', err));
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
        required: true,
      },
      {
        name: 'duration',
        description: 'Duration (e.g., 1h, 30m)',
        type: 3, // STRING type
        required: true,
      },
    ],
  },
};
