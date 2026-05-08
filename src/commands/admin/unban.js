import { createCase, resolveCase, getCasesByUser } from '../../lib/case.js';
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
      // Unban referenced user
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
    response = 'Please specify at least one valid user ID to unban. Usage: `.unban <user_id>`';
  } else {
    let count = 0;
    const unbanReason = reason.join(' ');
    for (const uid of uids)
      try {
        await client.unbanMember(message.guild_id, uid, unbanReason);
        const caseId = await createCase(client, message.guild_id, 'unban', uid, message.author.id, unbanReason);
        await postModLog(client, message.guild_id, {
          action: 'unban',
          userId: uid,
          moderatorId: message.author.id,
          reason: unbanReason || 'No reason',
          caseId,
        });
        const banCases = await getCasesByUser(client, message.guild_id, uid, 50);
        for (const c of banCases) {
          if (c.type === 'ban' && !c.resolved) await resolveCase(client, message.guild_id, c.id);
        }
        count++;
      } catch (error) {
        client.logger.warn(error);
      }
    response = `Removed ban for **${count}** user${count > 1 ? 's' : ''}`;
  }

  // Feedback
  client.reply(message, response).catch((err) => client.logger?.warn?.('Failed to send unban feedback:', err));
};

export default {
  execute,
  data: {
    name: 'unban',
    description: 'Unban a user from the server.',
    slash: true,
    usage: 'unban {user}',
    permissions: ['BAN_MEMBERS'],
    options: [
      {
        name: 'user',
        description: 'The user ID to unban',
        type: 3, // STRING type (since they are not in the guild, USER type might not work as easily with autocomplete if not cached)
        required: true,
      },
    ],
  },
};
