import { authorize } from './authorize.js';

const DISCORD_EPOCH = 1420070400000n;
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

// Discord refuses to bulk-delete messages older than 2 weeks.
function ageMs(id) {
  try {
    return Date.now() - Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
  } catch {
    return null;
  }
}

export const definition = {
  name: 'discord_bulk_delete',
  description:
    'Bulk-delete 2 to 100 recent messages (younger than 14 days) in this channel. Moderation action requiring MANAGE_MESSAGES; pass the admin instruction as authorizing_message_id.',
  input_schema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string' },
      message_ids: { type: 'array', items: { type: 'string' }, description: '2 to 100 message ids to delete.' },
      authorizing_message_id: { type: 'string' },
    },
    required: ['channel_id', 'message_ids', 'authorizing_message_id'],
  },
};

export async function execute(ctx, input) {
  const auth = await authorize(ctx, input, 'MANAGE_MESSAGES');
  if (!auth.ok) return JSON.stringify(auth);

  const ids = Array.isArray(input.message_ids) ? [...new Set(input.message_ids)] : [];
  if (ids.length === 0) {
    return JSON.stringify({ ok: false, error: 'message_ids must be a non-empty array' });
  }

  let skippedExpired = 0;
  const fresh = ids.filter((id) => {
    const age = ageMs(id);
    if (age != null && age >= FOURTEEN_DAYS_MS) {
      skippedExpired++;
      return false;
    }
    return true;
  });

  if (fresh.length === 0) {
    return JSON.stringify({
      ok: false,
      error: 'all messages are older than 14 days and cannot be bulk deleted',
      skipped_expired: skippedExpired,
    });
  }

  try {
    if (fresh.length === 1) {
      // Bulk delete requires 2-100 ids; fall back to a single delete.
      await ctx.client.deleteMessage(input.channel_id, fresh[0]);
    } else {
      await ctx.client.bulkDeleteMessages(input.channel_id, fresh);
    }
    return JSON.stringify({ ok: true, deleted: fresh.length, skipped_expired: skippedExpired });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String(err?.message ?? err) });
  }
}
