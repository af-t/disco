export const definition = {
  name: 'discord_get_thread',
  description:
    'Fetch metadata about a Discord thread (treated as a channel by the API): name, parent, archive/lock state, message count.',
  parallelSafe: true,
  input_schema: {
    type: 'object',
    properties: { thread_id: { type: 'string' } },
    required: ['thread_id'],
  },
};

export async function execute({ client }, { thread_id }) {
  try {
    const ch = await client.getChannel(thread_id);
    return JSON.stringify({
      ok: true,
      thread: {
        id: ch.id,
        name: ch.name,
        type: ch.type,
        parent_id: ch.parent_id ?? null,
        owner_id: ch.owner_id ?? null,
        message_count: ch.message_count ?? null,
        member_count: ch.member_count ?? null,
        archived: !!ch.thread_metadata?.archived,
        locked: !!ch.thread_metadata?.locked,
        auto_archive_duration: ch.thread_metadata?.auto_archive_duration ?? null,
      },
    });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String(err?.message ?? err) });
  }
}
