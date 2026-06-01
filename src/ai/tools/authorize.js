import permissionFlags from '../../lib/permission.js';
import utility from '../../lib/utility.js';

const ADMIN = permissionFlags.ADMINISTRATOR;

// Parent-side gate: an action only proceeds if a real admin instructed it.
export async function authorize(
  { client, runtime, agentKey },
  { channel_id, authorizing_message_id },
  requiredPermission,
) {
  if (!channel_id || !authorizing_message_id) {
    return { ok: false, error: 'channel_id and authorizing_message_id are required' };
  }
  const flag = permissionFlags[requiredPermission];
  if (flag == null) return { ok: false, error: `unknown permission ${requiredPermission}` };

  // A channel agent may only act on the channel it is running for.
  if (typeof agentKey === 'string' && agentKey.startsWith('channel:')) {
    const activeChannelId = agentKey.slice('channel:'.length);
    if (activeChannelId !== channel_id) {
      return { ok: false, error: 'cannot act on a channel outside this conversation' };
    }
  }

  let guildId = null;
  try {
    const ch = await client.getChannel(channel_id);
    guildId = ch?.guild_id ?? null;
  } catch {}
  if (!guildId) guildId = runtime?._agentGuild?.get?.(`channel:${channel_id}`) ?? null;
  if (!guildId) return { ok: false, error: 'this action is only available in a guild' };

  // Only a message that triggered the current turn can authorize, not any
  // older admin chatter still sitting in the rolling context buffer.
  const state = runtime?.channels?.get?.(channel_id);
  const triggers = state?.authorizableIds;
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
    return { ok: false, error: `cannot fetch authorizing message: ${String(err?.message ?? err)}` };
  }

  let perms;
  try {
    const member = await client.getGuildMember(guildId, authorId);
    perms = await utility.getPermissions(client, guildId, member);
  } catch (err) {
    return { ok: false, error: `cannot resolve permissions: ${String(err?.message ?? err)}` };
  }

  const authorized = (perms & ADMIN) === ADMIN || (perms & flag) === flag;
  if (!authorized) {
    return { ok: false, error: `user ${authorId} lacks ${requiredPermission}; only an admin can authorize this` };
  }
  return { ok: true, guildId, authorizedBy: authorId };
}
