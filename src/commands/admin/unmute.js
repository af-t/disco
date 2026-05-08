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

  if (message.message_reference)
    try {
      // Unmute referenced user
      const m = await client.getMessage(message.channel_id, message.message_reference.message_id);
      uids.add(m.author.id);
    } catch (error) {
      client.logger.warn(error);
    }

  if (uids.size < 1)
    for (const i of args) {
      // Gets user ids from args
      const id = extractUserID(i);
      if (id) uids.add(id);
    }

  if (uids.size < 1) {
    response = 'Please specify at least one valid user to unmute. Mention users or provide their IDs.';
  } else {
    let count = 0;
    for (const uid of uids)
      try {
        await client.unmuteMember(message.guild_id, uid);
        const caseId = await createCase(client, message.guild_id, 'unmute', uid, message.author.id, '');
        await postModLog(client, message.guild_id, {
          action: 'unmute',
          userId: uid,
          moderatorId: message.author.id,
          reason: 'No reason',
          caseId,
        });
        const muteCases = await getCasesByUser(client, message.guild_id, uid, 50);
        for (const c of muteCases) {
          if (c.type === 'mute' && !c.resolved) await resolveCase(client, message.guild_id, c.id);
        }
        count++;
      } catch (error) {
        client.logger.warn(error);
      }
    response = `Unmuted **${count}** user${count > 1 ? 's' : ''}`;
  }

  // Feedback
  client.reply(message, response).catch((err) => client.logger?.warn?.('Failed to send unmute feedback:', err));
};

export default {
  execute,
  data: {
    name: 'unmute',
    description: 'Unmute a member in the server.',
    slash: true,
    usage: 'unmute {users}',
    permissions: ['MUTE_MEMBERS'],
    options: [
      {
        name: 'user',
        description: 'The user to unmute',
        type: 6, // USER type
        required: true,
      },
    ],
  },
};
