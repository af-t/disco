import Discord from './client/level_4.js';
import Store from './store/client.js';
import tools from './lib/utility.js';
import * as ai from './ai/index.js';
import { join } from 'node:path';

try {
  process.loadEnvFile('.env');
} catch {
  // .env is optional in production deployments
}

const __dirname = import.meta.dirname;

const DATABASE_PATH = join(__dirname, '..', 'database');
const COMMANDS_PATH = join(__dirname, '..', 'src', 'commands');
const EVENTS_PATH = join(__dirname, '..', 'src', 'events');

const store = new Store({ diskPath: DATABASE_PATH, logger: tools.Logger, url: process.env.STORE_SERVER_URL });
await store.ready();

const client = new Discord(process.env.DISCORD_TOKEN, null, null, { store, logger: tools.Logger });

client.logger = new tools.Logger('GATEWAY');
client.tempDM = new Map();
await tools.importEvents(client, EVENTS_PATH);

let shuttingDown = false;
const shutdown = async (code) => {
  if (shuttingDown) return;
  shuttingDown = true;
  // watchdog: never let a stuck cleanup leave a zombie process behind
  setTimeout(() => process.exit(code), 5000).unref();
  try {
    await client.destroy();
    await store.close();
  } catch (err) {
    console.warn('Shutdown cleanup failed:', err);
  }
  process.exit(code);
};

// fatal gateway close (bad token/intents/shard) — clean up, then stop
client.once('FATAL', (code, reason) => {
  client.logger.error(
    `Fatal gateway close ${code} (${reason}) — connection cannot be recovered. ` +
      'Check DISCORD_TOKEN, shard configuration, and the intents enabled in the Developer Portal.',
  );
  shutdown(1);
});

await client.ready();

client.once('READY', async () => {
  client.commands = await tools.importCommands(COMMANDS_PATH);
  tools.deploySlashCommands(client, client.commands);
  await ai.init(client);
});

['SIGTERM', 'SIGINT'].forEach((sig) => process.on(sig, () => shutdown(0)));
['uncaughtException', 'unhandledRejection'].forEach((ev) => process.on(ev, (error) => console.warn(error)));

export default client;
