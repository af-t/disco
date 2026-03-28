import fs from 'node:fs';
import {join, basename, dirname} from 'node:path';
import {inspect} from 'node:util';

async function importCommands(path = '', sub = false) {
  if (typeof path !== 'string') throw TypeError('The "path" argument must be of type string.');

  const entries = fs.readdirSync(path, { withFileTypes: true });
  const commands = {};
  const start = Date.now();

  let loaded = 0;

  for (const entry of entries) {
    const filepath = join(path, entry.name);
    const filename = basename(path);

    if (entry.isDirectory()) {
      const [_commands, _loaded] = await importCommands(filepath, true);
      for (const key in _commands) commands[key] = _commands[key];
      loaded += _loaded;
      continue;
    }

    try {
      let mod = await import(filepath);
      mod = mod.default || mod;

      if (mod?.data?.name && mod?.execute) {
        const command = (...args) => {
          console.debug('Execute command:', mod.data.name);
          return mod.execute?.(...args);
        }
        for (let key in mod.data) if (key !== 'aliases') Object.defineProperty(command, key, {
          enumerable: true,
          get: () => mod.data?.[key]
        });

        if ('aliases' in mod.data && Array.isArray(mod.data.aliases)) for (const alias of mod.data.aliases) if (typeof alias === 'string') {
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

class Logger {
  static #formatArgs = (num, ...args) => `\x1b[0;${num}m*\x1b[m ${args.map(arg => (typeof arg === 'string') ? arg : inspect(arg, null, 2, true)).join(' ')}`;
  static #cout = (str) => process.stdout.write(str + '\n');
  static #cerr = (str) => process.stderr.write(str + '\n');

  static log = (...args) => Logger.#cout(Logger.#formatArgs(37, ...args));
  static warn = (...args) => Logger.#cerr(Logger.#formatArgs(33, ...args));
  static error = (...args) => Logger.#cerr(Logger.#formatArgs(31, ...args));
  static info = (...args) => Logger.#cout(Logger.#formatArgs(36, ...args));
  static debug = (...args) => Logger.#cout(Logger.#formatArgs(34, ...args));
  static time = console.time;
  static timeEnd = console.timeEnd;
  static trace = console.trace;
}

console = Logger;

async function importEvents(client, path = '') {
  if (typeof path !== 'string') throw TypeError('The "path" argument must be of type string.');
  const entries = fs.readdirSync(path, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const filepath = join(path, entry.name);
    try {
      let mod = await import(filepath);
      mod = mod.default || mod;
      const eventName = entry.name.split('.')[0].toUpperCase();
      client.on(eventName, (...args) => mod(client, ...args));
    } catch (error) {
      console.warn(`Can't load event file:`, entry.name);
      console.error(error);
    }
  }
}

export default {
  importCommands,
  importEvents
}
