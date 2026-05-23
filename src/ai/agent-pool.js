import { fork as nodeFork } from 'node:child_process';
import fs from 'node:fs/promises';
import { MSG } from './ipc.js';
import { getExecutor } from './tools/index.js';

function deferred() {
  const { promise, resolve, reject } = Promise.withResolvers();
  const d = { promise, settled: false };
  d.resolve = (v) => {
    d.settled = true;
    resolve(v);
  };
  d.reject = (e) => {
    d.settled = true;
    reject(e);
  };
  return d;
}

export class ChildHandle {
  constructor({ agentKey, child, getExecutor, ctx, logger }) {
    this.agentKey = agentKey;
    this.child = child;
    this.getExecutor = getExecutor;
    this.ctx = ctx;
    this.logger = logger;
    this.running = false;
    this.closed = false;
    this.runSeq = 0;
    this.currentRun = null;
    this.lastActivityAt = Date.now();
    this._ready = deferred();
    child.on('message', (m) => {
      this._onMessage(m).catch((err) => this.logger?.warn?.('agent child message handler failed', err));
    });
    child.on('exit', (code) => this._onExit(code));
    child.on('error', (err) => this.logger?.warn?.('agent child process error', err));
  }

  async _onMessage(msg) {
    if (!msg || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case MSG.READY:
        this._ready.resolve();
        break;
      case MSG.TOOL:
        await this._runTool(msg);
        break;
      case MSG.CHARGE:
        this.ctx.runtime.onAgentCharge?.(this.agentKey, msg.kind);
        break;
      case MSG.DONE:
        this.running = false;
        this.lastActivityAt = Date.now();
        if (Array.isArray(msg.messages)) this.ctx.runtime.onAgentMessages?.(this.agentKey, msg.messages);
        if (this.currentRun) {
          this.currentRun.resolve(msg);
          this.currentRun = null;
        }
        break;
      case MSG.ERROR:
        this.running = false;
        if (this.currentRun) {
          this.currentRun.reject(new Error(msg.message));
          this.currentRun = null;
        } else {
          this.logger?.warn?.(`agent ${this.agentKey} error: ${msg.message}`);
        }
        break;
      default:
        break;
    }
  }

  async _runTool({ id, name, input }) {
    const exec = this.getExecutor(name);
    if (!exec) {
      this._send({ t: MSG.TOOL_RESULT, id, ok: false, error: `unknown tool ${name}` });
      return;
    }
    try {
      const result = await exec(this.ctx, input ?? {});
      this._send({ t: MSG.TOOL_RESULT, id, ok: true, result });
    } catch (err) {
      this._send({ t: MSG.TOOL_RESULT, id, ok: false, error: String(err?.message ?? err) });
    }
  }

  _onExit(code) {
    this.closed = true;
    if (this.currentRun) {
      this.currentRun.reject(new Error(`agent child exited (code ${code})`));
      this.currentRun = null;
    }
    if (!this._ready.settled) this._ready.reject(new Error(`agent child exited before ready (code ${code})`));
    this.onExit?.(code);
  }

  _send(m) {
    if (this.closed) return;
    try {
      this.child.send(m);
    } catch (err) {
      this.logger?.warn?.('agent child send failed', err);
    }
  }

  init(cfg) {
    this._send({ t: MSG.INIT, ...cfg });
    return this._ready.promise;
  }

  // Send a prompt; the child's run() handles the idle-vs-running branch.
  async run(content) {
    await this._ready.promise;
    const id = `r${++this.runSeq}`;
    const wasRunning = this.running;
    this.lastActivityAt = Date.now();
    this._send({ t: MSG.PROMPT, id, content });
    if (!wasRunning) {
      this.running = true;
      this.currentRun = deferred();
    }
    return this.currentRun ? this.currentRun.promise : Promise.resolve(null);
  }

  isIdle() {
    return !this.running;
  }

  shutdown() {
    this._send({ t: MSG.SHUTDOWN });
  }
}

const HOST_PATH = new URL('./agent-host.js', import.meta.url).pathname;

const CHILD_ENV_KEYS = [
  'OPENROUTER_API_KEY',
  'OPENROUTER_MODEL',
  'OPENROUTER_MAX_TOKENS',
  'OPENROUTER_ORDER',
  'OPENROUTER_ONLY',
  'TAVILY_API_KEY',
  'PATH',
  'HOME',
  'NODE_OPTIONS',
];

export class AgentPool {
  constructor({
    ctx,
    logger,
    forkFn = nodeFork,
    hostPath = HOST_PATH,
    idleMs = 300000,
    maxChildren = 16,
    respawnCooldownMs = 30000,
    maintainMs = 30000,
  }) {
    this.ctx = ctx;
    this.logger = logger;
    this.forkFn = forkFn;
    this.hostPath = hostPath;
    this.idleMs = idleMs;
    this.maxChildren = maxChildren;
    this.respawnCooldownMs = respawnCooldownMs;
    this.children = new Map();
    this.cooldowns = new Map();
    this._spawning = new Map();
    this._timer = setInterval(() => this._maintain(), maintainMs);
    this._timer.unref?.();
  }

  has(agentKey) {
    return this.children.has(agentKey);
  }

  isRunning(agentKey) {
    const child = this.children.get(agentKey);
    return !!child && child.running;
  }

  inCooldown(agentKey) {
    const until = this.cooldowns.get(agentKey);
    if (until == null) return false;
    if (Date.now() >= until) {
      this.cooldowns.delete(agentKey);
      return false;
    }
    return true;
  }

  // Route `content` to the agentKey's child, spawning one if needed.
  // Returns the run's done payload, or null when spawn was refused.
  async run(agentKey, content, spawnContext) {
    let child = this.children.get(agentKey);
    if (!child) {
      child = await this._spawnOnce(agentKey, spawnContext);
      if (!child) return null;
    }
    return child.run(content);
  }

  // Dedup concurrent spawns: callers racing on the same new agentKey share
  // one in-flight fork instead of each forking an untracked child.
  _spawnOnce(agentKey, spawnContext) {
    const inFlight = this._spawning.get(agentKey);
    if (inFlight) return inFlight;
    const p = this._spawn(agentKey, spawnContext).finally(() => this._spawning.delete(agentKey));
    this._spawning.set(agentKey, p);
    return p;
  }

  async _spawn(agentKey, spawnContext) {
    if (this.inCooldown(agentKey)) {
      this.logger?.debug?.(`agent ${agentKey} is in respawn cooldown`);
      return null;
    }
    if (this.children.size >= this.maxChildren && !this._evictOneIdle()) {
      this.logger?.warn?.(`agent pool at capacity (${this.maxChildren}); all children busy`);
      return null;
    }
    try {
      await fs.mkdir(spawnContext.workspaceDir, { recursive: true });
    } catch (err) {
      this.logger?.warn?.(`agent ${agentKey} workspace mkdir failed`, err);
      return null;
    }
    const proc = this.forkFn(this.hostPath, [], {
      cwd: spawnContext.workspaceDir,
      env: this._childEnv(),
    });
    const handle = new ChildHandle({
      agentKey,
      child: proc,
      getExecutor,
      ctx: this.ctx,
      logger: this.logger,
    });
    handle.onExit = (code) => this._onChildExit(agentKey, handle, code);
    this.children.set(agentKey, handle);
    try {
      await handle.init({
        agentKey,
        mode: spawnContext.mode,
        systemPrompt: spawnContext.systemPrompt,
        maxTurns: spawnContext.maxTurns,
        compactThreshold: spawnContext.compactThreshold,
        keepTail: spawnContext.keepTail,
        history: spawnContext.history ?? null,
      });
    } catch (err) {
      this.logger?.warn?.(`agent ${agentKey} failed to initialize`, err);
      this.children.delete(agentKey);
      this.cooldowns.set(agentKey, Date.now() + this.respawnCooldownMs);
      return null;
    }
    return handle;
  }

  _evictOneIdle() {
    let lruKey = null;
    let lru = null;
    for (const [key, handle] of this.children) {
      if (handle.isIdle() && (!lru || handle.lastActivityAt < lru.lastActivityAt)) {
        lru = handle;
        lruKey = key;
      }
    }
    if (!lru) return false;
    this.children.delete(lruKey);
    lru.shutdown();
    return true;
  }

  _maintain() {
    const now = Date.now();
    for (const [key, handle] of [...this.children]) {
      if (handle.isIdle() && now - handle.lastActivityAt >= this.idleMs) {
        this.children.delete(key);
        handle.shutdown();
      }
    }
  }

  _onChildExit(agentKey, handle, code) {
    if (this.children.get(agentKey) === handle) this.children.delete(agentKey);
    if (code && code !== 0) {
      this.cooldowns.set(agentKey, Date.now() + this.respawnCooldownMs);
      this.logger?.warn?.(`agent ${agentKey} exited with code ${code}`);
    }
  }

  _childEnv() {
    const env = {};
    for (const key of CHILD_ENV_KEYS) {
      if (process.env[key] != null) env[key] = process.env[key];
    }
    return env;
  }

  shutdown() {
    clearInterval(this._timer);
    for (const [, handle] of this.children) handle.shutdown();
    this.children.clear();
  }
}
