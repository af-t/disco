const { Client, intentBits } = require("./lib/client");
const fs = require("fs");
const { join, resolve: realpath, basename } = require("path");
const tools = require("./lib/utils.js");

require("dotenv").config();

global.config = require("./config.json");
global.plugins = {};
global.cmds = {};

global.dbPath = realpath(__dirname, "..", "database");

// load all plugins
for (let p of fs.readdirSync(join(__dirname, "plugins")).map(p => realpath(__dirname, "plugins", p))) if (!p.startsWith(".") && p.endsWith(".js") || fs.statSync(p).isDirectory()) {
    if (p.endsWith(".js")) p = p.slice(0, p.length - 3);
    const _p = require(p);
    global.plugins[basename(p)] = _p;
}

// Load all commands from the "commands" directory.
tools.loadCommands(global.cmds, realpath(__dirname, "commands"));

const token = process.env.DISCORD_TOKEN ?? config.token;
if (!token) {
    console.error("Could not find a token. Please make sure that the token is set in either the config file or as an environment variable.");
    process.exit(1);
}

const client = new Client(token, [
    intentBits.GUILD_MESSAGES,
    intentBits.GUILDS,
    intentBits.DIRECT_MESSAGES,
    intentBits.MESSAGE_CONTENT
], config.shard);

client.on('MESSAGE_CREATE', async(m) => {
    tools.saveMessage(m, join(dbPath, "messages"));

    // Ignore with several conditions
    if (m.author.bot) return;

    let cmdreq;
    let cmdargs;
    let argsorigin;
    let use_ai;
    if (m.content.startsWith(process.env.COMMAND_PREFIX ?? config.prefix)) {
        const args = m.content.slice(1).split(/ +/);
        cmdreq = args.shift().toLowerCase();
        const length = cmdreq.length;
        cmdargs = args;
        argsorigin = m.content.slice(1).trim().slice(length).trim();
    } else if (m.content.startsWith(`<@${client._user.id}>`)) {
        const args = m.content.split(/ +/).slice(1);
        cmdreq = args.slice(0, 1)[0];
        cmdargs = args.slice(1);
        if (cmdreq) cmdreq = cmdreq.toLowerCase();
        if (!(cmdreq in global.cmds)) {
            const length = (`<@${client._user.id}>`).length;
            cmdreq = null;
            cmdargs = args.length > 1 ? args : [ "Hi!" ];
            argsorigin = m.content.slice(length).trim();
            argsorigin = argsorigin || cmdargs[0];
        } else {
            const length1 = (`<@${client._user.id}>`).length;
            const length2 = cmdreq.length;
            argsorigin = m.content.slice(length1).trim().slice(length2).trim();
        }
        if (!cmdreq) use_ai = true;
    } else if (m.message_reference) {
        if (global.gemini && gemini.mHist.has(`${m.message_reference.channel_id}/${m.message_reference.message_id}`)) if (m.content) {
            argsorigin = m.content;
            use_ai = true;
        }
    } else if (m.content.includes(`<@${client._user.id}>`)) {
        argsorigin = m.content.replaceAll(`<@${client._user.id}>`, config.gemini.name);
        use_ai = true;
    }

    // logging
    console.blue(`${m.author.username}: ${m.content}`);

    // Exec command if possible
    if (cmdreq && cmdreq in global.cmds) global.cmds[cmdreq](client, m, cmdargs, argsorigin);
    if (use_ai && "ai" in global.cmds) global.cmds.ai(client, m, cmdargs, argsorigin);
});

client.on('MESSAGE_DELETE', (d) => tools.deleteMessage(d, join(dbPath, "messages")));
client.on('MESSAGE_DELETE_BULK', (d) => tools.deleteMessage(d, join(dbPath, "messages")));

client.on('READY', (d) => {
    const yellow = (string) => `\x1b[0;33m${string}\x1b[m`;
    console.log(`Logged in as ${yellow(d.user.username)}`);
    console.log(`Currently serving ${yellow(d.guilds.length)} servers`);
});

client.on('INTERACTION_CREATE', (d) => global.cmds[d.data.name](client, d));
