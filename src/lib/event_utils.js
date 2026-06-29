import tools from './utility.js';
const { getAvatarUrl } = tools;

export async function sendMemberStatusMessage(client, member, configKey, title, description, color, errorMsg) {
  const guildId = member.guild_id;
  const channelId = await client.store.get(`config:${guildId}:${configKey}`);
  if (!channelId) return;

  const user = member.user;
  const embed = {
    title,
    description,
    thumbnail: { url: getAvatarUrl(user) },
    color,
    timestamp: new Date().toISOString(),
    footer: { text: `User ID: ${user.id}` },
  };

  try {
    await client.sendMessage(channelId, '', { embeds: [embed] });
  } catch (error) {
    client.logger.error(`${errorMsg} ${channelId}:`, error);
  }
}

export function checkRateLimit(cached, maxPerSec) {
  if (Date.now() - cached.time > 1000) {
    cached.time = Date.now();
    cached.count = 0;
    cached.notified = false;
  }
  return ++cached.count > maxPerSec;
}

export function getMaxPerSec(cmdLower, HEAVY_COMMANDS, RATE_LIMIT, permissionsLength) {
  return HEAVY_COMMANDS.has(cmdLower) ? RATE_LIMIT.HEAVY : permissionsLength ? RATE_LIMIT.MODERATE : RATE_LIMIT.DEFAULT;
}
