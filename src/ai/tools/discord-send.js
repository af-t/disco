export const definition = {
  name: 'discord_send',
  description:
    'Send a new message to a Discord channel you have access to. Use for fresh statements not tied to a specific reply target.',
  parallelSafe: false,
  input_schema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'Target channel ID.' },
      content: { type: 'string', description: 'Message text (max 2000 chars).' },
    },
    required: ['channel_id', 'content'],
  },
};

export async function execute({ client, runtime }, { channel_id, content }) {
  try {
    const sent = await client.sendMessage(channel_id, content);
    runtime.onBotMessage(sent);
    return JSON.stringify({ ok: true, message_id: sent.id });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String(err?.message ?? err) });
  }
}
