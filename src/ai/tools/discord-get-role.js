import permissionFlags from '../../lib/permission.js';

function namedPermissions(permsStr) {
  if (permsStr === undefined || permsStr === null) return [];
  let bits;
  try {
    bits = typeof permsStr === 'bigint' ? permsStr : BigInt(permsStr);
  } catch {
    return [];
  }
  const out = [];
  for (const [name, flag] of Object.entries(permissionFlags)) {
    if ((bits & flag) === flag) out.push(name);
  }
  return out;
}

export const definition = {
  name: 'discord_get_role',
  description: 'Fetch a specific role in a guild (name, color, permissions, mentionable).',
  input_schema: {
    type: 'object',
    properties: {
      guild_id: { type: 'string' },
      role_id: { type: 'string' },
    },
    required: ['guild_id', 'role_id'],
  },
};

export async function execute({ client }, { guild_id, role_id }) {
  try {
    const roles = await client.getRoles(guild_id);
    const role = roles.find((r) => r.id === role_id);
    if (!role) return JSON.stringify({ ok: false, error: 'Role not found' });
    return JSON.stringify({
      ok: true,
      role: {
        id: role.id,
        name: role.name,
        color: role.color,
        hoist: !!role.hoist,
        position: role.position,
        mentionable: !!role.mentionable,
        managed: !!role.managed,
        permissions: namedPermissions(role.permissions),
      },
    });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String(err?.message ?? err) });
  }
}
