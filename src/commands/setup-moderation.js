export const data = {
  name: 'setup-moderation',
  description: 'Setup moderation messages (Rules/Roles)',
  options: [
    {
      name: 'rules',
      description: 'Send rules message with accept button',
      type: 1
    },
    {
      name: 'roles',
      description: 'Send role selection message with buttons',
      type: 1
    }
  ]
};

export const execute = async (client, message, args) => {
  const perms = BigInt(message.member?.permissions || 0n);
  const isAdmin = (perms & (1n << 3n)) || (perms & (1n << 5n));
  if (!isAdmin) return message.reply("You do not have permission to use this command.");

  const subcommand = args[0];

  if (subcommand === 'rules') {
    const embed = {
      title: "Server Rules",
      description: "1. Be respectful\n2. No spam\n3. Follow Discord ToS\n\nClick the button below to accept the rules and gain access to the server.",
      color: 0x3498db
    };
    const components = [{
      type: 1, // ACTION_ROW
      components: [{
        type: 2, // BUTTON
        style: 3, // SUCCESS (Green)
        label: "Accept Rules",
        custom_id: "mod_accept_rules"
      }]
    }];
    return message.reply({ embeds: [embed], components });
  }

  if (subcommand === 'roles') {
    const embed = {
      title: "Role Selection",
      description: "Select your gender and favorite color below!",
      color: 0x9b59b6
    };
    const components = [
      {
        type: 1, // ACTION_ROW
        components: [
          { type: 2, style: 1, label: "Male", custom_id: "mod_role_gender_male" },
          { type: 2, style: 1, label: "Female", custom_id: "mod_role_gender_female" }
        ]
      },
      {
        type: 1, // ACTION_ROW
        components: [
          { type: 2, style: 2, label: "Red", custom_id: "mod_role_color_red" },
          { type: 2, style: 2, label: "Blue", custom_id: "mod_role_color_blue" }
        ]
      }
    ];
    return message.reply({ embeds: [embed], components });
  }
};

export default { data, execute };
