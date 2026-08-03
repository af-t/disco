import { formatToolError } from './error.js';
import { createCase } from '../../lib/case.js';
import { postModLog } from '../../lib/modlog.js';

// Files a mod case + modlog entry; failures never block the action.
export async function recordModeration(client, { guildId, action, caseType, userId, moderatorId, reason, duration }) {
  let caseId = null;
  try {
    caseId = await createCase(client, guildId, caseType, userId, moderatorId, reason, duration ?? null);
  } catch (err) {
    client.logger?.warn?.('AI moderation createCase failed', err);
  }
  try {
    await postModLog(client, guildId, { action, userId, moderatorId, reason, caseId, duration });
  } catch (err) {
    client.logger?.warn?.('AI moderation postModLog failed', err);
  }
  return caseId;
}

export async function executeModeration(ctx, input, auth, action, reason, doAction, duration = null) {
  try {
    await doAction();
    await recordModeration(ctx.client, {
      guildId: auth.guildId,
      action,
      caseType: action,
      userId: input.user_id,
      moderatorId: auth.authorizedBy,
      reason,
      duration,
    });
    return JSON.stringify({ ok: true });
  } catch (err) {
    return JSON.stringify({ ok: false, error: formatToolError(err) });
  }
}

export function standardModActionSchema(name, description) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string' },
        user_id: { type: 'string' },
        reason: { type: 'string' },
        authorizing_message_id: { type: 'string' },
      },
      required: ['channel_id', 'user_id', 'authorizing_message_id'],
    },
  };
}
