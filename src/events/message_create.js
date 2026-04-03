import permissionFlags from '../lib/permission.js';

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

export default async(client, m) => {
  const isGuildMessage = !!m.guild_id;
  const isSelf = m.author.id === client._session.user.id;
  const isBot = !!m.author.bot;

  // ignore in several conditions
  if (isBot || isSelf) return;

  const {
    useAI, cmd,
    args,
    rawArgs
  } = await (isGuildMessage ? parseMessage(client, m) : parseDM(client, m));

  if (cmd) {
    const cached = client.store.has(`request_limit:${m.author.id}`) ?
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
      let perms = 0n; //BigInt(0)
      let guildRoles;
      for (const id of member.roles) {
        if (!guildRoles) guildRoles = await client.getRoles(m.guild_id);
        const role = guildRoles.find(r => r.id === id);
        if (role) perms |= BigInt(role.permissions);
      }

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
