const { WebSocket } = require("ws");
const { inflateSync } = require("zlib");
const { basename } = require("path");
const os = require("os");

class Client {
    constructor(token, bits, shard = [0, 1], connect = true) {
        this._token = token;
        this._intentBits = bits;
        this._shard = shard;
        this._gateway_url = "wss://gateway.discord.gg";
        this._gateway_query = "?v=10&encoding=json";
        this._session = {};
        this._eventHandlers = new Map();
        this._heartbeatInterval = null;
        this._servers = new Set();

        if (connect) this.initializeWebSocket();
    }

    initializeWebSocket() {
        const ws = new WebSocket(this._gateway_url + this._gateway_query);

        ws.on("message", this.handleMessage.bind(this));
        ws.on("error", this.handleError.bind(this));
        ws.on("close", this.handleClose.bind(this));
        ws.on("open", this.handleOpen.bind(this));

        this._ws = ws;
    }

    handleMessage(message) {
        let parsed;
        try {
            parsed = JSON.parse(inflateSync(message));
        } catch {
            try {
                parsed = JSON.parse(message);
            } catch {
                // handle if needed
                console.warn(`${basename(__dirname)}: Failed to parse message from gateway`);
                return;
            }
        }

        const { t, s, op, d } = parsed;

        switch (op) {
            case 0:
                this.handleDispatch(t, d);
                break;
            case 1:
                this.sendHeartBeat();
                break;
            case 7:
                this.resetConnection();
                break;
            case 9:
                d ? this.resume() : this.resetConnection();
                break;
            case 10:
                this.setupHeartbeat(d.heartbeat_interval);
                break;
            case 11:
                if (this._ack_event) {
                    this._ack_event();
                    delete this._ack_event;
                }
                break;
            default: break;
        }

        if (s) this._session.seq = s;
    }

    handleDispatch(eventName, eventData) {
        if (eventName === "READY") {
            this._session.id = eventData.session_id;
            this._gateway_url = eventData.resume_gateway_url;
            this._user = eventData.user;
            this._application = eventData.application;
        } else if (eventName === "GUILD_CREATE") {
            this._servers.add(eventData.id);
        } else if (eventName === "GUILD_DELETE") {
            this._servers.delete(eventData.id);
        }

        const handlers = this._eventHandlers.get(eventName) || [];
        handlers.forEach(handler => handler(eventData));
    }

    handleError(error) {
        this._ws.closed_what = () => console.warn(`${basename(__dirname)}: WebSocket error: ${error.message}`);
    }

    handleClose() {
        if (this._ws.closed_what) {
            this._ws.closed_what();
        } else {
            console.warn(`${basename(__dirname)}: Connection closed unexpectedly, restarting websocket...`);
        }
        clearInterval(this._heartbeatInterval);
        setTimeout(() => this.initializeWebSocket(), 5000);
    }

    handleOpen() {
        this._session.id ? this.resume() : this.identify();
    }

    setupHeartbeat(interval) {
        this._heartbeatInterval = setInterval(() => this.sendHeartBeat(), interval - 5);
        this.sendHeartBeat();
    }

    resetConnection() {
        this._gateway_url = "wss://gateway.discord.gg";
        this._session = {};
        this._ws.closed_what = () => console.warn(`${basename(__dirname)}: connection reset requested from gateway.`);
        this._ws.terminate();
    }

    resume() {
        this._ws.send(JSON.stringify({
            op: 6,
            d: {
                token: this._token,
                session_id: this._session.id,
                seq: this._session.seq,
                shard: this._shard
            }
        }));
    }

    identify() {
        this._ws.send(JSON.stringify({
            op: 2,
            d: {
                token: this._token,
                intents: this._intentBits.reduce((a, b) => a + b),
                compress: true,
                shard: this._shard,
                properties: {
                    os: `${os.type()} ${os.platform()} ${os.machine()}`,
                    device: process.env.COMPUTERNAME || os.hostname(),
                    browser: "Mozilla/5.0"
                }
            }
        }));
    }

    sendHeartBeat() {
        this._ws.send(JSON.stringify({
            op: 1,
            d: this._session.seq || null
        }));
    }

    on(eventName, handler) {
        if (typeof handler !== "function") return;

        const handlers = this._eventHandlers.get(eventName) || [];
        handlers.push(handler);
        this._eventHandlers.set(eventName, handlers);
    }

    async ping() {
        return new Promise((resolve) => {
            const setAck = () => {
                if (this._ack_event) return;
                const startTime = Date.now();
                this._ack_event = () => resolve(Date.now() - startTime);
                this.sendHeartBeat();

                setAck.defined = true;
            };
            const interval = setInterval(() => {
                setAck();
                if (setAck.defined) clearInterval(interval);
            }, 1);
        });
    }
}

module.exports = Client;
