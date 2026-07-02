import permissionFlags from './permission.js';

const ADMIN = permissionFlags.ADMINISTRATOR;

// Highest role position among a set of role ids.
export function highestRolePosition(roles, roleIds) {
  if (!Array.isArray(roles) || !Array.isArray(roleIds)) return -1;
  let max = -1;
  for (const id of roleIds) {
    const role = roles.find((r) => r.id === id);
    if (role && typeof role.position === 'number' && role.position > max) max = role.position;
  }
  return max;
}

export async function getMemberHighestPosition(client, guildId, userId, options = {}) {
  const [member, roles] = await Promise.all([
    client.getGuildMember(guildId, userId, options),
    client.getRoles(guildId, options),
  ]);
  return highestRolePosition(roles, member?.roles ?? []);
}

// True if the everyone role or any of roleIds carries ADMINISTRATOR.
function hasAdminPermission(roles, guildId, roleIds) {
  for (const id of [guildId, ...(roleIds ?? [])]) {
    const role = roles.find((r) => r.id === id);
    if (role && (BigInt(role.permissions) & ADMIN) === ADMIN) return true;
  }
  return false;
}

// Reject moderation across/upward the role hierarchy, mirroring what Discord
// itself would enforce for the invoking human (the bot's token bypasses that).
export async function assertCanModerateMember(client, guildId, actorId, targetId, options = {}) {
  if (actorId === targetId) return { ok: true };

  const [guild, actorMember, roles] = await Promise.all([
    client.getGuild(guildId, options).catch(() => null),
    client.getGuildMember(guildId, actorId, options),
    client.getRoles(guildId, options),
  ]);

  if (guild?.owner_id === actorId) return { ok: true };
  if (hasAdminPermission(roles, guildId, actorMember?.roles)) return { ok: true };

  // No member record means Discord will reject or allow this on its own terms.
  const targetMember = await client.getGuildMember(guildId, targetId, options).catch(() => null);
  if (!targetMember) return { ok: true };

  const actorPosition = highestRolePosition(roles, actorMember?.roles ?? []);
  const targetPosition = highestRolePosition(roles, targetMember?.roles ?? []);
  if (targetPosition >= actorPosition) {
    return { ok: false, error: 'target is at or above your role hierarchy position' };
  }
  return { ok: true };
}
