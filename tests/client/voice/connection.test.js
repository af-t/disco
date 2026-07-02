import { describe, it } from 'node:test';
import assert from 'node:assert';
import DiscordClient from '../../../src/client/level_4.js';

class FakeVoiceWs {
  static OPEN = 1;
  static CLOSING = 2;

  constructor(url) {
    this.url = url;
    this.readyState = FakeVoiceWs.OPEN;
    this.sent = [];
    this.listeners = {};
  }

  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }

  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }

  send(payload) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = 3;
  }

  dispatch(type, detail = {}) {
    for (const fn of this.listeners[type] ?? []) fn(detail);
  }
}

describe('voice IDENTIFY payload', () => {
  it('uses the gateway-tracked client voice session id, not an unset per-connection field', async () => {
    const client = new DiscordClient('fake-token-fake-token-fake-token-fake');
    client._session.user = { id: 'bot-user-1' };

    let createdWs;
    const OriginalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = class extends FakeVoiceWs {
      constructor(url) {
        super(url);
        createdWs = this;
      }
    };

    try {
      const joinPromise = client.joinVoice('chan1', 'guild1');

      // The gateway reports our own voice session id for this guild first.
      await client._handleDispatch('VOICE_STATE_UPDATE', { user_id: 'bot-user-1', session_id: 'session-xyz' });

      // Then hands us the voice server to connect to.
      const dispatchPromise = client._handleDispatch('VOICE_SERVER_UPDATE', {
        guild_id: 'guild1',
        token: 'voice-token',
        endpoint: 'voice.example.com:443',
      });

      assert.ok(createdWs, 'voice websocket should have been constructed');
      createdWs.dispatch('open');

      assert.equal(createdWs.sent.length, 1);
      const identify = JSON.parse(createdWs.sent[0]);
      assert.equal(identify.op, 0); // VOICE_OP.IDENTIFY
      assert.equal(identify.d.session_id, 'session-xyz');
      assert.equal(identify.d.user_id, 'bot-user-1');

      // Let the pending-join promise executor register its VOICE_CONNECT listener
      // before we emit it — otherwise the emit lands before anything is listening.
      await Promise.resolve();
      client.emit('VOICE_CONNECT', { guild_id: 'guild1' });
      await dispatchPromise;
      await joinPromise;
    } finally {
      globalThis.WebSocket = OriginalWebSocket;
    }
  });
});
