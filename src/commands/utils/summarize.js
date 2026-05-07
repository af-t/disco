import createAgent from 'openrouter';

const agent = await createAgent();

const execute = async (client, message, _, args) => {
  let limit = 50;
  if (args && args[0] && !isNaN(args[0])) {
    limit = parseInt(args[0]);
    if (limit > 100) limit = 100;
    if (limit < 10) limit = 10;
  }

  let typing = true;
  const sendTyping = async () => {
    while (typing) {
      await client.sendTyping(message.channel_id).catch(() => {});
      await new Promise(r => setTimeout(r, 5000));
    }
  };
  
  sendTyping();

  try {
    const messages = await client.getMessages(message.channel_id, { limit });

    if (!messages || messages.length === 0) {
      typing = false;
      return await client.reply(message, 'There are no messages to summarize.');
    }

    // Messages are fetched newest first, we need chronological order for AI
    const reversed = [...messages].reverse();

    const chatLog = reversed.map(m => `[${m.author.username}]: ${m.content}`).join('\n');

    const prompt = [
      { 
        type: 'text', 
        text: `Please provide a clear and concise summary of the following conversation. Highlight the key points discussed:\n\n${chatLog}` 
      }
    ];

    // Clear previous history if any, so the summary is isolated
    agent.messages = [];
    const response = await agent.run(prompt);
    let responseText = typeof response === 'string' ? response : '';

    if (responseText.length > 2000) {
        responseText = responseText.substring(0, 1997) + '...';
    }

    await client.reply(message, `**Summary of the last ${messages.length} messages:**\n\n${responseText}`);
  } catch (err) {
    console.error('Error summarizing messages:', err);
    await client.reply(message, 'Sorry, an error occurred while trying to summarize the messages.').catch(() => {});
  } finally {
    typing = false;
  }
};

export default {
  execute,
  data: {
    name: 'summarize',
    description: 'Summarizes the recent messages in this channel.',
    aliases: ['summary'],
    usage: 'summarize [count]',
    permissions: ['READ_MESSAGE_HISTORY'],
    slash: true,
    options: [
      {
        name: 'count',
        description: 'Number of messages to summarize (10-100)',
        type: 4, // INTEGER
        required: false,
        min_value: 10,
        max_value: 100
      }
    ]
  }
};
