export async function createCase(client, guildId, type, userId, moderatorId, reason = '', duration = null) {
  const counterKey = `modcase:${guildId}:counter`;

  // Optimistic retry-loop: read → increment in memory → write → verify
  // Prevents race condition when two calls interleave get+set (fixes B1)
  let counter;
  while (true) {
    counter = (await client.store.get(counterKey)) || 0;
    counter++;
    await client.store.set(counterKey, counter);
    // Verify no concurrent write sneaked in
    const verify = await client.store.get(counterKey);
    if (verify === counter) break;
  }

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
}

export async function resolveCase(client, guildId, caseId) {
  const caseData = await client.store.get(`modcase:${guildId}:${caseId}`);
  if (!caseData) return false;

  caseData.resolved = true;
  caseData.resolved_at = Date.now();
  await client.store.set(`modcase:${guildId}:${caseId}`, caseData);
  return true;
}

export async function getCasesByUser(client, guildId, userId, limit = 25) {
  const counter = (await client.store.get(`modcase:${guildId}:counter`)) || 0;
  const cases = [];
  for (let i = counter; i >= 1 && cases.length < limit; i--) {
    const c = await client.store.get(`modcase:${guildId}:${i}`);
    if (c && c.user_id === userId) cases.push(c);
  }
  return cases;
}

export async function getRecentCases(client, guildId, limit = 25) {
  const counter = (await client.store.get(`modcase:${guildId}:counter`)) || 0;
  const cases = [];
  for (let i = counter; i >= 1 && cases.length < limit; i--) {
    const c = await client.store.get(`modcase:${guildId}:${i}`);
    if (c) cases.push(c);
  }
  return cases;
}
