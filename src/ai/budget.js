const TTL_MS = 48 * 60 * 60 * 1000;

function utcDateKey(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function createBudget({ store, limit, clock = () => Date.now() }) {
  const keyFor = (guildId) => `ai_budget:${guildId}:${utcDateKey(clock())}`;
  const guildQueues = new Map();

  async function current(guildId) {
    if (!guildId) return { count: 0, key: null };
    const k = keyFor(guildId);
    const v = await store.get(k);
    return { count: v?.count ?? 0, key: k };
  }

  // Chain increments per guild so a racing read-then-write never loses a count.
  async function increment(guildId) {
    if (!guildId) return;
    const run = (guildQueues.get(guildId) ?? Promise.resolve()).then(async () => {
      const { count, key } = await current(guildId);
      await store.set(key, { count: count + 1, updated: clock() }, { isCache: true, ttl: TTL_MS });
    });
    guildQueues.set(
      guildId,
      run.catch(() => {}),
    );
    return run;
  }

  async function exhausted(guildId) {
    if (!guildId) return false;
    const { count } = await current(guildId);
    return count >= limit;
  }

  return { current, increment, exhausted, _keyFor: keyFor };
}
