// Serializes counter increments per guild so concurrent cases never
// collide: the verify-loop could not detect two writers landing on the
// same incremented value, silently overwriting one record.
const caseQueues = new Map();

export async function createCase(client, guildId, type, userId, moderatorId, reason = '', duration = null) {
  const run = (caseQueues.get(guildId) ?? Promise.resolve()).then(async () => {
    const counterKey = `modcase:${guildId}:counter`;
    const counter = ((await client.store.get(counterKey)) || 0) + 1;
    await client.store.set(counterKey, counter);

    const caseData = {
      id: counter,
      type,
      user_id: userId,
      moderator_id: moderatorId,
      reason: reason.trim() || 'No reason provided',
      created_at: Date.now(),
      resolved: false,
      resolved_at: null,
    };

    if (duration !== null) {
      caseData.duration = duration;
    }

    await client.store.set(`modcase:${guildId}:${counter}`, caseData);
    return counter;
  });

  // A rejected case must not wedge the guild's queue for later calls.
  caseQueues.set(
    guildId,
    run.catch(() => {}),
  );
  return run;
}

export async function resolveCase(client, guildId, caseId) {
  const caseData = await client.store.get(`modcase:${guildId}:${caseId}`);
  if (!caseData) return false;

  caseData.resolved = true;
  caseData.resolved_at = Date.now();
  await client.store.set(`modcase:${guildId}:${caseId}`, caseData);
  return true;
}

async function _fetchCases(client, guildId, limit, filterFn) {
  const counter = (await client.store.get(`modcase:${guildId}:counter`)) || 0;
  const cases = [];
  for (let i = counter; i >= 1 && cases.length < limit; i--) {
    const c = await client.store.get(`modcase:${guildId}:${i}`);
    if (c && filterFn(c)) cases.push(c);
  }
  return cases;
}

export async function getCasesByUser(client, guildId, userId, limit = 25) {
  return _fetchCases(client, guildId, limit, (c) => c.user_id === userId);
}

export async function getRecentCases(client, guildId, limit = 25) {
  return _fetchCases(client, guildId, limit, () => true);
}
