import { ChannelAIRuntime } from './runtime.js';
import { AgentPool } from './agent-pool.js';

let runtime = null;
let pool = null;

export async function init(client) {
  if (runtime) return runtime;
  if (process.env.AI_NATURAL_MODE !== '1') return null;

  const config = {
    debounceMs: Number(process.env.AI_DEBOUNCE_MS) || 4000,
    forceDebounceMs: Number(process.env.AI_FORCE_DEBOUNCE_MS) || 500,
    channelCooldownMs: Number(process.env.AI_CHANNEL_COOLDOWN_MS) || 20_000,
    dailyLimit: Number(process.env.AI_DAILY_LIMIT) || 500,
    bufferSize: Number(process.env.AI_BUFFER_SIZE) || 30,
    compactThreshold: Number(process.env.AI_COMPACT_THRESHOLD) || 100,
    fetchHistoryMax: Number(process.env.AI_FETCH_HISTORY_MAX) || 50,
    maxTurns: Number(process.env.OPENROUTER_MAX_TURNS) || 120,
  };

  const mutedChannelsResolver = async (guildId) => {
    try {
      const list = await client.store.get(`config:${guildId}:ai_muted_channels`);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };

  // The runtime is created first so the pool's ChildHandles can call back
  // into it (onAgentCharge / onAgentMessages); pool is attached right after.
  runtime = new ChannelAIRuntime({ client, pool: null, config, mutedChannelsResolver });

  pool = new AgentPool({
    ctx: { client, runtime },
    logger: client.logger,
    idleMs: Number(process.env.AI_AGENT_IDLE_MS) || 300_000,
    maxChildren: Number(process.env.AI_MAX_AGENTS) || 16,
    respawnCooldownMs: Number(process.env.AI_AGENT_RESPAWN_COOLDOWN_MS) || 30_000,
  });
  runtime.pool = pool;

  client.aiRuntime = runtime;
  client.aiPool = pool;
  client.logger?.info?.(`AI natural mode enabled as ${runtime.identity.name}`);
  return runtime;
}

export function getRuntime() {
  return runtime;
}
