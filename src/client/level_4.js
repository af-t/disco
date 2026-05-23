import level3 from './level_3.js';
import dgram from 'node:dgram';
import nacl from 'tweetnacl';

// ---- Voice WebSocket opcodes ----
const VOICE_OP = {
  IDENTIFY: 0,
  SELECT_PROTOCOL: 1,
  READY: 2,
  HEARTBEAT: 3,
  SESSION_DESCRIPTION: 4,
  SPEAKING: 5,
  HEARTBEAT_ACK: 6,
  RESUME: 7,
  HELLO: 8,
  RESUMED: 9,
  CLIENT_DISCONNECT: 13,
};

// ---- Encryption mode nonce builders ----
function makeNonceLite(header) {
  const nonce = Buffer.alloc(24);
  nonce.writeUInt32BE(header.readUInt32BE(0), 0);
  return nonce;
}

function makeNonceSuffix(packet) {
  const nonce = Buffer.alloc(24);
  packet.copy(nonce, 0, packet.length - 24);
  return nonce;
}

function makeNonceFull(header, data) {
  const nonce = Buffer.alloc(24);
  header.copy(nonce, 0, 0, 12);
  data.copy(nonce, 12, 0, 12);
  return nonce;
}

// ---- RTP helpers ----
const RTP_HEADER_LEN = 12;
const RTP_EXTENSION_LEN = 4; // lite profile extension

function readRtpHeader(packet) {
  const buf = Buffer.from(packet);
  return {
    type: buf[1] & 0x7f,
    seq: buf.readUInt16BE(2),
    ts: buf.readUInt32BE(4),
    ssrc: buf.readUInt32BE(8),
    hasExt: !!(buf[0] & 0x10),
    header: buf.subarray(0, RTP_HEADER_LEN),
    raw: buf,
  };
}

function buildRtpHeader(ssrc, seq, timestamp) {
  const header = Buffer.alloc(RTP_HEADER_LEN);
  header[0] = 0x80; // version 2, no padding, no extension
  header[1] = 0x78; // payload type 120 (opus) + marker
  header.writeUInt16BE(seq, 2);
  header.writeUInt32BE(timestamp, 4);
  header.writeUInt32BE(ssrc, 8);
  return header;
}

// ---- VoiceConnection (one per guild) ----
class VoiceConnection {
  constructor(client, guildId, channelId, options = {}) {
    this.client = client;
    this.guildId = guildId;
    this.channelId = channelId;
    this.options = options;

    // State
    this.ssrc = null;
    this.secretKey = null;
    this.mode = null;
    this.udp = null;
    this.ws = null;
    this.heartbeat = null;
    this.heartbeatJitter = null;
    this.ackReceived = true;
    this.externalIp = null;
    this.externalPort = null;
    this.ready = false;
    this.destroyed = false;
    this.sequence = Math.floor(Math.random() * 65535);
    this.timestamp = Math.floor(Math.random() * 4294967295);
    this._audioCallbacks = [];
    this._speakingCallback = null; // store ref for cleanup (fixes B2)

    // Bind
    this._onVoiceWsOpen = this._onVoiceWsOpen.bind(this);
    this._onVoiceWsMessage = this._onVoiceWsMessage.bind(this);
    this._onVoiceWsClose = this._onVoiceWsClose.bind(this);
    this._onVoiceWsError = this._onVoiceWsError.bind(this);
    this._onUdpMessage = this._onUdpMessage.bind(this);
  }

  // --- Public API ---

  onAudio(callback) {
    this._audioCallbacks.push(callback);
  }

  playAudio(opusFrame) {
    if (!this.ready) return;
    this._sendOpusFrame(Buffer.from(opusFrame));
  }

  async setSpeaking(speaking) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        op: VOICE_OP.SPEAKING,
        d: {
          speaking: speaking ? 1 : 0,
          delay: 0,
          ssrc: this.ssrc,
        },
      }),
    );
  }

  // --- Internal start flow ---

  async _start(token, endpoint) {
    if (this.destroyed) return;

    const wsUrl = `wss://${endpoint.replace(/:80$/, '')}?v=8`;
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';

    const onVoiceOpen = () => this._onVoiceWsOpen(token);
    const onVoiceClose = (event) => this._onVoiceWsClose(event.code, event.reason);
    const onVoiceError = (event) => this._onVoiceWsError(event.error ?? new Error(event.message));

    this.ws.addEventListener('open', onVoiceOpen);
    this.ws.addEventListener('message', (event) => {
      const data = typeof event.data === 'string' ? event.data : Buffer.from(event.data);
      this._onVoiceWsMessage(data);
    });
    this.ws.addEventListener('close', onVoiceClose);
    this.ws.addEventListener('error', onVoiceError);
  }

  _onVoiceWsOpen(token) {
    this._sendVoiceOp(VOICE_OP.IDENTIFY, {
      server_id: this.guildId,
      user_id: this.client._session.user.id,
      session_id: this._voiceSessionId,
      token,
    });
  }

  _onVoiceWsMessage(msg) {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    switch (data.op) {
      case VOICE_OP.HELLO:
        this._setupVoiceHeartbeat(data.d.heartbeat_interval);
        break;
      case VOICE_OP.READY:
        this.ssrc = data.d.ssrc;
        this._ip = data.d.ip;
        this._port = data.d.port;
        this._modes = data.d.modes;
        this._openUdp();
        break;
      case VOICE_OP.SESSION_DESCRIPTION:
        this.secretKey = Buffer.from(data.d.secret_key);
        this.mode = data.d.mode;
        this.ready = true;
        this.client.emit('VOICE_CONNECT', { guild_id: this.guildId, channel_id: this.channelId });
        break;
      case VOICE_OP.HEARTBEAT_ACK:
        this.ackReceived = true;
        break;
      case VOICE_OP.SPEAKING:
        this.client.emit('VOICE_SPEAKING', {
          guild_id: this.guildId,
          user_id: data.d.user_id,
          ssrc: data.d.ssrc,
          speaking: data.d.speaking !== 0,
        });
        break;
      case VOICE_OP.CLIENT_DISCONNECT:
        this.client.emit('VOICE_DISCONNECT', {
          guild_id: this.guildId,
          user_id: data.d.user_id,
        });
        break;
    }
  }

  _onVoiceWsClose() {
    this._cleanup();
  }

  _onVoiceWsError(err) {
    this.client.logger?.error?.(`Voice WS error [${this.guildId}]:`, err.message);
  }

  // --- UDP ---

  _openUdp() {
    this.udp = dgram.createSocket('udp4');

    this.udp.on('message', this._onUdpMessage);

    this.udp.on('error', (err) => {
      this.client.logger?.error?.(`UDP error [${this.guildId}]:`, err.message);
    });

    // IP discovery per Discord voice protocol
    this.udp.send(Buffer.alloc(70, 0), this._port, this._ip, (err) => {
      if (err) this.client.logger?.error?.('IP discovery send failed:', err.message);
    });

    // Timeout for IP discovery
    this._ipDiscoveryTimeout = setTimeout(() => {
      if (!this.externalIp) {
        this.client.logger?.error?.(`IP discovery timed out for guild ${this.guildId}`);
        // Fallback: use internal IP from ready
        this._selectProtocol(this._ip, this._port);
      }
    }, 5000);
  }

  _onUdpMessage(msg) {
    // Check if this is IP discovery response (null-terminated string)
    if (!this.externalIp) {
      try {
        const nullIdx = msg.indexOf(0);
        if (nullIdx > 0 && nullIdx < 100) {
          const ipStr = msg.toString('utf8', 0, nullIdx);
          const port = msg.readUInt16LE(msg.length - 2);
          this.externalIp = ipStr;
          this.externalPort = port;
          clearTimeout(this._ipDiscoveryTimeout);
          this._selectProtocol(ipStr, port);
          return;
        }
      } catch {
        // Not IP discovery, fall through to audio handling
      }
    }

    // Audio packet: decrypt and emit
    this._handleAudioPacket(msg);
  }

  _selectProtocol(ip, port) {
    const preferredModes = ['xsalsa20_poly1305_lite', 'xsalsa20_poly1305_suffix', 'xsalsa20_poly1305'];
    const mode = preferredModes.find((m) => this._modes.includes(m)) || this._modes[0];

    this._sendVoiceOp(VOICE_OP.SELECT_PROTOCOL, {
      protocol: 'udp',
      data: {
        address: ip,
        port,
        mode,
      },
    });
  }

  // --- Audio receive ---

  _handleAudioPacket(packet) {
    if (!this.secretKey || !this.mode) return;

    try {
      const rtp = readRtpHeader(packet);
      const headerLen = RTP_HEADER_LEN + (rtp.hasExt ? RTP_EXTENSION_LEN : 0);

      let encryptedData;
      let nonce;

      if (this.mode === 'xsalsa20_poly1305_lite') {
        nonce = makeNonceLite(packet.subarray(headerLen, headerLen + 4));
        encryptedData = packet.subarray(headerLen + 4);
      } else if (this.mode === 'xsalsa20_poly1305_suffix') {
        if (packet.length < headerLen + 24 + 16) return;
        encryptedData = packet.subarray(headerLen, packet.length - 24);
        nonce = makeNonceSuffix(packet);
      } else {
        // xsalsa20_poly1305
        encryptedData = packet.subarray(headerLen);
        nonce = makeNonceFull(rtp.header, encryptedData);
      }

      const decrypted = nacl.secretbox.open(encryptedData, nonce, this.secretKey);
      if (!decrypted) return;

      const audioFrame = {
        guild_id: this.guildId,
        user_id: this._getUserIdForSsrc(rtp.ssrc),
        ssrc: rtp.ssrc,
        sequence: rtp.seq,
        timestamp: rtp.ts,
        frame: Buffer.from(decrypted),
      };

      this.client.emit('VOICE_AUDIO', audioFrame);
      for (const cb of this._audioCallbacks) {
        try {
          cb(audioFrame);
        } catch {
          // ignore
        }
      }
    } catch {
      // Drop malformed packets silently
    }
  }

  _getUserIdForSsrc(ssrc) {
    // Track SSRC ↔ user_id mapping from SPEAKING events
    if (!this._ssrcUsers) this._ssrcUsers = new Map();
    return this._ssrcUsers.get(ssrc) || null;
  }

  // SSRC→user mapping populated on VOICE_SPEAKING
  _mapSsrcUser(ssrc, userId) {
    if (!this._ssrcUsers) this._ssrcUsers = new Map();
    this._ssrcUsers.set(ssrc, userId);
  }

  // --- Audio send ---

  _sendOpusFrame(frame) {
    if (!this.ready || !this.udp || !this.secretKey) return;

    const seq = (this.sequence = (this.sequence + 1) & 0xffff);
    const ts = (this.timestamp = (this.timestamp + 960) >>> 0); // 20ms at 48kHz
    const header = buildRtpHeader(this.ssrc, seq, ts);

    // Encrypt
    const nonce = Buffer.alloc(24);
    nonce.writeUInt32BE(seq, 0); // lite mode nonce

    const encrypted = nacl.secretbox(frame, nonce, this.secretKey);
    if (!encrypted) return;

    // RTP header + lite ext + ciphertext
    const extHeader = Buffer.alloc(RTP_EXTENSION_LEN);
    extHeader.writeUInt16BE(0xbede, 0); // profile ID
    extHeader.writeUInt16BE(1, 2); // extensions count

    const packet = Buffer.concat([header, extHeader, nonce.subarray(0, 4), encrypted]);

    this.udp.send(packet, this._port, this._ip, (err) => {
      if (err) this.client.logger?.error?.('UDP send failed:', err.message);
    });
  }

  // --- Heartbeat ---

  _setupVoiceHeartbeat(interval) {
    this._clearVoiceHeartbeat();
    this.ackReceived = true;

    this.heartbeatJitter = setTimeout(
      () => {
        this.heartbeatJitter = null;
        this._sendVoiceHeartbeat();
        this.heartbeat = setInterval(() => this._sendVoiceHeartbeat(), interval);
      },
      Math.floor(Math.random() * interval),
    );
  }

  _sendVoiceHeartbeat() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    if (!this.ackReceived) {
      this.client.logger?.warn?.(`Voice zombie detected [${this.guildId}], terminating.`);
      this.ws.close();
      return;
    }

    this.ackReceived = false;
    this._sendVoiceOp(VOICE_OP.HEARTBEAT, Date.now());
  }

  _clearVoiceHeartbeat() {
    clearTimeout(this.heartbeatJitter);
    clearInterval(this.heartbeat);
    this.heartbeatJitter = null;
    this.heartbeat = null;
  }

  _sendVoiceOp(op, d) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op, d }));
    }
  }

  // --- Cleanup ---

  _cleanup() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ready = false;

    // Remove SPEAKING listener to prevent leak on re-join (fixes B2)
    if (this._speakingCallback) {
      this.client.off('VOICE_SPEAKING', this._speakingCallback);
      this._speakingCallback = null;
    }

    this._clearVoiceHeartbeat();

    if (this.ws) {
      if (this.ws.readyState < WebSocket.CLOSING) {
        this.ws.close(1000, 'leaving voice');
      }
      this.ws = null;
    }

    if (this.udp) {
      try {
        this.udp.close();
      } catch {
        // ignore
      }
      this.udp = null;
    }

    clearTimeout(this._ipDiscoveryTimeout);
  }

  async destroy() {
    this._cleanup();
  }
}

// ---- DiscordClient (extends level_3) ----

class DiscordClient extends level3 {
  #voiceConnections = new Map();
  #pendingVoiceJoin = new Map(); // guild_id -> { resolve, reject, channelId }
  _voiceSessionId = null;

  // ---- Public voice API ----

  async joinVoice(channelId, guildId, options = {}) {
    if (this.#voiceConnections.has(guildId)) {
      await this.leaveVoice(guildId);
    }

    // Send Gateway Op 4: Voice State Update
    this._sendGatewayOp4(guildId, channelId, options);

    return new Promise((resolve, reject) => {
      this.#pendingVoiceJoin.set(guildId, { resolve, reject, channelId });

      // Timeout after 15 seconds
      setTimeout(() => {
        if (this.#pendingVoiceJoin.has(guildId)) {
          const pending = this.#pendingVoiceJoin.get(guildId);
          this.#pendingVoiceJoin.delete(guildId);
          pending.reject(new Error(`Voice join timed out for guild ${guildId}`));
        }
      }, 15000);
    });
  }

  async leaveVoice(guildId) {
    const conn = this.#voiceConnections.get(guildId);
    if (conn) await conn.destroy();
    this.#voiceConnections.delete(guildId);

    // Send Gateway Op 4 with channel_id: null
    this._sendGatewayOp4(guildId, null, {});
    this.emit('VOICE_DISCONNECT', { guild_id: guildId });
  }

  getVoiceConnection(guildId) {
    return this.#voiceConnections.get(guildId) || null;
  }

  // ---- Internal: Gateway Op 4 ----

  _sendGatewayOp4(guildId, channelId, options = {}) {
    if (!this._ws || this._ws.readyState !== 1) return;

    // Update voice state on main gateway
    this._ws.send(
      JSON.stringify({
        op: 4,
        d: {
          guild_id: guildId,
          channel_id: channelId,
          self_mute: options.selfMute || false,
          self_deaf: options.selfDeaf || false,
        },
      }),
    );
  }

  // ---- Override _handleDispatch to intercept voice events ----

  async _handleDispatch(evName, evData) {
    // Intercept VOICE_SERVER_UPDATE before super (it won't emit for MESSAGE_CREATE etc.)
    if (evName === 'VOICE_SERVER_UPDATE') {
      await this._onVoiceServerUpdate(evData);
      this.emit(evName, evData);
      return;
    }

    // Intercept VOICE_STATE_UPDATE to track voice session ID
    if (evName === 'VOICE_STATE_UPDATE') {
      if (evData.user_id === this._session.user?.id) {
        this._voiceSessionId = evData.session_id;
      }
      // Track SSRC mappings for audio receive
      // We'll map when SPEAKING events come in
    }

    // Call super (handles READY, MESSAGE_CREATE etc.)
    await super._handleDispatch(evName, evData);
  }

  async _onVoiceServerUpdate(data) {
    const { guild_id, token, endpoint } = data;
    const pending = this.#pendingVoiceJoin.get(guild_id);

    if (!pending) return;

    // Need a short delay for VOICE_STATE_UPDATE to arrive first
    if (!this._voiceSessionId) {
      await new Promise((r) => setTimeout(r, 500));
    }

    const conn = new VoiceConnection(this, guild_id, pending.channelId, this.options);
    this.#voiceConnections.set(guild_id, conn);

    // Stored ref prevents listener leak on re-join (B2)
    conn._speakingCallback = (ev) => {
      if (ev.guild_id === guild_id && ev.ssrc) {
        conn._mapSsrcUser(ev.ssrc, ev.user_id);
      }
    };
    this.on('VOICE_SPEAKING', conn._speakingCallback);

    try {
      await conn._start(token, endpoint);

      // Wait for ready or timeout
      const result = await new Promise((resolve, reject) => {
        const onConnect = (ev) => {
          if (ev.guild_id === guild_id) {
            this.off('VOICE_CONNECT', onConnect);
            this.off('VOICE_DISCONNECT', onFail);
            resolve(conn);
          }
        };
        const onFail = (ev) => {
          if (ev.guild_id === guild_id) {
            this.off('VOICE_CONNECT', onConnect);
            this.off('VOICE_DISCONNECT', onFail);
            reject(new Error('Voice connection failed'));
          }
        };
        this.on('VOICE_CONNECT', onConnect);
        this.on('VOICE_DISCONNECT', onFail);
        setTimeout(() => {
          this.off('VOICE_CONNECT', onConnect);
          this.off('VOICE_DISCONNECT', onFail);
          reject(new Error('Voice connection timed out'));
        }, 10000);
      });

      this.#pendingVoiceJoin.delete(guild_id);
      pending.resolve(result);
    } catch (err) {
      this.#voiceConnections.delete(guild_id);
      this.#pendingVoiceJoin.delete(guild_id);
      pending.reject(err);
    }
  }

  // ---- Override destroy ----

  async destroy() {
    // Leave all voice connections
    for (const [_guildId, conn] of this.#voiceConnections) {
      try {
        await conn.destroy();
      } catch {
        // ignore
      }
    }
    this.#voiceConnections.clear();
    this.#pendingVoiceJoin.clear();

    return super.destroy();
  }
}

export default DiscordClient;
