const execute = async (client, message, args) => {
  const commands = client.commands;
  const prefix = '.';

  if (args[0]) {
    const cmdName = args[0].toLowerCase();
    const command = commands[cmdName];

    if (!command) {
      return client.reply(message, `Command \`${cmdName}\` not found.`);
    }

    const embed = {
      title: `Command: ${command.name}`,
      description:
        `**Usage:** \`${prefix}${command.usage || command.name}\`\n` +
        `**Aliases:** ${command.aliases?.join(', ') || 'None'}\n` +
        `**Permissions:** ${command.permissions?.join(', ') || 'None'}`,
      color: 0x00ae86,
    };

    return client.reply(message, null, false, { embeds: [embed] });
  }

  // General help
  const commandNames = Object.keys(commands).filter((name) => commands[name].data.name === name);
  const commandList = commandNames.map((name) => `\`${name}\``).join(', ');

  const embed = {
    title: 'Disco Bot Commands',
    description: `Here is a list of available commands:\n\n${commandList}\n\nUse \`${prefix}help {command}\` for more info on a specific command.`,
    color: 0x00ae86,
    footer: { text: `Total Commands: ${commandNames.length}` },
  };

  return client.reply(message, null, false, { embeds: [embed] });
};

export default {
  execute,
  data: {
    name: 'help',
    description: 'Show the list of available commands.',
    slash: true,
    aliases: ['h'],
    usage: 'help [command]',
    options: [
      {
        name: 'command',
        description: 'The command to get help for',
        type: 3, // STRING type
        required: false,
        autocomplete: true,
      },
    ],
  },
};
