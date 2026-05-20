const KEY = (guild_id) => `config:${guild_id}:ai_muted_channels`;

async function readList(client, guild_id) {
  const v = await client.store.get(KEY(guild_id));
  return Array.isArray(v) ? v : [];
}

async function writeList(client, guild_id, list) {
  await client.store.set(KEY(guild_id), list);
}

const execute = async (client, message, args) => {
  if (!message.guild_id) return client.reply(message, 'This command can only be used in a server.');

  const sub = (args[0] ?? '').toLowerCase();
  const list = await readList(client, message.guild_id);

  if (sub === 'on') {
    if (!list.includes(message.channel_id)) list.push(message.channel_id);
    await writeList(client, message.guild_id, list);
    return client.reply(message, `🔇 AI muted in this channel.`);
  }
  if (sub === 'off') {
    const next = list.filter((id) => id !== message.channel_id);
    await writeList(client, message.guild_id, next);
    return client.reply(message, `🔈 AI unmuted in this channel.`);
  }
  if (sub === 'status') {
    const muted = list.length ? list.map((id) => `<#${id}>`).join(', ') : '_none_';
    return client.reply(message, `Currently muted channels: ${muted}`);
  }

  return client.reply(message, 'Usage: `.ai-mute on|off|status`');
};

export default {
  execute,
  data: {
    name: 'ai-mute',
    description: 'Mute or unmute the natural-mode AI in the current channel.',
    slash: false,
    permissions: ['MANAGE_CHANNELS'],
    usage: 'ai-mute on|off|status',
  },
};
