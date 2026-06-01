import { authorize } from './authorize.js';

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

export async function execute(ctx, input) {
  const auth = await authorize(ctx, input, 'MANAGE_ROLES');
  if (!auth.ok) return JSON.stringify(auth);
  try {
    switch (input.action) {
      case 'create': {
        const created = await ctx.client.createRole(auth.guildId, input.options ?? {});
        return JSON.stringify({ ok: true, role_id: created?.id ?? null });
      }
      case 'edit':
        if (!input.role_id) return JSON.stringify({ ok: false, error: 'role_id required for edit' });
        await ctx.client.editRole(auth.guildId, input.role_id, input.options ?? {});
        return JSON.stringify({ ok: true });
      case 'delete':
        if (!input.role_id) return JSON.stringify({ ok: false, error: 'role_id required for delete' });
        await ctx.client.deleteRole(auth.guildId, input.role_id);
        return JSON.stringify({ ok: true });
      case 'assign':
        if (!input.role_id || !input.user_id)
          return JSON.stringify({ ok: false, error: 'role_id and user_id required for assign' });
        await ctx.client.addMemberRole(auth.guildId, input.user_id, input.role_id);
        return JSON.stringify({ ok: true });
      case 'unassign':
        if (!input.role_id || !input.user_id)
          return JSON.stringify({ ok: false, error: 'role_id and user_id required for unassign' });
        await ctx.client.removeMemberRole(auth.guildId, input.user_id, input.role_id);
        return JSON.stringify({ ok: true });
      default:
        return JSON.stringify({ ok: false, error: `unknown action ${input.action}` });
    }
  } catch (err) {
    return JSON.stringify({ ok: false, error: String(err?.message ?? err) });
  }
}
