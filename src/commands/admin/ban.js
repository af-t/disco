import { createCase } from '../../lib/case.js';
import { postModLog } from '../../lib/modlog.js';

function extractUserID(input) {
  if (!input || typeof input !== 'string') return;
  let id = input.match(/<@!?(\d+)>/)?.[1];
  if (!id && !isNaN(Number(input))) id = input;
  if (id?.length > 15) return id;
}

const execute = async (client, message, args) => {
  let response;
  const uids = new Set();
  const reason = [];

  if (message.message_reference)
    try {
      // Ban referenced user
      const m = await client.getMessage(message.channel_id, message.message_reference.message_id);
      uids.add(m.author.id);
      reason.push(...args);
    } catch (error) {
      client.logger.warn(error);
    }

  if (uids.size < 1)
    for (const i of args) {
      // Gets user ids from args
      const id = extractUserID(i);
      if (id) uids.add(id);
      else reason.push(i);
    }

  if (uids.size < 1) {
    response = 'Please specify at least one valid user to ban. Mention users or provide their IDs.';
  } else {
    let count = 0;
    const banReason = reason.join(' ');
    for (const uid of uids)
      try {
        await client.banMember(message.guild_id, uid, { reason: banReason });
        const caseId = await createCase(client, message.guild_id, 'ban', uid, message.author.id, banReason);
        await postModLog(client, message.guild_id, {
          action: 'ban',
          userId: uid,
          moderatorId: message.author.id,
          reason: banReason,
          caseId,
        });
        count++;
      } catch (error) {
        client.logger.warn(error);
      }
    response = `Banned **${count}** user${count > 1 ? 's' : ''}`;
  }

  // Feedback
  client.reply(message, response).catch((err) => client.logger?.warn?.('Failed to send ban feedback:', err));
};

export default {
  execute,
  data: {
    name: 'ban',
    description: 'Ban a user from the server.',
    slash: true,
    usage: 'ban {user} [reason]',
    permissions: ['BAN_MEMBERS'],
    options: [
      {
        name: 'user',
        description: 'The user to ban',
        type: 6, // USER type
        required: true,
      },
      {
        name: 'reason',
        description: 'The reason for the ban',
        type: 3, // STRING type
        required: false,
      },
    ],
  },
};
