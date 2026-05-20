import { createDiscordSendTool } from './discord-send.js';
import { createDiscordReplyTool } from './discord-reply.js';
import { createDiscordReactTool } from './discord-react.js';
import { createDiscordReadTool } from './discord-read.js';
import { createDiscordGetUserTool } from './discord-get-user.js';
import { createDiscordGetChannelTool } from './discord-get-channel.js';
import { createDiscordGetGuildTool } from './discord-get-guild.js';
import { createDiscordGetRoleTool } from './discord-get-role.js';
import { createDiscordGetThreadTool } from './discord-get-thread.js';
import { createDiscordFetchHistoryTool } from './discord-fetch-history.js';

export const ACTION_TOOL_NAMES = new Set(['discord_send', 'discord_reply', 'discord_react']);

export function registerTools(agent, { client, runtime }) {
  const factories = [
    createDiscordSendTool,
    createDiscordReplyTool,
    createDiscordReactTool,
    createDiscordReadTool,
    createDiscordGetUserTool,
    createDiscordGetChannelTool,
    createDiscordGetGuildTool,
    createDiscordGetRoleTool,
    createDiscordGetThreadTool,
    createDiscordFetchHistoryTool,
  ];
  for (const make of factories) {
    agent.tools.register(make({ client, runtime }));
  }
}
