export const data = {
  name: 'config',
  description: 'Manage bot configuration (Admin only)',
  permissions: ['ADMINISTRATOR', 'MANAGE_GUILD'],
  options: [
    {
      name: 'set',
      description: 'Set a configuration value',
      type: 1, // SUB_COMMAND
      options: [
        {
          name: 'key',
          description: 'Configuration key',
          type: 3,
          required: true,
          choices: [
            { name: 'Welcome Channel', value: 'welcome_channel_id' },
            { name: 'Rules Channel', value: 'rules_channel_id' },
            { name: 'Rules Role', value: 'rules_role_id' },
            { name: 'Gender Male Role', value: 'role:gender:male' },
            { name: 'Gender Female Role', value: 'role:gender:female' },
            { name: 'Color Red Role', value: 'role:color:red' },
            { name: 'Color Blue Role', value: 'role:color:blue' }
          ]
        },
        {
          name: 'value',
          description: 'ID (Role ID or Channel ID)',
          type: 3,
          required: true
        }
      ]
    },
    {
      name: 'list',
      description: 'List current configuration',
      type: 1
    }
  ]
};

export const execute = async (client, message, args) => {
  // Simple permission check (requires MANAGE_GUILD or ADMINISTRATOR)
  // Converting to BigInt in case it's a string from interactions
  const perms = BigInt(message.member?.permissions || 0n);
  const isAdmin = (perms & (1n << 3n)) || (perms & (1n << 5n));
  if (!isAdmin) return message.reply("You do not have permission to use this command.");

  const subcommand = args[0];
  if (subcommand === 'set') {
    const key = args[1];
    const value = args[2];
    await client._store.set(`config:${key}`, value);
    return message.reply(`Configuration updated: \`${key}\` set to \`${value}\``);
  }

  if (subcommand === 'list') {
    const configKeys = [];
    const metadata = client._store?._metadata;
    
    if (metadata) {
      for (const key of metadata.keys()) {
        if (key.startsWith('config:')) {
          const value = await client._store.get(key);
          configKeys.push(`**${key.replace('config:', '')}**: \`${value}\``);
        }
      }
    }

    if (configKeys.length === 0) {
      return message.reply("No configuration values found. Use `/config set` to add some.");
    }

    const embed = {
      title: "Disco Bot Configuration",
      description: configKeys.join('\n'),
      color: 0x3498db,
      timestamp: new Date().toISOString()
    };

    return message.reply({ embeds: [embed] });
  }
};

export default { data, execute };
