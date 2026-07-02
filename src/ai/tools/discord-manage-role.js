import { withToolErrorHandling } from './error.js';
import { authorize } from './authorize.js';
import { highestRolePosition } from '../../lib/role-hierarchy.js';

export const definition = {
  name: 'discord_manage_role',
  description:
    'Create, edit, or delete a role, or assign/unassign a role to a member. Admin action requiring MANAGE_ROLES; pass the admin instruction as authorizing_message_id.',
  input_schema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string' },
      action: { type: 'string', enum: ['create', 'edit', 'delete', 'assign', 'unassign'] },
      role_id: { type: 'string', description: 'For edit/delete/assign/unassign.' },
      user_id: { type: 'string', description: 'For assign/unassign.' },
      options: {
        type: 'object',
        description: 'For create/edit: Discord role fields (name, color, permissions, hoist, ...).',
      },
      authorizing_message_id: { type: 'string' },
    },
    required: ['channel_id', 'action', 'authorizing_message_id'],
  },
};

// Never let a role manager grant bits they don't hold themselves.
function permissionsError(requestedPermissions, auth) {
  if (requestedPermissions === undefined || requestedPermissions === null) return null;
  if (auth.isAdmin) return null;
  let requested;
  try {
    requested = typeof requestedPermissions === 'bigint' ? requestedPermissions : BigInt(requestedPermissions);
  } catch {
    return 'invalid permissions value';
  }
  const held = BigInt(auth.permissions);
  if ((requested & held) !== requested) {
    return 'cannot grant role permissions beyond what the authorizer holds';
  }
  return null;
}

async function loadActorPosition(ctx, auth) {
  const [member, roles] = await Promise.all([
    ctx.client.getGuildMember(auth.guildId, auth.authorizedBy),
    ctx.client.getRoles(auth.guildId),
  ]);
  return { roles, actorPosition: highestRolePosition(roles, member?.roles ?? []) };
}

// Reject touching a role the authorizer couldn't outrank themselves.
async function hierarchyError(ctx, auth, roleId) {
  if (auth.isAdmin) return null;
  const { roles, actorPosition } = await loadActorPosition(ctx, auth);
  const targetRole = roles.find((r) => r.id === roleId);
  if (!targetRole) return null;
  if (targetRole.position >= actorPosition) {
    return 'target role is at or above your role hierarchy position';
  }
  return null;
}

export async function execute(ctx, input) {
  const auth = await authorize(ctx, input, 'MANAGE_ROLES');
  if (!auth.ok) return JSON.stringify(auth);
  return withToolErrorHandling(async () => {
    switch (input.action) {
      case 'create': {
        const permError = permissionsError(input.options?.permissions, auth);
        if (permError) return JSON.stringify({ ok: false, error: permError });
        const created = await ctx.client.createRole(auth.guildId, input.options ?? {});
        return JSON.stringify({ ok: true, role_id: created?.id ?? null });
      }
      case 'edit': {
        if (!input.role_id) return JSON.stringify({ ok: false, error: 'role_id required for edit' });
        const permError = permissionsError(input.options?.permissions, auth);
        if (permError) return JSON.stringify({ ok: false, error: permError });
        const hierarchyErr = await hierarchyError(ctx, auth, input.role_id);
        if (hierarchyErr) return JSON.stringify({ ok: false, error: hierarchyErr });
        await ctx.client.editRole(auth.guildId, input.role_id, input.options ?? {});
        return JSON.stringify({ ok: true });
      }
      case 'delete': {
        if (!input.role_id) return JSON.stringify({ ok: false, error: 'role_id required for delete' });
        const hierarchyErr = await hierarchyError(ctx, auth, input.role_id);
        if (hierarchyErr) return JSON.stringify({ ok: false, error: hierarchyErr });
        await ctx.client.deleteRole(auth.guildId, input.role_id);
        return JSON.stringify({ ok: true });
      }
      case 'assign': {
        if (!input.role_id || !input.user_id)
          return JSON.stringify({ ok: false, error: 'role_id and user_id required for assign' });
        const hierarchyErr = await hierarchyError(ctx, auth, input.role_id);
        if (hierarchyErr) return JSON.stringify({ ok: false, error: hierarchyErr });
        await ctx.client.addMemberRole(auth.guildId, input.user_id, input.role_id);
        return JSON.stringify({ ok: true });
      }
      case 'unassign': {
        if (!input.role_id || !input.user_id)
          return JSON.stringify({ ok: false, error: 'role_id and user_id required for unassign' });
        const hierarchyErr = await hierarchyError(ctx, auth, input.role_id);
        if (hierarchyErr) return JSON.stringify({ ok: false, error: hierarchyErr });
        await ctx.client.removeMemberRole(auth.guildId, input.user_id, input.role_id);
        return JSON.stringify({ ok: true });
      }
      default:
        return JSON.stringify({ ok: false, error: `unknown action ${input.action}` });
    }
  });
}
