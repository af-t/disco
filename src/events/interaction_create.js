export default async (client, interaction) => {
  // Autocomplete handling (type 4)
  if (interaction.type === 4) {
    const { name, options } = interaction.data;
    const focused = options.find(opt => opt.focused);

    if (name === 'help' && focused && focused.name === 'command') {
      const query = focused.value.toLowerCase();
      const choices = Object.keys(client.commands)
        .filter(key => {
          const cmd = client.commands[key];
          // Only suggest main command names (not aliases) that have descriptions
          return cmd.data && cmd.data.name === key && cmd.data.description && key.includes(query);
        })
        .slice(0, 25) // Discord limit
        .map(key => ({ name: key, value: key }));

      return client.createInteractionResponse(interaction.id, interaction.token, {
        type: 8, // APPLICATION_COMMAND_AUTOCOMPLETE_RESULT
        data: { choices }
      });
    }
    return;
  }

  // APPLICATION_COMMAND handling (type 2)
  if (interaction.type !== 2) return;

  const { name, options } = interaction.data;
  const cmd = client.commands[name.toLowerCase()];

  if (!cmd) return;

  // Compatibility Shim: Mock Message Object
  const mockMessage = {
    id: interaction.id,
    channel_id: interaction.channel_id,
    guild_id: interaction.guild_id,
    author: interaction.member?.user || interaction.user,
    member: interaction.member,
    content: `/${name}`,
    isInteraction: true,
    interactionToken: interaction.token,
    interactionId: interaction.id
  };

  // Shim reply method to use interaction responses with ephemeral flag (64)
  mockMessage.reply = async (content, options = {}) => {
    const payload = typeof content === 'string' ? { content } : content;
    return client.createInteractionResponse(interaction.id, interaction.token, {
      type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
      data: {
        ...payload,
        ...options,
        flags: 64 // EPHEMERAL: Only visible to the user
      }
    });
  };

  // Helper to parse interaction options into args array
  const parseOptions = (opts) => {
    const args = [];
    for (const opt of opts) {
      if (opt.type === 1 || opt.type === 2) { // SUB_COMMAND or SUB_COMMAND_GROUP
        args.push(opt.name);
        if (opt.options) args.push(...parseOptions(opt.options));
      } else {
        args.push(String(opt.value));
      }
    }
    return args;
  };

  const args = options ? parseOptions(options) : [];
  const rawArgs = args.join(' ');

  try {
    await cmd(client, mockMessage, args, rawArgs);
  } catch (error) {
    client.logger.error(`Error executing slash command ${name}:`, error);
  }
};
