import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { inspect } from 'node:util';
import permissionFlags from './permission.js';

class Logger {
  constructor(name) {
    this.name = typeof name === 'string' ? name : 'unknown';
  }

  _format(c, ...args) {
    return [
      `\r\x1b[0;${c}m*\x1b[m`,
      `[${this.name}]`,
      ...args.map((x) => (typeof x === 'string' ? x : inspect(x, null, 2, true))),
    ].join(' ');
  }

  _stdout(text) {
    process.stdout.write(text + '\n');
  }

  _stderr(text) {
    process.stderr.write(text + '\n');
  }

  log(...args) {
    this._stdout(this._format(37, ...args));
  }

  warn(...args) {
    this._stderr(this._format(33, ...args));
  }

  info(...args) {
    this._stdout(this._format(36, ...args));
  }

  error(...args) {
    this._stderr(this._format(31, ...args));
  }

  debug(...args) {
    this._stdout(this._format(34, ...args));
  }

  createLogger(name) {
    return Logger.createLogger(name);
  }

  static createLogger(name) {
    return new Logger(name);
  }
}

async function importCommands(path = '', sub = false) {
  if (typeof path !== 'string') throw TypeError('The "path" argument must be of type string.');

  const entries = fs.readdirSync(path, { withFileTypes: true });
  const commands = {};
  const start = Date.now();

  let loaded = 0;

  for (const entry of entries) {
    const filepath = join(path, entry.name);

    if (entry.isDirectory()) {
      const [_commands, _loaded] = await importCommands(filepath, true);
      for (const key in _commands) commands[key] = _commands[key];
      loaded += _loaded;
      continue;
    }

    try {
      let mod = await import(resolve(filepath));
      mod = mod.default || mod;

      if (mod?.data?.name && mod?.execute) {
        const command = (...args) => {
          console.debug('Execute command:', mod.data.name);
          return mod.execute?.(...args);
        };

        command.data = mod.data;

        for (const key in mod.data) {
          Object.defineProperty(command, key, {
            enumerable: true,
            get: () => mod.data[key],
          });
        }

        if ('aliases' in mod.data && Array.isArray(mod.data.aliases))
          for (const alias of mod.data.aliases)
            if (typeof alias === 'string') {
              if (alias in commands) {
                console.warn(`function with name '${alias}' already exists.`);
                continue;
              }
              commands[alias.toLowerCase()] = command;
            }

        commands[mod.data.name.toLowerCase()] = command;
        loaded++;
      } else {
        console.warn(`${entry.name}: does not have the appropriate property`);
      }
    } catch (error) {
      console.warn(`Can't load file:`, entry.name);
      console.error(error);
      //console.error(error.stack);
    }
  }

  if (sub) {
    return [commands, loaded];
  } else {
    console.info(`Loaded ${loaded} command${loaded > 1 ? 's' : ''} in ${Date.now() - start}ms`);
    return commands;
  }
}

async function importEvents(client, path = '') {
  if (typeof path !== 'string') throw TypeError('The "path" argument must be of type string.');
  const entries = fs.readdirSync(path, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const filepath = join(path, entry.name);
    try {
      let mod = await import(resolve(filepath));
      mod = mod.default || mod;
      const eventName = entry.name.split('.')[0].toUpperCase();
      client.on(eventName, (...args) => mod(client, ...args));
    } catch (error) {
      console.warn(`Can't load event file:`, entry.name);
      console.error(error);
    }
  }
}

async function deploySlashCommands(client, commands) {
  if (!client._session?.application?.id) {
    client.logger.warn('Application ID not found, skipping slash command sync.');
    return;
  }

  const slashCommands = [];
  const seen = new Set();
  const start = Date.now();

  for (const key in commands) {
    const cmd = commands[key];
    if (cmd.data && cmd.data.name && cmd.data.description && cmd.data.slash === true) {
      const name = cmd.data.name.toLowerCase();
      if (!seen.has(name)) {
        seen.add(name);

        let default_member_permissions = undefined;
        if (cmd.permissions && cmd.permissions.length > 0) {
          let perms = 0n;
          for (const p of cmd.permissions) {
            if (permissionFlags[p]) perms |= permissionFlags[p];
          }
          default_member_permissions = perms.toString();
        }

        slashCommands.push({
          name: name,
          description: cmd.data.description,
          type: 1, // CHAT_INPUT
          default_member_permissions,
          options: (cmd.data.options || []).map((opt) => ({
            ...opt,
            autocomplete: opt.autocomplete || false,
          })),
        });
      }
    }
  }

  // hash skips PUT when commands unchanged
  const crypto = await import('node:crypto');
  const hash = crypto.createHash('sha256').update(JSON.stringify(slashCommands)).digest('hex');
  const lastHash = await client.store.get('slash_commands_hash');

  if (lastHash === hash) {
    client.logger.info(`Slash commands unchanged, skipping sync (${slashCommands.length} commands)`);
    return;
  }

  try {
    await client.makeRequest('PUT', `/applications/${client._session.application.id}/commands`, slashCommands);
    await client.store.set('slash_commands_hash', hash, false);
    const synced = slashCommands.length;
    client.logger.info(`Synced ${synced} slash command${synced > 1 ? 's' : ''} in ${Date.now() - start}ms`);
  } catch (error) {
    client.logger.error('Failed to sync slash commands:', error);
  }
}

/**
 * Format a timestamp into a human-readable "time ago" string.
 * @param {number} since - Unix timestamp in milliseconds
 * @returns {string} Formatted string like "5m 30s ago"
 */
function formatAgo(since) {
  const diff = Date.now() - since;
  if (diff < 0) return 'just now';
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m ago`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s ago`;
  return `${seconds}s ago`;
}

async function getPermissions(client, guild_id, member) {
  const guildRoles = await client.getRoles(guild_id);
  if (!guildRoles) return 0n;

  const everyoneRole = guildRoles.find((r) => r.id === guild_id);
  let perms = everyoneRole ? BigInt(everyoneRole.permissions) : 0n;

  if (member?.roles) {
    for (const id of member.roles) {
      const role = guildRoles.find((r) => r.id === id);
      if (role) perms |= BigInt(role.permissions);
    }
  }
  return perms;
}

function unrefTimeout(fn, delay) {
  const timer = setTimeout(fn, delay);
  if (process.env.NODE_ENV !== 'test') {
    timer.unref();
  }
  return timer;
}

function unrefInterval(fn, delay) {
  const timer = setInterval(fn, delay);
  if (process.env.NODE_ENV !== 'test') {
    timer.unref();
  }
  return timer;
}

// eslint-disable-next-line no-global-assign
console = new Logger('CONSOLE');

export default {
  importCommands,
  importEvents,
  deploySlashCommands,
  Logger,
  formatAgo,
  getPermissions,
  unrefTimeout,
  unrefInterval,
};
