import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const CURRENT_FILE = fileURLToPath(import.meta.url);
const RESTART_DELAY_MS = 1_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

export const APP_DEFINITIONS = Object.freeze([
  Object.freeze({ name: 'store', script: join(PROJECT_ROOT, 'src', 'store', 'server.js') }),
  Object.freeze({ name: 'bot', script: join(PROJECT_ROOT, 'src', 'index.js') }),
]);

export class AppSupervisor {
  constructor({
    apps = APP_DEFINITIONS,
    forkFn = fork,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    logger = console,
    restartDelayMs = RESTART_DELAY_MS,
    shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS,
  } = {}) {
    this.apps = apps;
    this.forkFn = forkFn;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.logger = logger;
    this.restartDelayMs = restartDelayMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.children = new Map();
    this.restartTimers = new Map();
    this.started = false;
    this.shuttingDown = false;
    this.shutdownPromise = null;
  }

  start() {
    if (this.started || this.shuttingDown) return;
    this.started = true;
    for (const app of this.apps) this._spawn(app);
  }

  _spawn(app) {
    if (this.shuttingDown) return;
    const child = this.forkFn(app.script, [], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });
    const exit = Promise.withResolvers();
    const record = { app, child, exit: exit.promise };
    this.children.set(app.name, record);

    child.once('error', (error) => this.logger.error(`${app.name} process error:`, error));
    child.once('exit', (code, signal) => {
      exit.resolve();
      if (this.children.get(app.name) !== record) return;
      this.children.delete(app.name);
      if (this.shuttingDown) return;
      this.logger.warn(`${app.name} exited unexpectedly (code ${code}, signal ${signal}); restarting`);
      this._scheduleRestart(app);
    });
  }

  _scheduleRestart(app) {
    if (this.shuttingDown || this.restartTimers.has(app.name)) return;
    const timer = this.setTimeoutFn(() => {
      this.restartTimers.delete(app.name);
      if (!this.shuttingDown) this._spawn(app);
    }, this.restartDelayMs);
    this.restartTimers.set(app.name, timer);
  }

  shutdown() {
    if (!this.shutdownPromise) this.shutdownPromise = this._shutdown();
    return this.shutdownPromise;
  }

  async _shutdown() {
    this.shuttingDown = true;
    for (const timer of this.restartTimers.values()) this.clearTimeoutFn(timer);
    this.restartTimers.clear();

    const records = [...this.children.values()];
    if (records.length === 0) return;

    const forceTimer = this.setTimeoutFn(() => {
      for (const record of records) {
        if (this.children.get(record.app.name) === record) record.child.kill('SIGKILL');
      }
    }, this.shutdownTimeoutMs);

    for (const record of records) {
      if (this.children.get(record.app.name) === record) record.child.kill('SIGTERM');
    }

    try {
      await Promise.all(records.map(({ exit }) => exit));
    } finally {
      this.clearTimeoutFn(forceTimer);
    }
  }
}

export function installSignalHandlers(supervisor, processRef = process) {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    supervisor.shutdown().then(
      () => processRef.exit(0),
      (error) => {
        console.error('App shutdown failed:', error);
        processRef.exit(1);
      },
    );
  };

  processRef.once('SIGINT', stop);
  processRef.once('SIGTERM', stop);
}

export function startApp({ processRef = process, loadEnvFileFn = process.loadEnvFile, supervisorOptions = {} } = {}) {
  try {
    loadEnvFileFn(join(PROJECT_ROOT, '.env'));
  } catch {}

  const supervisor = new AppSupervisor(supervisorOptions);
  supervisor.start();
  installSignalHandlers(supervisor, processRef);
  return supervisor;
}

if (process.argv[1] && resolve(process.argv[1]) === CURRENT_FILE) startApp();
