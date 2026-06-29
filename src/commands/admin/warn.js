import { createCase } from '../../lib/case.js';
import { postModLog } from '../../lib/modlog.js';
import { extractUserID } from './adminUtils.js';

const execute = async (client, message, args) => {
  let memberId = extractUserID(args[0]);
  const reason = memberId ? args.slice(1).join(' ').trim() : args.join(' ').trim();

  if (!memberId && message.message_reference) {
    try {
      const ref = await client.getMessage(message.channel_id, message.message_reference.message_id);
      memberId = ref.author.id;
    } catch (error) {
      client.logger.warn(error);
    }
  }

  if (!memberId) {
    await client.reply(message, 'Please specify a valid user to warn. Usage: `.warn @user [reason]`');
    return;
  }

  try {
    const caseId = await createCase(client, message.guild_id, 'warn', memberId, message.author.id, reason);
    await postModLog(client, message.guild_id, {
      action: 'warn',
      userId: memberId,
      moderatorId: message.author.id,
      reason: reason || 'No reason',
      caseId,
    });
    await client.reply(
      message,
      `<@${message.author.id}> warned <@${memberId}> (Case #${caseId}${reason ? `: _${reason}_` : ''})`,
    );
  } catch (error) {
    client.logger.error('warn failed:', error);
    await client.reply(message, `Failed to warn <@${memberId}>`);
  }
};

export default {
  execute,
  data: {
    name: 'warn',
    description: 'Warn a member with a recorded case.',
    slash: true,
    usage: 'warn {member} [reason]',
    permissions: ['MODERATE_MEMBERS'],
    options: [
      {
        name: 'member',
        description: 'The member to warn',
        type: 6,
        required: true,
      },
      {
        name: 'reason',
        description: 'Reason for the warning',
        type: 3,
        required: false,
      },
    ],
  },
};
