import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function isOutside(base, target) {
  const rel = path.relative(base, target);
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

export function channelScopeError(ctx, channelId) {
  if (!channelId) return 'channel_id is required';
  const expected = ctx?.agentContext?.channelId;
  if (expected && expected !== channelId) return 'cannot act on a channel outside this conversation';
  const agentKey = ctx?.agentKey;
  if (
    typeof agentKey === 'string' &&
    agentKey.startsWith('channel:') &&
    agentKey.slice('channel:'.length) !== channelId
  ) {
    return 'cannot act on a channel outside this conversation';
  }
  return null;
}

export function guildScopeError(ctx, guildId) {
  if (!guildId) return 'guild_id is required';
  const expected = ctx?.agentContext?.guildId;
  if (expected && expected !== guildId) return 'cannot act on a guild outside this conversation';
  if (ctx?.agentContext && !expected) return 'this action is only available in a guild conversation';
  return null;
}

export async function sameGuildChannelError(ctx, channelId) {
  if (!channelId) return 'channel_id is required';
  const expectedGuildId = ctx?.agentContext?.guildId;
  if (!expectedGuildId) return null;
  try {
    const ch = await ctx.client.getChannel(channelId);
    if (ch?.guild_id && ch.guild_id !== expectedGuildId)
      return 'channel must be in the same guild as this conversation';
  } catch {
    return null;
  }
  return null;
}

export async function channelGuildScopeError(ctx, channelId) {
  const channelError = channelScopeError(ctx, channelId);
  if (channelError) return channelError;
  return sameGuildChannelError(ctx, channelId);
}

export async function targetChannelGuildError(ctx, channelId, guildId) {
  if (!channelId) return 'target_channel_id is required';
  try {
    const ch = await ctx.client.getChannel(channelId);
    if (!ch?.guild_id || ch.guild_id !== guildId)
      return 'target channel must be in the same guild as the authorizing message';
  } catch (err) {
    return `cannot verify target channel guild: ${err?.message ?? err}`;
  }
  return null;
}

export async function scopedMediaPath(ctx, url) {
  if (typeof url !== 'string') return { ok: false, error: 'url must be a string' };
  if (url.startsWith('http://') || url.startsWith('https://')) return { ok: true, url };

  const workspaceDir = ctx?.agentContext?.workspaceDir;
  if (!workspaceDir) return { ok: false, error: 'local file uploads require an agent workspace' };

  let localPath = url;
  try {
    if (url.startsWith('file://')) localPath = fileURLToPath(url);
  } catch {
    return { ok: false, error: 'invalid file URL' };
  }

  const root = path.resolve(workspaceDir);
  const resolved = path.resolve(localPath);
  const rootReal = await fs.realpath(root).catch(() => root);
  let fileReal;
  try {
    fileReal = await fs.realpath(resolved);
  } catch {
    return { ok: false, error: 'local file is not readable inside the agent workspace' };
  }

  if (isOutside(rootReal, fileReal)) return { ok: false, error: 'local file must stay inside the agent workspace' };
  return { ok: true, url: fileReal };
}
