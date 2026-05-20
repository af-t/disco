export function createDiscordReplyTool({ client, runtime }) {
  return {
    name: 'discord_reply',
    description:
      'Reply to a specific message in a Discord channel. Preferred in busy channels so the recipient is unambiguous.',
    parallelSafe: false,
    input_schema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Channel containing the message to reply to.' },
        message_id: { type: 'string', description: 'Message ID to reply to.' },
        content: { type: 'string', description: 'Reply text (max 2000 chars).' },
      },
      required: ['channel_id', 'message_id', 'content'],
    },
    execute: async ({ channel_id, message_id, content }) => {
      try {
        const sent = await client.reply({ channel_id, id: message_id }, content);
        runtime.onBotMessage(sent);
        return JSON.stringify({ ok: true, message_id: sent.id });
      } catch (err) {
        return JSON.stringify({ ok: false, error: String(err?.message ?? err) });
      }
    },
  };
}
