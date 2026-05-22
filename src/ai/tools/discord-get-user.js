function sanitizeUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, global_name: u.global_name, bot: !!u.bot, avatar: u.avatar };
}

function sanitizeMember(m) {
  if (!m) return null;
  return { nick: m.nick, joined_at: m.joined_at, roles: m.roles ?? [] };
}

export const definition = {
  name: 'discord_get_user',
  description: 'Fetch a Discord user profile. Optionally include their roles in a specific guild.',
  parallelSafe: true,
  input_schema: {
    type: 'object',
    properties: {
      user_id: { type: 'string' },
      guild_id: { type: 'string', description: 'Optional. If provided, includes guild member info (nick, roles).' },
    },
    required: ['user_id'],
  },
};

export async function execute({ client }, { user_id, guild_id }) {
  try {
    const user = await client.getUser(user_id);
    const out = { ok: true, user: sanitizeUser(user) };
    if (guild_id) {
      try {
        const member = await client.getGuildMember(guild_id, user_id);
        out.member = sanitizeMember(member);
      } catch {
        out.member = null;
      }
    }
    return JSON.stringify(out);
  } catch (err) {
    return JSON.stringify({ ok: false, error: String(err?.message ?? err) });
  }
}
