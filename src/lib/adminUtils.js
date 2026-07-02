import { createCase } from './case.js';
import { postModLog } from './modlog.js';
import { assertCanModerateMember } from './role-hierarchy.js';
export function extractUserID(input) {
  if (!input || typeof input !== 'string') return;
  let id = input.match(/<@!?(\d+)>/)?.[1];
  if (!id && !isNaN(Number(input))) id = input;
  if (id?.length > 15) return id;
}

export async function parseModCommandArgs(client, message, args) {
  const uids = new Set();
  const reason = [];

  if (message.message_reference) {
    try {
      const m = await client.getMessage(message.channel_id, message.message_reference.message_id);
      uids.add(m.author.id);
      reason.push(...args);
    } catch (error) {
      client.logger.warn(error);
    }
  }

  if (uids.size < 1) {
    for (const i of args) {
      const id = extractUserID(i);
      if (id) uids.add(id);
      else reason.push(i);
    }
  }

  return { uids, reason };
}

export async function executeModAction(client, message, args, actionName, actionVerb, doAction) {
  let response;
  const { uids, reason } = await parseModCommandArgs(client, message, args);

  if (uids.size < 1) {
    response = `Please specify at least one valid user to ${actionName}. Mention users or provide their IDs.`;
  } else {
    let count = 0;
    let blocked = 0;
    const actionReason = reason.join(' ');
    for (const uid of uids) {
      try {
        const hierarchy = await assertCanModerateMember(client, message.guild_id, message.author.id, uid);
        if (!hierarchy.ok) {
          blocked++;
          continue;
        }
        await doAction(uid, actionReason);
        const caseId = await createCase(client, message.guild_id, actionName, uid, message.author.id, actionReason);
        await postModLog(client, message.guild_id, {
          action: actionName,
          userId: uid,
          moderatorId: message.author.id,
          reason: actionReason,
          caseId,
        });
        count++;
      } catch (error) {
        client.logger.warn(error);
      }
    }
    response = `${actionVerb} **${count}** user${count > 1 ? 's' : ''}`;
    if (blocked > 0) {
      response += `; **${blocked}** blocked by role hierarchy`;
    }
  }
  client.reply(message, response).catch((err) => client.logger?.warn?.(`Failed to send ${actionName} feedback:`, err));
}
