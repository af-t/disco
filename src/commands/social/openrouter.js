import { getRuntime } from '../../ai/index.js';
import { setTimeout as wait } from 'node:timers/promises';

const sendTyping = async (client, message, notify) => {
  while (notify?.()) {
    await client.sendTyping(message.channel_id).catch((err) => client.logger?.warn?.('Typing indicator failed:', err));
    await wait(5000);
  }
};

const execute = async (client, message, _, args) => {
  const rawArgs = (args ?? '').trim();
  if (!rawArgs) return;
  const rt = getRuntime();

  if (!rt) {
    return client.reply(
      message,
      'AI is not currently enabled on this bot (`AI_NATURAL_MODE=0`). Ask the operator to enable it.',
    );
  }

  let typing = true;
  sendTyping(client, message, () => typing);

  try {
    await rt.invoke({
      mode: 'command',
      contextKey: `cmd:${message.guild_id ?? 'dm'}:${message.author.id}`,
      forceRespond: true,
      msg: message,
      explicitPrompt: rawArgs,
    });
  } catch (err) {
    client.logger?.error?.('openrouter command error', err);
    await client.reply(message, 'Sorry, something went wrong.').catch(() => {});
  } finally {
    typing = false;
  }
};

export default {
  execute,
  data: {
    name: 'openrouter',
    description: 'Chat with the bot directly (forces a response, per-user context).',
    aliases: ['ai', 'chat'],
    usage: 'openrouter {prompt}',
    slash: false,
  },
};
