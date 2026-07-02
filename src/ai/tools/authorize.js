import { formatToolError } from './error.js';
import { channelScopeError } from './scope.js';
import permissionFlags from '../../lib/permission.js';
import utility from '../../lib/utility.js';

const ADMIN = permissionFlags.ADMINISTRATOR;

// Parent-side gate: an action only proceeds if a real admin instructed it.
export async function authorize(
  { client, runtime, agentKey, agentContext },
  { channel_id, authorizing_message_id },
  requiredPermission,
) {
  if (!channel_id || !authorizing_message_id) {
    return { ok: false, error: 'channel_id and authorizing_message_id are required' };
  }
  const flag = permissionFlags[requiredPermission];
  if (flag == null) return { ok: false, error: `unknown permission ${requiredPermission}` };

  const scopeError = channelScopeError({ agentKey, agentContext }, channel_id);
  if (scopeError) return { ok: false, error: scopeError };

  let guildId = null;
  try {
    const ch = await client.getChannel(channel_id);
    guildId = ch?.guild_id ?? null;
  } catch {}
  if (!guildId) guildId = runtime?._agentGuild?.get?.(`channel:${channel_id}`) ?? null;
  if (!guildId) return { ok: false, error: 'this action is only available in a guild' };

  // Only the current turn's messages may authorize.
  const scopedTriggers = agentKey ? runtime?.getAuthorizableIds?.(agentKey) : null;
  const state = runtime?.channels?.get?.(channel_id);
  const triggers = scopedTriggers ?? state?.authorizableIds;
  const inTurn = typeof triggers?.has === 'function' && triggers.has(authorizing_message_id);
  if (!inTurn) {
    return { ok: false, error: 'authorizing_message_id is not the instruction that triggered this turn' };
  }

  let authorId;
  try {
    const msg = await client.getMessage(channel_id, authorizing_message_id);
    authorId = msg?.author?.id;
    if (!authorId || msg.author?.bot) {
      return { ok: false, error: 'authorizing message must be from a non-bot user' };
    }
  } catch (err) {
    return { ok: false, error: `cannot fetch authorizing message: ${formatToolError(err)}` };
  }

  let perms;
  try {
    const member = await client.getGuildMember(guildId, authorId, { force: true });
    perms = await utility.getPermissions(client, guildId, member, { force: true });
  } catch (err) {
    return { ok: false, error: `cannot resolve permissions: ${formatToolError(err)}` };
  }

  const isAdmin = (perms & ADMIN) === ADMIN;
  const authorized = isAdmin || (perms & flag) === flag;
  if (!authorized) {
    return { ok: false, error: `user ${authorId} lacks ${requiredPermission}; only an admin can authorize this` };
  }
  return { ok: true, guildId, authorizedBy: authorId, permissions: perms, isAdmin };
}
