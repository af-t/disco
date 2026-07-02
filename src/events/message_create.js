import permissionFlags from '../lib/permission.js';
import tools from '../lib/utility.js';
import { checkRateLimit, getMaxPerSec } from '../lib/event_utils.js';
import { moderateDisallowedLink } from '../lib/anti-link.js';

const { formatAgo, getPermissions, unrefTimeout } = tools;
const COMMAND_PREFIX = '.';

// Rate limit: commands per second per user
const RATE_LIMIT = {
  DEFAULT: 5, // Most commands (ping, help, info, etc.)
  MODERATE: 3, // Admin/mod commands (ban, kick, mute, purge)
  HEAVY: 2, // AI/resource-intensive commands (ai, summarize)
};

/** Set of heavy (AI) command aliases */
const HEAVY_COMMANDS = new Set(['ai', 'openrouter', 'chat', 'summarize', 'summary', 'recap']);

const parseDM = async (client, message) => {
  const content = message?.content;
  const userId = message?.author?.id;
  const dm = client.tempDM.get(userId) || { contents: [], reading: false };

  dm.contents.push(content);
  client.tempDM.set(userId, dm);

  if (dm.reading) return {};

  dm.reading = true;
  return new Promise((resolve) =>
    unrefTimeout(() => {
      client.tempDM.delete(userId); // delete first
      resolve({
        useAI: true,
        rawArgs: dm.contents.join('\n'),
      });
    }, 7000),
  );
};

const parseMessage = (client, message) => {
  let rawArgs = message.content.trim();
  let args = rawArgs.split(/ +/);
  const me = new RegExp(`<@!?${client._session.user.id}>`);

  if (args[0] === COMMAND_PREFIX) {
    const cmd = args[1];
    if (cmd) {
      args = args.slice(2);
      rawArgs = rawArgs.slice(1).trim().slice(cmd.length).trim();
      return { cmd, args, rawArgs };
    }
    return {};
  }

  if (args[0].startsWith(COMMAND_PREFIX)) {
    const cmd = args[0].slice(1).trim();
    args.shift();
    rawArgs = rawArgs.slice(1).trim().slice(cmd.length).trim();
    return { cmd, args, rawArgs };
  }

  if (rawArgs.match(me)) {
    // Automatically use AI if bot is mentioned
    return { useAI: true, rawArgs };
  }

  return {};
};

const parseDMCommand = (m) => {
  const raw = (m.content ?? '').trim();
  if (!raw.startsWith(COMMAND_PREFIX)) return {};
  const rest = raw.slice(COMMAND_PREFIX.length).trim();
  const args = rest.split(/ +/);
  const cmd = args.shift();
  if (!cmd) return {};
  const rawArgs = rest.slice(cmd.length).trim();
  return { cmd, args, rawArgs };
};

export default async (client, m) => {
  const isGuildMessage = !!m.guild_id;
  const isSelf = m.author.id === client._session.user.id;
  const isBot = !!m.author.bot;

  // ignore in several conditions
  if (isBot || isSelf) return;

  // Auto-moderation logic
  if (isGuildMessage) {
    // 1. Anti-link (ignore for admins/moderators)
    if (await moderateDisallowedLink(client, m)) return;

    // 2. Anti-spam (repetitive content) - with normalization (fixes M2)
    const normalizeContent = (str) => str?.trim().toLowerCase().replace(/\s+/g, ' ') ?? '';
    const normalizedContent = normalizeContent(m.content);
    const lastMsgKey = `last_msg:${m.author.id}:${m.channel_id}`;
    const lastMsg = await client.store.get(lastMsgKey);
    if (lastMsg === normalizedContent && normalizedContent.length > 5) {
      await client.deleteMessage(m.channel_id, m.id);
      return; // Silently delete repetitive spam
    }
    await client.store.set(lastMsgKey, normalizedContent, true); // TTL will handle cleanup
  }

  // AFK detection
  if (isGuildMessage) {
    // Hook A: Clear own AFK on message
    const afkKey = `afk:${m.guild_id}:${m.author.id}`;
    const afkData = await client.store.get(afkKey);
    if (afkData) {
      await client.store.delete(afkKey);
      const ago = formatAgo(afkData.since);
      const reply = await client.sendMessage(
        m.channel_id,
        `👋 Welcome back **${m.author.global_name || m.author.username}**! You were AFK since ${ago}.`,
      );
      unrefTimeout(
        () =>
          client
            .deleteMessage(m.channel_id, reply.id)
            .catch((err) => client.logger?.warn?.('Failed to delete AFK welcome:', err)),
        5000,
      );
    }

    // Hook B: Notify about AFK-mentioned users
    const mentions = [...(m.content?.matchAll(/<@!?(\d+)>/g) ?? [])].map((match) => match[1]);
    const afkMentions = [];
    for (const uid of [...new Set(mentions)]) {
      if (uid === m.author.id) continue;
      const mentionedAfk = await client.store.get(`afk:${m.guild_id}:${uid}`);
      if (mentionedAfk) {
        afkMentions.push({ id: uid, ...mentionedAfk });
      }
    }
    if (afkMentions.length) {
      const lines = afkMentions.map((a) => `💤 <@${a.id}> is AFK: _${a.message}_ (${formatAgo(a.since)})`);
      const reply = await client.sendMessage(m.channel_id, lines.join('\n'));
      unrefTimeout(
        () =>
          client
            .deleteMessage(m.channel_id, reply.id)
            .catch((err) => client.logger?.warn?.('Failed to delete AFK mention notice:', err)),
        10000,
      );
    }
  }

  const naturalMode = !!client.aiRuntime;

  const parsed = isGuildMessage
    ? parseMessage(client, m)
    : naturalMode
      ? { useAI: false, ...parseDMCommand(m) }
      : await parseDM(client, m);
  const { useAI, cmd, args, rawArgs } = parsed;

  if (cmd) {
    const cached = (await client.store.has(`request_limit:${m.author.id}`))
      ? await client.store.get(`request_limit:${m.author.id}`)
      : {
          notified: false,
          time: Date.now(),
          count: 0,
        };

    // Determine rate limit based on command type
    const cmdLower = cmd.toLowerCase();
    const maxPerSec = getMaxPerSec(
      cmdLower,
      HEAVY_COMMANDS,
      RATE_LIMIT,
      client.commands[cmdLower]?.permissions?.length,
    );

    if (checkRateLimit(cached, maxPerSec)) {
      if (cached.notified) return;
      cached.notified = true;
      await client.store.set(`request_limit:${m.author.id}`, cached, true);
      const reply = await client.sendMessage(
        m.channel_id,
        `**${m.author.global_name || m.author.username}**! Please slow down~ You're a little too fast.`,
      );
      unrefTimeout(() => client.deleteMessage(m.channel_id, reply.id), 3000);
      return;
    }
    await client.store.set(`request_limit:${m.author.id}`, cached, true);

    let allow = true;

    if (client.commands[cmdLower]?.permissions?.length) {
      if (isGuildMessage) {
        const member = m.member || (await client.getGuildMember(m.guild_id, m.author.id));
        if (!member?.roles) {
          allow = false;
        } else {
          const perms = await getPermissions(client, m.guild_id, member);
          const hasAdmin = (perms & permissionFlags.ADMINISTRATOR) === permissionFlags.ADMINISTRATOR;

          // Admin bypass: if user has ADMINISTRATOR, allow all commands
          if (hasAdmin) {
            allow = true;
          } else {
            // Use Array.every() for clean permission checking (fixes C2)
            allow = client.commands[cmdLower].permissions.every((permName) => {
              const flag = permissionFlags[permName];
              if (!flag) {
                client.logger.warn(`Unknown permission "${permName}" from command:`, cmd);
                return false;
              }
              return (perms & flag) === flag;
            });
          }
        }
      } else {
        allow = false;
      }
    }

    if (allow) {
      const lcmd = cmd.toLowerCase();
      if (lcmd in client.commands) {
        await client.commands[lcmd]?.(client, m, args, rawArgs);
        return;
      } else {
        await client.commands.ai?.(client, m, args, m.content.slice(1));
        return;
      }
    } else {
      await client.reply(m, 'Please check the permission to use this command.');
      return;
    }
  }

  if (useAI) {
    await client.commands.ai?.(client, m, args, rawArgs);
    return;
  }

  if (naturalMode && !cmd) {
    await client.aiRuntime.onMessage(m).catch((err) => client.logger?.error?.('runtime.onMessage failed', err));
    return;
  }
};
