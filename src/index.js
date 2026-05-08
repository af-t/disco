import Discord from './client/level_4.js';
import Store from './store/client.js';
import tools from './lib/utility.js';
import dotenv from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATABASE_PATH = join(__dirname, '..', 'database');
const COMMANDS_PATH = join(__dirname, '..', 'src', 'commands');
const EVENTS_PATH = join(__dirname, '..', 'src', 'events');

const store = new Store({ diskPath: DATABASE_PATH, logger: tools.Logger, url: process.env.STORE_SERVER_URL });
await store.ready();

const client = new Discord(process.env.DISCORD_TOKEN, null, null, { store, logger: tools.Logger });

client.logger = new tools.Logger('GATEWAY');
client.tempDM = new Map();
await tools.importEvents(client, EVENTS_PATH);

await client.ready();

client.once('READY', async () => {
  client.commands = await tools.importCommands(COMMANDS_PATH);
  tools.deploySlashCommands(client, client.commands);
});

['SIGTERM', 'SIGINT'].forEach((sig) =>
  process.on(sig, async () => {
    await client.destroy();
    await store.close();
  }),
);
['uncaughtException', 'unhandledRejection'].forEach((ev) => process.on(ev, (error) => console.warn(error)));

export default client;
