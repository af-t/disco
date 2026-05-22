import * as send from './discord-send.js';
import * as reply from './discord-reply.js';
import * as react from './discord-react.js';
import * as read from './discord-read.js';
import * as getUser from './discord-get-user.js';
import * as getChannel from './discord-get-channel.js';
import * as getGuild from './discord-get-guild.js';
import * as getRole from './discord-get-role.js';
import * as getThread from './discord-get-thread.js';
import * as fetchHistory from './discord-fetch-history.js';

const MODULES = [send, reply, react, read, getUser, getChannel, getGuild, getRole, getThread, fetchHistory];

export const ACTION_TOOL_NAMES = new Set(['discord_send', 'discord_reply', 'discord_react']);

export const TOOL_DEFINITIONS = MODULES.map((m) => m.definition);

const EXECUTORS = new Map(MODULES.map((m) => [m.definition.name, m.execute]));

// Returns the parent-side executor for a tool name, or null.
export function getExecutor(name) {
  return EXECUTORS.get(name) ?? null;
}

// Build proxy tools for a child agent: each execute() RPCs the parent.
// `rpc` is (name, input) => Promise<resultString>.
export function buildProxyTools(rpc) {
  return TOOL_DEFINITIONS.map((def) => ({
    ...def,
    execute: (input) => rpc(def.name, input ?? {}),
  }));
}
