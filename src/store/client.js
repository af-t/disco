import WebSocket from 'ws';
import { deserialize } from 'node:v8';

class StoreClient {
  constructor(config = {}) {
    this.url = config?.url || 'ws://localhost:3000';
    this.ws = null;
    this.config = config;
    this._msgId = 0;
    this._pendingRequests = new Map();
    this._reconnect = true;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        resolve();
      });

      this.ws.on('error', (err) => {
        this.ws.removeAllListeners();
        if (this._reconnect) resolve(this.connect());
      });

      this.ws.on('message', (buffer) => {
        try {
          // Deserialize buffer dari server (menggunakan node:v8)
          const response = deserialize(buffer);
          const { id, data } = response;

          if (this._pendingRequests.has(id)) {
            const { resolve } = this._pendingRequests.get(id);
            resolve(data);
            this._pendingRequests.delete(id);
          }
        } catch (err) {
          console.error('Deserialize failed:', err);
        }
      });

      this.ws.on('close', () => {
        this.ws.removeAllListeners();
        if (this._reconnect) this.connect();
      });
    });
  }

  _send(op, args = []) {
    if ((!this.ws || this.ws.readyState !== WebSocket.OPEN) && this._reconnect) {
      return Promise.reject(new Error('WebSocket not connected, call connect() first'));
    }

    return new Promise((resolve, reject) => {
      const id = ++this._msgId;
      this._pendingRequests.set(id, { resolve, reject });

      const payload = JSON.stringify({ op, id, args });
      this.ws.send(payload, (err) => {
        if (err) {
          this._pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  // --- API StoreManager ---

  async ready() {
    await this.connect();
    await this._send('new', [this.config]);
    await this._send('ready');
  }

  async set(key, data, isCache = false) {
    return this._send('set', [key, data, isCache]);
  }

  async get(key) {
    return this._send('get', [key]);
  }

  async delete(key) {
    return this._send('delete', [key]);
  }

  async clear() {
    return this._send('clear');
  }

  async has(key) {
    return this._send('has', [key]);
  }

  async metadata(key) {
    return this._send('metadata', [key]);
  }

  async getStats() {
    return this._send('getStats');
  }

  async resetStats() {
    return this._send('resetStats');
  }

  async close() {
    this._reconnect = false;
    await this._send('close');
    this.ws.close();
  }

  // --- Atribute ---

  async setAttr(key, value) {
    return this._send('set-attr', [key, value]);
  }

  async getAttr(key) {
    return this._send('get-attr', [key]);
  }
}

export default StoreClient;
