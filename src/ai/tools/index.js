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
import * as sendEmbed from './discord-send-embed.js';
import * as sendSticker from './discord-send-sticker.js';
import * as sendMedia from './discord-send-media.js';
import * as listExpressions from './discord-list-expressions.js';
import * as deleteMessage from './discord-delete-message.js';
import * as bulkDelete from './discord-bulk-delete.js';
import * as timeoutMember from './discord-timeout-member.js';
import * as removeTimeout from './discord-remove-timeout.js';
import * as kickMember from './discord-kick-member.js';
import * as banMember from './discord-ban-member.js';
import * as voiceMute from './discord-voice-mute-member.js';
import * as voiceDeafen from './discord-voice-deafen-member.js';
import * as voiceDisconnect from './discord-voice-disconnect-member.js';
import * as manageChannel from './discord-manage-channel.js';
import * as manageRole from './discord-manage-role.js';
import * as editGuild from './discord-edit-guild.js';

const MODULES = [
  send,
  reply,
  react,
  read,
  getUser,
  getChannel,
  getGuild,
  getRole,
  getThread,
  fetchHistory,
  sendEmbed,
  sendSticker,
  sendMedia,
  listExpressions,
  deleteMessage,
  bulkDelete,
  timeoutMember,
  removeTimeout,
  kickMember,
  banMember,
  voiceMute,
  voiceDeafen,
  voiceDisconnect,
  manageChannel,
  manageRole,
  editGuild,
];

export const ACTION_TOOL_NAMES = new Set([
  'discord_send',
  'discord_reply',
  'discord_react',
  'discord_send_embed',
  'discord_send_sticker',
  'discord_send_media',
]);

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
