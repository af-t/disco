import createAgent from 'openrouter';
import { ChannelAIRuntime } from './runtime.js';
import { registerTools } from './tools/index.js';

let runtime = null;
let agent = null;

export async function init(client) {
  if (runtime) return runtime;
  if (process.env.AI_NATURAL_MODE !== '1') return null;

  agent = await createAgent({ maxTurns: 0 });

  const config = {
    debounceMs: Number(process.env.AI_DEBOUNCE_MS) || 4000,
    forceDebounceMs: Number(process.env.AI_FORCE_DEBOUNCE_MS) || 500,
    channelCooldownMs: Number(process.env.AI_CHANNEL_COOLDOWN_MS) || 20_000,
    dailyLimit: Number(process.env.AI_DAILY_LIMIT) || 500,
    bufferSize: Number(process.env.AI_BUFFER_SIZE) || 30,
    compactThreshold: Number(process.env.AI_COMPACT_THRESHOLD) || 100,
    fetchHistoryMax: Number(process.env.AI_FETCH_HISTORY_MAX) || 50,
  };

  const mutedChannelsResolver = async (guildId) => {
    try {
      const list = await client.store.get(`config:${guildId}:ai_muted_channels`);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };

  const summarizer = async (messages) => {
    const tmp = await createAgent({ maxTurns: 1 });
    tmp.messages = [];
    const body = messages
      .map((m) => `[${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
      .join('\n');
    return await tmp.run(
      `Summarize the following conversation segment in 6-12 lines. Preserve names, actions, and unresolved threads. No preamble.\n\n${body}`,
    );
  };

  runtime = new ChannelAIRuntime({ client, agent, config, mutedChannelsResolver, summarizer });
  registerTools(agent, { client, runtime });
  client.aiRuntime = runtime;
  client.logger?.info?.(`AI natural mode enabled as ${runtime.identity.name}`);
  return runtime;
}

export function getRuntime() {
  return runtime;
}
