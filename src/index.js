import Discord from './lib/discord.js';
import tools from './lib/utility.js';
//import webhook from './lib/client/webhook.js';
import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import permissionFlags from './lib/permission.js';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';


dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename); // import.meta.dirname alternative

const DATABASE_PATH = join(__dirname, '..', 'database');
const COMMANDS_PATH = join(__dirname, '..', 'src', 'commands');
const COMMAND_PREFIX = '.';

const client = new Discord(process.env.DISCORD_TOKEN);

client.commands = await tools.importCommands(COMMANDS_PATH);
client.tempDM = new Map();

const parseDM = async (message) => {
  const content = message?.content;
  const userId = message?.author?.id;
  const dm = client.tempDM.get(userid) || {contents: [], reading: false};

  dm.content.push(content);
  client.tempDM.set(userid, dm);

  if (dm.reading) return {};

  dm.reading = true;
  return new Promise((resolve) => setTimeout(() => {
    client.tempDM.delete(userid); // delete first
    resolve({
      useAI: true,
      rawArgs: dm.contents.join('\n')
    });
  }, 7000));
};

const parseMessage = (message) => {
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

client.on('CONNECT', () => {
  client.connectTime = Date.now();
  //console.info('Connecting...');
});

client.on('READY', (d) => {
  console.info(`Logged in as \x1b[0;33m${d.user.username}\x1b[m${client.connectTime ? ' in \x1b[0;33m' + (Date.now() - client.connectTime) + 'ms\x1b[m' : ''}`);
  console.info(`Currently serving \x1b[0;33m${d.guilds.length}\x1b[m server${d.guilds.length > 1 ? 's' : ''}`);
});

client.on('MESSAGE_CREATE', async(m) => {
  const isGuildMessage = !!m.guild_id;
  const isSelf = m.author.id === client._session.user.id;
  const isBot = !!m.author.bot;

  // ignore in several conditions
  if (isBot || isSelf) return;

  const {
    useAI, cmd,
    args,
    rawArgs
  } = await (isGuildMessage ? parseMessage : parseDM)(m);

  if (cmd) {
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
          console.warn(`Unknown permission ${perm} from command:`, cmd);
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
});

client.connect();

process.on('exit', () => client.cleanup());
['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, () => process.exit()));
['uncaughtException', 'unhandledRejection'].forEach(ev => process.on(ev, (error) => console.warn(error)));
