import permissionFlags from '../lib/permission.js';

function formatAgo(since) {
  const diff = Date.now() - since;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m ago`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s ago`;
  return `${seconds}s ago`;
}

const COMMAND_PREFIX = '.';
const REQUEST_LIMIT = 4;

const parseDM = async (client, message) => {
  const content = message?.content;
  const userId = message?.author?.id;
  const dm = client.tempDM.get(userId) || {contents: [], reading: false};

  dm.contents.push(content);
  client.tempDM.set(userId, dm);

  if (dm.reading) return {};

  dm.reading = true;
  return new Promise((resolve) => setTimeout(() => {
    client.tempDM.delete(userId); // delete first
    resolve({
      useAI: true,
      rawArgs: dm.contents.join('\n')
    });
  }, 7000));
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
      return {cmd, args, rawArgs}
    }
    return {};
  }

  if (args[0].startsWith(COMMAND_PREFIX)) {
    const cmd = args[0].slice(1).trim();
    args.shift();
    rawArgs = rawArgs.slice(1).trim().slice(cmd.length).trim();
    return {cmd, args, rawArgs};
  }

  if (rawArgs.match(me)) { // Automatically use AI if bot is mentioned
    return {useAI: true, rawArgs};
  }

  return {};
};

const getPermissions = async (client, guild_id, member) => {
  let perms = 0n;
  let guildRoles;
  for (const id of member.roles) {
    if (!guildRoles) guildRoles = await client.getRoles(guild_id);
    const role = guildRoles.find(r => r.id === id);
    if (role) perms |= BigInt(role.permissions);
  }
  return perms;
};

export default async(client, m) => {
  const isGuildMessage = !!m.guild_id;
  const isSelf = m.author.id === client._session.user.id;
  const isBot = !!m.author.bot;

  // ignore in several conditions
  if (isBot || isSelf) return;

  // Auto-moderation logic
  if (isGuildMessage) {
    // 1. Anti-link (ignore for admins/moderators)
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    if (urlRegex.test(m.content)) {
      const member = m.member || await client.getGuildMember(m.guild_id, m.author.id);
      const perms = await getPermissions(client, m.guild_id, member);
      const isMod = (perms & 8n) === 8n || (perms & 0x0000000000002000n) === 0x0000000000002000n; // Admin or Manage Messages

      if (!isMod) {
        await client.deleteMessage(m.channel_id, m.id);
        const warn = await client.sendMessage(m.channel_id, `🚫 **${m.author.username}**, posting links is not allowed here!`);
        setTimeout(() => client.deleteMessage(m.channel_id, warn.id).catch(() => {}), 5000);
        return;
      }
    }

    // 2. Anti-spam (repetitive content)
    const lastMsgKey = `last_msg:${m.author.id}:${m.channel_id}`;
    const lastMsg = await client.store.get(lastMsgKey);
    if (lastMsg === m.content && m.content.length > 5) {
      await client.deleteMessage(m.channel_id, m.id);
      return; // Silently delete repetitive spam
    }
    await client.store.set(lastMsgKey, m.content, true); // TTL will handle cleanup
  }

  // AFK detection
  if (isGuildMessage) {
    // Hook A: Clear own AFK on message
    const afkKey = `afk:${m.guild_id}:${m.author.id}`;
    const afkData = await client.store.get(afkKey);
    if (afkData) {
      await client.store.delete(afkKey);
      const ago = formatAgo(afkData.since);
      const reply = await client.sendMessage(m.channel_id, `👋 Welcome back **${m.author.global_name || m.author.username}**! You were AFK since ${ago}.`);
      setTimeout(() => client.deleteMessage(m.channel_id, reply.id).catch(() => {}), 5000);
    }

    // Hook B: Notify about AFK-mentioned users
    const mentions = [...m.content.matchAll(/<@!?(\d+)>/g)].map(m => m[1]);
    const afkMentions = [];
    for (const uid of [...new Set(mentions)]) {
      if (uid === m.author.id) continue;
      const mentionedAfk = await client.store.get(`afk:${m.guild_id}:${uid}`);
      if (mentionedAfk) {
        afkMentions.push({ id: uid, ...mentionedAfk });
      }
    }
    if (afkMentions.length) {
      const lines = afkMentions.map(a => `💤 <@${a.id}> is AFK: _${a.message}_ (${formatAgo(a.since)})`);
      const reply = await client.sendMessage(m.channel_id, lines.join('\n'));
      setTimeout(() => client.deleteMessage(m.channel_id, reply.id).catch(() => {}), 10000);
    }
  }

  const {
    useAI, cmd,
    args,
    rawArgs
  } = await (isGuildMessage ? parseMessage(client, m) : parseDM(client, m));

  if (cmd) {
    const cached = (await client.store.has(`request_limit:${m.author.id}`)) ?
      await client.store.get(`request_limit:${m.author.id}`) :
      {
        notified: false,
        time: Date.now(),
        count: 0
      };

    if (Date.now() - cached.time > 1000) {
      cached.time = Date.now();
      cached.count = 0;
      cached.notified = true;
    }
    if (++cached.count > REQUEST_LIMIT) {
      if (cached.notified) return;
      const reply = await client.sendMessage(m.channel_id, `**${m.author.global_name || m.author.username}**! Please slow down~ You're a little too fast.`);
      setTimeout(() => client.deleteMessage(m.channel_id, reply.id), 3000);
      cached.notified = true;
      return;
    }
    await client.store.set(`request_limit:${m.author.id}`, cached, true);

    let allow = true;

    if (client.commands[cmd]?.permissions) if (isGuildMessage) {
      const member = m.member || await client.getGuildMember(m.guild_id, m.author.id);
      const perms = await getPermissions(client, m.guild_id, member);

      const hasAdmin = (perms & 8n) === 8n;

      for (let perm of client.commands[cmd].permissions) {
        perm = permissionFlags[perm];
        if (perm) {
          allow = allow ? (perms & perm) === perm : false;
          allow = allow || hasAdmin;
        } else {
          client.logger.warn(`Unknown permission ${perm} from command:`, cmd);
        }
      }
    } else {
      allow = false;
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
};
