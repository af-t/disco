const execute = async (client, message) => {
  const start = Date.now();
  const msg = await client.reply(message, 'Pinging...');
  const latency = Date.now() - start;
  const wsLatency = await client.latency();

  const embed = {
    title: '🏓 Pong!',
    fields: [
      { name: '🌐 API Latency', value: `\`${latency}ms\``, inline: true },
      { name: '🔌 WebSocket', value: `\`${wsLatency}ms\``, inline: true }
    ],
    color: latency < 200 ? 0x00ff00 : (latency < 500 ? 0xffff00 : 0xff0000),
    footer: { text: `Requested by ${message.author.username}` }
  };

  await client.editMessage(msg, '', { embeds: [embed], allowed_mentions: {} });
};

export default {
  execute,
  data: {
    name: 'ping',
    description: 'Check bot latency and websocket health',
    slash: true,
    aliases: ['p'],
    usage: 'ping'
  }
};