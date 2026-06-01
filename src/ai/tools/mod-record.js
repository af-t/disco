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
