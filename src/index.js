import Discord from './client/level_3.js';
import tools from './lib/utility.js';
import dotenv from 'dotenv';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATABASE_PATH = join(__dirname, '..', 'database');
const COMMANDS_PATH = join(__dirname, '..', 'src', 'commands');
const EVENTS_PATH = join(__dirname, '..', 'src', 'events');

const client = new Discord(process.env.DISCORD_TOKEN, null, null, { diskPath: DATABASE_PATH });

client.commands = await tools.importCommands(COMMANDS_PATH);
await tools.importEvents(client, EVENTS_PATH);

client.tempDM = new Map();

await client.ready();

['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, () => client.destroy()));
['uncaughtException', 'unhandledRejection'].forEach(ev => process.on(ev, (error) => console.warn(error)));
