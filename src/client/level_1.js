import StorageManager from '../store/client.js';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';

import intentBits from '../lib/intents.js';

const DEFAULT_INTENT_KEYS = [
  'GUILDS',
  'GUILD_MEMBERS',
  'GUILD_MODERATION',
  'GUILD_EMOJIS_AND_STICKERS',
  'GUILD_INTEGRATIONS',
  'GUILD_WEBHOOKS',
  'GUILD_INVITES',
  'GUILD_VOICE_STATES',
  'GUILD_MESSAGES',
  'GUILD_MESSAGE_REACTIONS',
  'DIRECT_MESSAGES',
  'DIRECT_MESSAGE_REACTIONS',
  'MESSAGE_CONTENT',
  'GUILD_SCHEDULED_EVENTS',
];

const gatewayOverride = process.env.DISCORD_GATEWAY_URL;
const GATEWAY = gatewayOverride && gatewayOverride.trim() ? gatewayOverride : 'wss://gateway.discord.gg';
const intentEnv = process.env.DISCORD_INTENTS;
const INTENT_BITS =
  intentEnv && intentEnv.trim()
    ? intentEnv.split(',').reduce((acc, k) => acc | (intentBits[k.trim()] || 0), 0)
    : DEFAULT_INTENT_KEYS.reduce((acc, k) => acc | intentBits[k], 0);
const RECONNECT_DELAY = parseInt(process.env.DISCORD_RECONNECT_DELAY, 10) || 5000;
const RECONNECT_LIMIT = parseInt(process.env.DISCORD_RECONNECT_LIMIT, 10) || 5;
const RECONNECT_MAX_DELAY = 300_000; // 5 minutes cap

class DiscordClient extends EventEmitter {
  _initPromise = null;
  _session = {};
  _guilds = new Set();
  _gatewayUrl = GATEWAY;
  _gatewayParams = '?v=10&encoding=json';
  _ws = null;
  _heartbeat = null; // setInterval handle
  _heartbeatJitter = null; // setTimeout handle for the first jittered beat
  _reconnectTimer = null; // setTimeout handle for reconnect delay
  _reconnectAttempt = 0;
  _initialised = false;
  _temps = new Map();
  _destroyed = false; // prevents reconnect after destroy()
  _ackReceived = true;

  status = 'closed';

  /**
   * @param {string}   token       Discord bot token
   * @param {number[]} [intentBits] Array of intent bit values to OR together
   * @param {number[]} [shardId]   [shardId, numShards]
   * @param {object}   [config]    Passed through to StorageManager
   */
  constructor(token, intentBits, shardId, config = {}) {
    super();

    if (!token?.trim?.()) throw new Error('Token is required');
    this.token = token;
    this.intents = intentBits?.length ? intentBits.reduce((a, b) => a | b) : INTENT_BITS;
    this.shardId = shardId ?? [0, 1];
    this.config = config;
    this.store = config.store;
  }

  async _init() {
    if (!this.store) {
      this.store = new StorageManager(this.config);
      await this.store.ready();
    }
    this._initialised = true;
    this.connect();
  }

  /** Call once before using the gateway. Idempotent and concurrency-safe. */
  async ready() {
    if (this._initialised) return;
    if (this._initPromise) return this._initPromise;

    this._initPromise = this._init();
    try {
      await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  connect() {
    if (this._destroyed) throw new Error('Cannot reconnect a destroyed gateway — create a new instance');
    if (!this._initialised) throw new Error('Call ready() before connecting');
    if (this.status !== 'closed') return;

    // tear down stale socket before reopening
    if (this._ws) {
      this._ws._removeListeners?.();
      if (this._ws.readyState < WebSocket.CLOSING) this._ws.close();
      this._ws = null;
    }

    this._lastErrorMessage = null;
    this._ws = new WebSocket(this._gatewayUrl + this._gatewayParams);
    this._ws.binaryType = 'arraybuffer';
    this.emit('CONNECT');
    this.status = 'connecting';

    const ws = this._ws;
    const onOpen = this._onOpen.bind(this);
    const onMessageRaw = this._onMessage.bind(this);
    const onError = this._onError.bind(this);
    const onClose = this._onClose.bind(this);

    const onMessageWrapper = (event) => {
      // builtin delivers ArrayBuffer when binaryType=arraybuffer; legacy code expects Buffer
      const data = typeof event.data === 'string' ? event.data : Buffer.from(event.data);
      onMessageRaw(data);
    };
    const onErrorWrapper = (event) => onError(event.error ?? new Error(event.message));
    const onCloseWrapper = (event) => onClose(event.code, event.reason);

    ws.addEventListener('open', onOpen);
    ws.addEventListener('message', onMessageWrapper);
    ws.addEventListener('error', onErrorWrapper);
    ws.addEventListener('close', onCloseWrapper);

    // snapshot socket so remover targets the right instance
    ws._removeListeners = () => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('message', onMessageWrapper);
      ws.removeEventListener('error', onErrorWrapper);
      ws.removeEventListener('close', onCloseWrapper);
    };
  }

  /**
   * Permanently shut down this gateway instance.
   * Awaitable — resolves once the store is cleanly closed.
   */
  async destroy() {
    this._destroyed = true;

    // Cancel any pending reconnect so _onClose doesn't race us.
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;

    this._clearHeartbeat();

    if (this._ws) {
      this._ws._removeListeners?.();
      this._ws.close(1000, 'Client destroyed');
      this._ws = null;
    }

    this._session = {};
    this._guilds.clear();
    this._temps.clear();
    this._initialised = false;
    this._reconnectAttempt = 0;
    this.status = 'closed';

    this.removeAllListeners();
  }

  get me() {
    return this._session.user;
  }
  get application() {
    return this._session.application;
  }
  get guilds() {
    return new Set(this._guilds);
  }

  _onOpen() {
    // _socket is ws-specific; builtin exposes no TCP handle
    this._ws._socket?.setNoDelay?.(true);
    this.emit('OPEN');
  }

  async _onMessage(msg) {
    try {
      if (Buffer.isBuffer(msg) && msg[0] === 0x78) {
        msg = await this._decompress(msg);
      }

      const { t, s, op, d } = JSON.parse(msg);

      switch (op) {
        case 0: // Dispatch
          this._handleDispatch(t, d);
          break;
        case 7: // Server-requested reconnect — keep session, reconnect with resume
          this._ws.close();
          break;
        case 9: // Invalid session
          // d=true resumable, d=false start fresh
          d ? this._resume() : this._reset();
          break;
        case 10: // Hello
          this._setupHeartbeat(d.heartbeat_interval);
          // identify only after Hello — sending it on open races to a 4002 close
          this._session.id ? this._resume() : this._identify();
          break;
        case 11: // Heartbeat ACK
          this._ackReceived = true;
          this.emit('ACK_NOTIFY');
          break;
      }

      if (s != null) this._session.seq = s;
    } catch (err) {
      this.emit('ERROR', err);
    }
  }

  async _handleDispatch(evName, evData) {
    switch (evName) {
      case 'READY':
        this.status = 'ready';
        this._session.id = evData.session_id;
        this._session.user = evData.user;
        this._session.application = evData.application;
        this._gatewayUrl = evData.resume_gateway_url;
        this._reconnectAttempt = 0;
        break;
      case 'RESUMED':
        // a resume restores a live connection but never emits READY
        this.status = 'ready';
        this._reconnectAttempt = 0;
        break;
      case 'GUILD_CREATE':
        this._guilds.add(evData.id);
        break;
      case 'GUILD_DELETE':
        this._guilds.delete(evData.id);
        break;
      case 'MESSAGE_CREATE':
        this.store.set(`${evData.channel_id}:${evData.id}`, evData);
        break;
      case 'MESSAGE_UPDATE': {
        const old = await this.store.get(`${evData.channel_id}:${evData.id}`);
        this.store.set(`${evData.channel_id}:${evData.id}`, evData); // do not use await on store.set to avoid increased latency
        this.store.set(`${evData.channel_id}:${evData.id}:old`, old, true);
        break;
      }
      case 'MESSAGE_DELETE':
        if (await this.store.has(`${evData.channel_id}:${evData.id}`)) {
          const msg = await this.store.get(`${evData.channel_id}:${evData.id}`);
          this.store.set(`${evData.channel_id}:${evData.id}`, msg, true);
        }
        break;
      case 'MESSAGE_DELETE_BULK':
        for (const id of evData.ids) {
          if (await this.store.has(`${evData.channel_id}:${id}`)) {
            const msg = await this.store.get(`${evData.channel_id}:${id}`);
            await this.store.set(`${evData.channel_id}:${id}`, msg, true);
          }
        }
        break;
    }

    this.emit(evName, evData);
  }

  async _onClose(code, reason) {
    const reasonStr = reason?.toString() || this._lastErrorMessage || 'no reason';
    this.emit('CLOSE', code, reasonStr);

    this._ws?._removeListeners?.();
    this._clearHeartbeat();
    this.status = 'closed';

    if (this._destroyed) return;

    // fatal codes mean broken config (token, shard, intents) — reconnecting only
    // loops and re-IDENTIFYs, which can trip the daily limit and reset the token
    const fatal = [4004, 4010, 4011, 4012, 4013, 4014];
    if (fatal.includes(code)) {
      this._destroyed = true;
      this.emit('FATAL', code, reasonStr);
      return;
    }

    // bad seq or expired session — reconnect, but with a fresh identify
    if (code === 4007 || code === 4009) {
      this._reset();
    }

    if (++this._reconnectAttempt >= RECONNECT_LIMIT) {
      this._reconnectAttempt = 0;
      this.emit('RECONNECT_FAILED', 'Reconnect limit reached — giving up');
    } else {
      // Exponential backoff with jitter (fixes S5)
      const baseDelay = RECONNECT_DELAY * Math.pow(2, this._reconnectAttempt - 1);
      const jitter = Math.random() * 1000;
      const delay = Math.min(baseDelay + jitter, RECONNECT_MAX_DELAY);
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        if (!this._destroyed) this.connect();
      }, delay);
    }
  }

  _onError(err) {
    // stash message so _onClose can include it in the reason string
    this._lastErrorMessage = err?.message;
    this.emit('ERROR', err);
  }

  _sendHeartbeat() {
    if (this._ws?.readyState !== WebSocket.OPEN) return;

    if (!this._ackReceived) {
      const msg = 'Zombie connection detected (missed heartbeat ACK). Terminating...';
      if (this.config?.logger?.createLogger) {
        this.config.logger.createLogger('GATEWAY').warn(msg);
      } else {
        console.warn(msg);
      }
      this._ws.close();
      return;
    }

    this._ackReceived = false;
    this._ws.send(
      JSON.stringify({
        op: 1,
        d: this._session.seq ?? null,
      }),
    );
  }

  _setupHeartbeat(interval) {
    this._clearHeartbeat();
    this._ackReceived = true;

    // jittered first beat per Discord spec
    this._heartbeatJitter = setTimeout(
      () => {
        this._heartbeatJitter = null;
        this._sendHeartbeat();
        this._heartbeat = setInterval(this._sendHeartbeat.bind(this), interval);
      },
      Math.floor(Math.random() * interval),
    );
  }

  _clearHeartbeat() {
    clearTimeout(this._heartbeatJitter);
    clearInterval(this._heartbeat);
    this._heartbeatJitter = null;
    this._heartbeat = null;
  }

  _reset() {
    this._gatewayUrl = GATEWAY;
    this._session.id = null;
    this._session.seq = null;
    this._ws.close();
  }

  _resume() {
    this._ws.send(
      JSON.stringify({
        op: 6,
        d: {
          token: this.token,
          session_id: this._session.id,
          seq: this._session.seq,
        },
      }),
    );
  }

  _identify() {
    this._ws.send(
      JSON.stringify({
        op: 2,
        d: {
          token: this.token,
          intents: this.intents,
          shard: this.shardId,
          compress: true,
          properties: {
            os: process.platform,
            browser: 'discord-gateway-js',
            device: 'discord-gateway-js',
          },
        },
      }),
    );
  }

  _decompress(data) {
    return new Promise((resolve, reject) => {
      zlib.inflate(data, (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  async latency() {
    const start = Date.now();
    return new Promise((resolve) => {
      this.once('ACK_NOTIFY', () => resolve(Date.now() - start));
      this._sendHeartbeat(); // trigger
    });
  }
}

export default DiscordClient;
