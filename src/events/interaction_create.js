import permissionFlags from '../lib/permission.js';
import tools from '../lib/utility.js';

const { getPermissions } = tools;

// Rate limit: commands per second per user (shared with message_create.js)
const RATE_LIMIT = {
  DEFAULT: 5,
  MODERATE: 3,
  HEAVY: 2,
};

const HEAVY_COMMANDS = new Set(['ai', 'openrouter', 'chat', 'summarize', 'summary', 'recap']);

export default async (client, interaction) => {
  // Autocomplete handling (type 4)
  if (interaction.type === 4) {
    if (!client.commands) return;
    const { name, options } = interaction.data;
    const findFocused = (opts) => {
      if (!opts) return;
      for (const opt of opts) {
        if (opt.focused) return opt;
        if (opt.options) {
          const f = findFocused(opt.options);
          if (f) return f;
        }
      }
    };
    const focused = findFocused(options);

    const cmd = client.commands[name.toLowerCase()];
    if (cmd && typeof cmd.autocomplete === 'function') {
      return cmd.autocomplete(client, interaction, focused);
    } else if (name === 'help' && focused && focused.name === 'command') {
      const query = focused.value.toLowerCase();
      const choices = Object.keys(client.commands)
        .filter((key) => {
          const c = client.commands[key];
          return c.data && c.data.name === key && c.data.description && key.includes(query);
        })
        .slice(0, 25)
        .map((key) => ({ name: key, value: key }));

      return client.createInteractionResponse(interaction.id, interaction.token, {
        type: 8,
        data: { choices },
      });
    }
    return;
  }

  // silently ignore unhandled component/modal interactions
  if (interaction.type === 3 || interaction.type === 5) return;

  // APPLICATION_COMMAND handling (type 2)
  if (interaction.type !== 2) return;

  if (!client.commands) return;

  const { name, options } = interaction.data;
  const cmd = client.commands[name.toLowerCase()];

  if (!cmd) return;

  // Permission check for slash commands (fixes C1)
  if (cmd.permissions && cmd.permissions.length > 0 && interaction.guild_id) {
    const member =
      interaction.member ||
      (await client.getGuildMember(interaction.guild_id, interaction.member?.user?.id || interaction.user?.id));
    if (!member) {
      return client.createInteractionResponse(interaction.id, interaction.token, {
        type: 4,
        data: { content: 'Unable to verify your permissions.', flags: 64 },
      });
    }
    const perms = await getPermissions(client, interaction.guild_id, member);
    const hasAdmin = (perms & permissionFlags.ADMINISTRATOR) === permissionFlags.ADMINISTRATOR;

    const allowed = cmd.permissions.every((permName) => {
      const flag = permissionFlags[permName];
      if (!flag) {
        client.logger.warn(`Unknown permission "${permName}" in slash command:`, name);
        return false;
      }
      return (perms & flag) === flag;
    });

    if (!allowed && !hasAdmin) {
      return client.createInteractionResponse(interaction.id, interaction.token, {
        type: 4,
        data: { content: 'You do not have permission to use this command.', flags: 64 },
      });
    }
  }

  // Rate limiting for slash commands (fixes M4)
  const rateLimitKey = `request_limit:${interaction.member?.user?.id || interaction.user?.id}`;
  const cached = (await client.store.has(rateLimitKey))
    ? await client.store.get(rateLimitKey)
    : { notified: false, time: Date.now(), count: 0 };

  const cmdLower = name.toLowerCase();
  const maxPerSec = HEAVY_COMMANDS.has(cmdLower)
    ? RATE_LIMIT.HEAVY
    : cmd.permissions?.length
      ? RATE_LIMIT.MODERATE
      : RATE_LIMIT.DEFAULT;

  if (Date.now() - cached.time > 1000) {
    cached.time = Date.now();
    cached.count = 0;
    cached.notified = false;
  }
  if (++cached.count > maxPerSec) {
    if (!cached.notified) {
      cached.notified = true;
      await client.store.set(rateLimitKey, cached, true);
      return client.createInteractionResponse(interaction.id, interaction.token, {
        type: 4,
        data: { content: "Please slow down~ You're a little too fast.", flags: 64 },
      });
    }
    return;
  }
  await client.store.set(rateLimitKey, cached, true);

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
    interactionId: interaction.id,
  };

  // reply shim handles immediate and deferred paths
  let deferred = false;
  mockMessage.reply = async (content, options = {}) => {
    const payload = typeof content === 'string' ? { content } : content;
    const method = deferred
      ? () =>
          client.editOriginalInteractionResponse(client._session.application.id, interaction.token, {
            ...payload,
            ...options,
          })
      : () =>
          client.createInteractionResponse(interaction.id, interaction.token, {
            type: 4,
            data: { ...payload, ...options, flags: options.flags ?? 64 },
          });

    if (deferred) {
      return method();
    }
    return method();
  };

  // Support deferred responses for slow commands (fixes M5)
  mockMessage.defer = async (ephemeral = true) => {
    deferred = true;
    return client.createInteractionResponse(interaction.id, interaction.token, {
      type: 5, // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
      data: ephemeral ? { flags: 64 } : undefined,
    });
  };

  // Helper to parse interaction options into args array
  const parseOptions = (opts) => {
    const args = [];
    for (const opt of opts) {
      if (opt.type === 1 || opt.type === 2) {
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
    if (deferred) {
      try {
        await client.editOriginalInteractionResponse(client._session.application.id, interaction.token, {
          content: '❌ An unexpected error occurred while executing this command.',
        });
      } catch {
        // interaction may have expired
      }
    } else {
      try {
        await client.createInteractionResponse(interaction.id, interaction.token, {
          type: 4,
          data: { content: '❌ An unexpected error occurred while executing this command.', flags: 64 },
        });
      } catch {
        // ignore
      }
    }
  }
};
