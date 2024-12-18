import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { basename, dirname, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { isMainThread } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs/promises';
import fsS from 'node:fs'; //for synchronous operation
import https from 'node:https';
import crypto from 'node:crypto';

// Helper function to simplify writing for sleep
const sleep = (duration) => new Promise(resolve => setTimeout(resolve, duration));

export class Discord extends EventEmitter {
  static RECONNECT_DELAY = 5000;
  static CACHE_AGE = 30000;
  static CACHE_PATH = join(process.env.TMPDIR || process.env.TEMP || process.env.TMP || (fsS.existsSync('/tmp') ? '/tmp' : '.'), `message_cache.${Math.random().toString(36).slice(2)}`);
  static HEARTBEAT_JITTER = 20;
  static API_VERSION = 'v10';
  static INTENT_BIT = 53608447;
  static BROWSER = process.platform;
  static MAX_RETRIES = 5;
  static BOT_STATUS = 'online';

  // CACHE (permanent)
  #removable = new Set(); // file cache
  #checksums = new Map();

  constructor(token, intents, shard) {
    super();

    // Re-asign to default value if input is falsy (null, 0, '', false, undefined)
    token = token || '';
    intents = intents || [Discord.INTENT_BIT];
    shard = shard || [0, 1];

    if (typeof token !== 'string') throw TypeError('The first argument must be of type string');
    if (!Array.isArray(intents)) throw TypeError('The second argument must be of type Array');

    // Session info
    this._servers = new Set();
    this._session = {};

    this._token = token;
    this._intents = intents.reduce((a, b) => a + b);
    this._shard = shard;
    this._gatewayUrl = 'wss://gateway.discord.gg';
    this._gatewayParams = `?${Discord.API_VERSION}&encoding=json`;

    // makeRequest config
    this._withPrefix = true;
    this._apiBaseUrl = `https://discord.com/api/${Discord.API_VERSION}`;

    this.#init();
  }

  async #init() {
    if (!this._token) throw Error('Discord tokens cannot be empty');
    if (!isMainThread) return; //  avoid wasting resources that will not be used

    this._messages = new MessageCache(Discord.CACHE_PATH, Discord.CACHE_AGE);

    // Determine API prefix (Bot or Bearer)
    try {
      await this.getUser('@me'); // Try with prefix
    } catch {
      this._withPrefix = false;
      try {
        await this.getUser('@me'); //Try without prefix
      } catch (error) {
        this._withPrefix = true;
        console.warn('API test failed:', error.message);
        //console.warn(error.stack);
      }
    }

    // : manual
    //this.connect();
  }

  connect() {
    if (!isMainThread) {
      console.warn('Connect is only allowed on the main thread');
      return;
    }

    if (this._ws?._socket?.destroyed === false) return this._ws._socket.destroy();
    this._ws = new WebSocket(this._gatewayUrl + this._gatewayParams);

    this.emit('CONNECT');

    this._ws.on('open', this.#wsHandleOpen.bind(this));
    this._ws.on('message', this.#wsHandleMessage.bind(this));
    this._ws.on('error', this.#wsHandleError.bind(this));
    this._ws.on('close', this.#wsHandleClose.bind(this));
  }

  #wsHandleOpen() {
    this._session.id ? this.#resume() : this.#identify();
    this.emit('open');
  }

  #wsHandleMessage(message) {
    if (message[0] === 0x78 && message[1] === 0x9c) message = inflateSync(message);
    message = JSON.parse(message);

    const { t, s, op, d } = message;

    switch (op) {
      case 0:
        this.#handleDispatch(t, d);
        break;
      case 1:
        this.#sendHeartbeat();
        break;
      case 7:
        this.#reset();
        break;
      case 9:
        d ? this.#resume() : this.#reset();
        break;
      case 10:
        this.#setupHeartbeat(d.heartbeat_interval);
        break;
      case 11:
        this.emit('ACK_NOTIFY');
        break;
    }

    if (s) this._session.seq = s;
  }

  #handleDispatch(eventName, eventData) {
    if (eventName === 'READY') {
      this._session.id = eventData.session_id;
      this._session.user = eventData.user;
      this._session.application = eventData.application;
      this._gatewayUrl = eventData.resume_gateway_url;
    }
    if (eventName === 'GUILD_CREATE') {
      this._servers.add(eventData.id);
    }
    if (eventName === 'GUILD_DELETE') {
      this._servers.delete(eventData.id);
    }
    if (eventName === 'MESSAGE_CREATE') {
      this._messages.add(eventData);
    }

    this.emit(eventName, eventData);
  }

  #sendHeartbeat() {
    this._ws.send(JSON.stringify({
      op: 1,
      d: this._session.seq || null
    }));
  }

  #setupHeartbeat(interval) {
    this._heartbeat = setInterval(() => this.#sendHeartbeat(), interval - Discord.HEARTBEAT_JITTER);
    this.#sendHeartbeat();
  }

  #reset() {
    this._gatewayUrl = 'wss://gateway.discord.gg';
    this._ws.whyClosed = () => console.warn('Connection reset, new connection will be created soon');
    this._ws.terminate();
    this._session.id = null;
    this._session.seq = null;
  }

  #resume() {
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

  #identify() {
    this._ws.send(JSON.stringify({
      op: 2,
      d: {
        token: this._token,
        intents: this._intents,
        shard: this._shard,
        compress: true,
        properties: {
          os: `${os.type()} ${os.platform()} ${os.machine()}`,
          device: process.env.COMPUTERNAME || os.hostname(),
          browser: Discord.BROWSER
        }
      }
    }));
  }

  #wsHandleError(error) {
    this._ws.whyClosed = () => {
      console.warn(`WebSocket error: ${error.message}`);
      //console.warn(error.stack);
    }

    if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
      console.warn(`Can't connect to discord, make sure internet is available`);
      process.exit(1);
    }
  }

  #wsHandleClose() {
    this._ws?.whyClosed ? this._ws.whyClosed() : console.warn(`WebSocket connection lost without reason, reconnecting...`);
    this._ws?.removeAllListeners?.();
    clearInterval(this._heartbeat);
    setTimeout(() => this.connect(), Discord.RECONNECT_DELAY);
  }

  async makeRequest(method, endpoint, body, headers = {}) {
    const options = {
      method,
      headers: {
        'Authorization': (this._withPrefix ? 'Bot ' : '') + this._token,
        'Content-Type': 'application/json',
        ...headers
      },
      body: (() => {
        try {
          return JSON.stringify(body);
        } catch {
          return body;
        }
      })()
    }
    const targetUrl = this._apiBaseUrl + endpoint;

    for (let i = 0; i < Discord.MAX_RETRIES; i++) try {
      const response = await fetch(targetUrl, options);
      let data = Buffer.from(await response.arrayBuffer());

      try {
        data = JSON.parse(data);
      } catch {}

      if (response.ok) return data;
      throw data;
    } catch (error) {
      if (error?.retry_delay) {
        console.warn('Got hit by rate limiting from discord');
        await sleep(error.retry_delay * 1000);
      }
      if (error?.cause?.name !== 'ConnectTimeoutError') try {
        return Promise.reject(Object.assign(Error(), error));
      } catch {
        return Promise.reject(error);
      }
    }

    throw Error(`Request failed after ${Discord.MAX_RETRIES} attempt${Discord.MAX_RETRIES > 1 ? 's' : ''}`);
  }

  async #getFileInfo(file) {
    if (typeof file !== 'string') return file;
    if (file.startsWith('file:///')) {
      file = fileURLToPath(file);
    }

    let filename, filepath, file_size, checksum;
    if (file.startsWith('http://') || file.startsWith('https://')) {
      const {pathname} = new URL(file);
      const download = await (await fetch(file).catch(_ => _))?.arrayBuffer?.();
      if (download) {
        filename = basename(pathname) || 'message.bin';
        file_size = download.size;
        filepath = join(process.env.TEMP || process.env.TMP || process.env.TMPDIR || (fsS.existsSync('/tmp') ? '/tmp' : '.'), `${Date.now()}-${filename}`);
        await fs.writeFile(filepath, Buffer.from(download));
        this.#removable.add(filepath);
      }
    } else if (fsS.existsSync(file)) {
      filename = basename(file);
      filepath = file;
      file_size = (await fs.stat(file)).size;
    }

    if (file_size <= 10 * 1024 * 1024) checksum = await new Promise((resolve, reject) => {
      const stream = fsS.createReadStream(filepath);
      const chsum = crypto.createHash('sha256');
      stream.on('data', chunk => chsum.update(chunk));
      stream.on('end', () => resolve(Array.from(chsum.digest(), d => d.toString(36)).join('')));
      chsum.on('error', reject);
    });

    return { filepath, filename, file_size, checksum };
  }

  async setSaveMessagePath(path) {
    return this._messages.setPath(path);
  }

  /**
   * Pinging with heartbeat method,
   * results are not guaranteed to be accurate
   */
  async ping() {
    const start = Date.now();
    return new Promise(resolve => {
      this.once('ACK_NOTIFY', () => resolve(Date.now() - start));
      this.#sendHeartbeat();
    });
  }

  async getUser(id) {
    return this.makeRequest('GET', `/users/${id}`);
  }

  async getMessage(channel_id, message_id) {
    let message = this._messages.get(channel_id, message_id);
    if (!message?.guild_id) try {
      message = await this.makeRequest('GET', `/channels/${channel_id}/messages/${message_id}`);
    } catch {
      // alternative method
      [message] = await this.getMessages(channel_id, { before: message_id, limit: 1 });
      [message] = await this.getMessages(channel_id, { after: message.id, limit: 1 });
    }
    return message;
  }

  async getMessages(channel_id, options) {
    const params = new URLSearchParams(options);
    return this.makeRequest('GET', `/channels/${channel_id}/messages?${params}`);
  }

  async editMessage({ channel_id, id }, content, options) {
    return this.makeRequest('PATCH', `/channels/${channel_id}/messages/${id}`, { content, ...options });
  }

  async sendMessage(channel_id, content, options) {
    if (options.attachments) options.attachments = this.uploadToDiscord(channel_id, options.attachments);
    if (options.files) {
      const attachments = await this.uploadToDiscord(channel_id, options.files);
      if (Array.isArray(options.attachments)) options.attachments.push(...attachments);
      else options.attachments = attachments;
      delete options.files;
    }
    return this.makeRequest('POST', `/channels/${channel_id}/messages`, { content, ...options });
  }

  async reply({ channel_id, id }, content, mention = false, options = {}) {
    return this.sendMessage(channel_id, content, { message_reference: { channel_id, message_id: id }, ...(mention ? {} : { allowed_mentions: {} }), ...options });
  }

  async sendTyping(channel_id) {
    return this.makeRequest('POST', `/channels/${channel_id}/typing`);
  }

  async uploadToDiscord(channel_id, files = []) {
    if (!Array.isArray(files) || files.length < 1) return [];
    files = await Promise.all(files.map(this.#getFileInfo.bind(this)));

    const cached = [];
    const upload = [];
    for (let i = 0; i < files.length; i++) {
      if (!files[i].checksum) {
        upload.push({ ...files[i], id: i });
        continue;
      }
      if (!this.#checksums.has(files[i].checksum)) {
        upload.push({ ...files[i], id: i });
        continue;
      }
      cached.push({ ...this.#checksums.get(files[i].checksum), id: i });
    }

    const {attachments} = await this.makeRequest('POST', `/channels/${channel_id}/attachments`, { files: upload.map(f => ({ filename: f.filename, file_size: f.file_size })) });

    for (let i = 0; i < attachments.length; i++) await new Promise((resolve, reject) => {
      const reader = fsS.createReadStream(files[i].filepath);
      const req = https.request(attachments[i].upload_url, {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': files[i].file_size
        }
      }, (res) => {
        res.on('data', _ => _);
        res.on('end', resolve);
      });
      req.on('error', reject);
      reader.pipe(req, { end: true });
    });

    attachments.forEach((item, index) => {
      const data = {
        uploaded_filename: item.upload_filename,
        id: upload[index].id,
        filename: upload[index].filename
      };
      if (upload[index].checksum) this.#checksums.set(upload[index].checksum, data);
      cached.push(data);
    });
    return cached;
  }

  async editChannel(channel_id, options = {}) {
    return this.makeRequest('PATCH', `/channels/${channel_id}`, options);
  }

  async editChannelPermission(channel_id, overwrite_id, options = {}) {
    return this.makeRequest('PATCH', `/channels/${channel_id}/permissions/${overwrite_id}`, options);
  }

  async editChannelWebhooks(channel_id, webhook_id, options = {}) {
    return this.makeRequest('PATCH', `/channels/${channel_id}/webhooks/${webhook_id}`, options);
  }

  async editChannelPosition(channel_id, position) {
    return this.editChannel(channel_id, { position });
  }

  async editChannelTopic(channel_id, topic) {
    return this.editChannel(channel_id, { topic });
  }

  async deleteMessage(channel_id, message_id) {
    return this.makeRequest('DELETE', `/channels/${channel_id}/messages/${message_id}`);
  }

  async bulkDeleteMessages(channel_id, messages) {
    return this.makeRequest('POST', `/channels/${channel_id}/messages/bulk-delete`, { messages });
  }

  async createChannel(guild_id, options) {
    return this.makeRequest('POST', `/guilds/${guild_id}/channels`, options);
  }

  async deleteChannel(channel_id) {
    return this.makeRequest('DELETE', `/channels/${channel_id}`);
  }

  async getChannel(channel_id) {
    return this.makeRequest('GET', `/channels/${channel_id}`);
  }

  async getChannels(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/channels`);
  }

  async getGuild(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}`);
  }

  async getGuildPreview(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/preview`);
  }

  async modifyGuild(guild_id, options) {
    return this.makeRequest('PATCH', `/guilds/${guild_id}`, options);
  }

  async createWebhook(channel_id, options = {}) {
    return this.makeRequest('POST', `/channels/${channel_id}/webhooks`, options)
  }

  async getChannelWebhooks(channel_id) {
    return this.makeRequest('GET', `/channels/${channel_id}/webhooks`);
  }

  async getGuildWebhooks(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/webhooks`);
  }

  async getWebhook(webhook_id) {
    return this.makeRequest('GET', `/webhooks/${webhook_id}`)
  }

  async executeWebhook(webhook_id, webhook_token, options = {}, wait = false) {
    const headers = {
      'Content-Type': options.files ? 'multipart/form-data' : 'application/json'
    }

    let endpoint = `/webhooks/${webhook_id}/${webhook_token}`;
    if (wait) endpoint += '?wait=true';

    return this.makeRequest('POST', endpoint, options, headers);
  }

  async getRoles(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/roles`);
  }

  async createRole(guild_id, options) {
    return this.makeRequest('POST', `/guilds/${guild_id}/roles`, options);
  }

  async editRole(guild_id, role_id, options) {
    return this.makeRequest('PATCH', `/guilds/${guild_id}/roles/${role_id}`, options);
  }

  async deleteRole(guild_id, role_id) {
    return this.makeRequest('DELETE', `/guilds/${guild_id}/roles/${role_id}`);
  }

  async getGuildMember(guild_id, user_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/members/${user_id}`);
  }

  async getGuildMembers(guild_id, options = {}) {
    const params = new URLSearchParams(options);
    return this.makeRequest('GET', `/guilds/${guild_id}/members?${params}`);
  }

  async kickMember(guild_id, user_id, reason) {
    return this.makeRequest('DELETE', `/guilds/${guild_id}/members/${user_id}`, { reason });
  }

  async banMember(guild_id, user_id, options = {}) {
    return this.makeRequest('PUT', `/guilds/${guild_id}/bans/${user_id}`, options);
  }

  async unbanMember(guild_id, user_id) {
    return this.makeRequest('DELETE', `/guilds/${guild_id}/bans/${user_id}`);
  }

  async muteMember(guild_id, user_id, duration = 0) {
    const timeoutUntil = new Date(Date.now() + duration).toISOString();
    return this.makeRequest('PATCH', `/guilds/${guild_id}/members/${user_id}`, { communication_disabled_until: timeoutUntil });
  }

  async unmuteMember(guild_id, user_id) {
    return this.makeRequest('PATCH', `/guilds/${guild_id}/members/${user_id}`, { communication_disabled_until: null });
  }

  async getGuildEmojis(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/emojis`);
  }

  async createEmoji(guild_id, options) {
    return this.makeRequest('POST', `/guilds/${guild_id}/emojis`, options);
  }

  async deleteEmoji(guild_id, emoji_id) {
    return this.makeRequest('DELETE', `/guilds/${guild_id}/emojis/${emoji_id}`);
  }

  async addReaction(channel_id, message_id, emoji) {
    return this.makeRequest('PUT', `/channels/${channel_id}/messages/${message_id}/reactions/${emoji}/@me`);
  }

  async removeReaction(channel_id, message_id, emoji, user_id = '@me') {
    return this.makeRequest('DELETE', `/channels/${channel_id}/messages/${message_id}/reactions/${emoji}/${user_id}`);
  }

  async getReactions(channel_id, message_id, emoji) {
    return this.makeRequest('GET', `/channels/${channel_id}/messages/${message_id}/reactions/${emoji}`);
  }

  async removeAllReactions(channel_id, message_id) {
    return this.makeRequest('DELETE', `/channels/${channel_id}/messages/${message_id}/reactions`);
  }

  async getGuildStickers(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/stickers`);
  }

  async createGuildSticker(guild_id, options) {
    return this.makeRequest('POST', `/guilds/${guild_id}/stickers`, options);
  }

  async deleteGuildSticker(guild_id, sticker_id) {
    return this.makeRequest('DELETE', `/guilds/${guild_id}/stickers/${sticker_id}`);
  }

  async createInvite(channel_id, options = {}) {
    return this.makeRequest('POST', `/channels/${channel_id}/invites`, options);
  }

  async getInvite(invite_code) {
    return this.makeRequest('GET', `/invites/${invite_code}`);
  }

  async deleteInvite(invite_code) {
    return this.makeRequest('DELETE', `/invites/${invite_code}`);
  }

  async getGuildInvites(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/invites`);
  }

  async moveUser(guild_id, user_id, channel_id) {
    return this.makeRequest('PATCH', `/guilds/${guild_id}/members/${user_id}`, {
      channel_id: channel_id
    });
  }

  async setUserVoiceState(guild_id, user_id, options) {
    return this.makeRequest('PATCH', `/guilds/${guild_id}/members/${user_id}`, {
      mute: options.mute,
      deaf: options.deaf
    });
  }

  async createThread(channel_id, options) {
    return this.makeRequest('POST', `/channels/${channel_id}/threads`, options);
  }

  async joinThread(channel_id) {
    return this.makeRequest('PUT', `/channels/${channel_id}/thread-members/@me`);
  }

  async leaveThread(channel_id) {
    return this.makeRequest('DELETE', `/channels/${channel_id}/thread-members/@me`);
  }

  async getThreadMembers(channel_id) {
    return this.makeRequest('GET', `/channels/${channel_id}/thread-members`);
  }

  async setPresence(options) {
    this._ws.send(JSON.stringify({
      op: 3,
      d: {
        since: options.since || null,
        activities: options.activities || [],
        status: options.status || Discord.BOT_STATUS,
        afk: options.afk || false
      }
    }));
  }

  async getGlobalApplicationCommands(application_id) {
    return this.makeRequest('GET', `/applications/${application_id}/commands`);
  }

  async createGlobalApplicationCommand(application_id, options) {
    return this.makeRequest('POST', `/applications/${application_id}/commands`, options);
  }

  async getGuildApplicationCommands(application_id, guild_id) {
    return this.makeRequest('GET', `/applications/${application_id}/guilds/${guild_id}/commands`);
  }

  async createGuildApplicationCommand(application_id, guild_id, options) {
    return this.makeRequest('POST', `/applications/${application_id}/guilds/${guild_id}/commands`, options);
  }

  async getGuildAuditLog(guild_id, options = {}) {
    const params = new URLSearchParams(options);
    return this.makeRequest('GET', `/guilds/${guild_id}/audit-logs?${params}`);
  }

  async getGuildIntegrations(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/integrations`);
  }

  async deleteGuildIntegration(guild_id, integration_id) {
    return this.makeRequest('DELETE', `/guilds/${guild_id}/integrations/${integration_id}`);
  }

  async getGuildTemplates(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/templates`);
  }

  async createGuildTemplate(guild_id, options) {
    return this.makeRequest('POST', `/guilds/${guild_id}/templates`, options);
  }

  async syncGuildTemplate(guild_id, template_code) {
    return this.makeRequest('PUT', `/guilds/${guild_id}/templates/${template_code}`);
  }

  async getScheduledEvents(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/scheduled-events`);
  }

  async createScheduledEvent(guild_id, options) {
    return this.makeRequest('POST', `/guilds/${guild_id}/scheduled-events`, options);
  }

  async cancelScheduledEvent(guild_id, event_id) {
    return this.makeRequest('DELETE', `/guilds/${guild_id}/scheduled-events/${event_id}`);
  }

  async createStageInstance(channel_id, options) {
    return this.makeRequest('POST', `/stage-instances`, { channel_id, ...options });
  }

  async getStageInstance(channel_id) {
    return this.makeRequest('GET', `/stage-instances/${channel_id}`);
  }

  async deleteStageInstance(channel_id) {
    return this.makeRequest('DELETE', `/stage-instances/${channel_id}`);
  }

  async getAutoModerationRules(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/auto-moderation/rules`);
  }

  async createAutoModerationRule(guild_id, options) {
    return this.makeRequest('POST', `/guilds/${guild_id}/auto-moderation/rules`, options);
  }

  async deleteAutoModerationRule(guild_id, rule_id) {
    return this.makeRequest('DELETE', `/guilds/${guild_id}/auto-moderation/rules/${rule_id}`);
  }

  async getVoiceRegions() {
    return this.makeRequest('GET', '/voice/regions');
  }

  async getCurrentUserConnections() {
    return this.makeRequest('GET', '/users/@me/connections');
  }

  async getUserActivities(user_id) {
    return this.makeRequest('GET', `/users/${user_id}/activities`);
  }

  async setUserActivity(activity) {
    this._ws.send(JSON.stringify({
      op: 3,
      d: {
        since: null,
        activities: [activity],
        status: Discord.BOT_STATUS,
        afk: false
      }
    }));
  }

  async getUserRelationships() {
    return this.makeRequest('GET', '/users/@me/relationships');
  }

  async addFriend(username, discriminator) {
    return this.makeRequest('POST', '/users/@me/relationships', { username, discriminator });
  }

  async removeFriend(user_id) {
    return this.makeRequest('DELETE', `/users/@me/relationships/${user_id}`);
  }

  async blockUser(user_id) {
    return this.makeRequest('PUT', `/users/@me/relationships/${user_id}`, { type: 2 });
  }

  async setUserNote(user_id, note) {
    return this.makeRequest('PUT', `/users/@me/notes/${user_id}`, { note });
  }

  async getUserNote(user_id) {
    return this.makeRequest('GET', `/users/@me/notes/${user_id}`);
  }

  async createDM(recipient_id) {
    return this.makeRequest('POST', '/users/@me/channels', { recipient_id });
  }

  async closeDM(channel_id) {
    return this.makeRequest('DELETE', `/channels/${channel_id}`);
  }

  async getUserSettings() {
    return this.makeRequest('GET', '/users/@me/settings');
  }

  async updateUserSettings(settings) {
    return this.makeRequest('PATCH', '/users/@me/settings', settings);
  }

  async getPinnedMessages(channel_id) {
    return this.makeRequest('GET', `/channels/${channel_id}/pins`);
  }

  async pinMessage(channel_id, message_id) {
    return this.makeRequest('PUT', `/channels/${channel_id}/pins/${message_id}`);
  }

  async unpinMessage(channel_id, message_id) {
    return this.makeRequest('DELETE', `/channels/${channel_id}/pins/${message_id}`);
  }

  async createScheduledMessage(channel_id, content, scheduled_for) {
    return this.makeRequest('POST', `/channels/${channel_id}/messages`, {
      content,
      tts: false,
      flags: 1 << 12, // SCHEDULED flag
      scheduled_for
    });
  }

  async getScheduledMessages(channel_id) {
    return this.makeRequest('GET', `/channels/${channel_id}/messages/scheduled`);
  }

  async deleteScheduledMessage(channel_id, message_id) {
    return this.makeRequest('DELETE', `/channels/${channel_id}/messages/scheduled/${message_id}`);
  }

  async createCategory(guild_id, name) {
    return this.makeRequest('POST', `/guilds/${guild_id}/channels`, {
      name,
      type: 4 // Category type
    });
  }

  async moveChannelToCategory(channel_id, category_id) {
    return this.makeRequest('PATCH', `/channels/${channel_id}`, {
      parent_id: category_id
    });
  }

  async getApplicationRoleConnections(application_id) {
    return this.makeRequest('GET', `/applications/${application_id}/role-connections/metadata`);
  }

  async updateApplicationRoleConnections(application_id, metadata) {
    return this.makeRequest('PUT', `/applications/${application_id}/role-connections/metadata`, metadata);
  }

  async setChannelNSFW(channel_id, nsfw) {
    return this.makeRequest('PATCH', `/channels/${channel_id}`, { nsfw });
  }

  async createForumPost(channel_id, options) {
    return this.makeRequest('POST', `/channels/${channel_id}/threads`, {
      ...options,
      type: 11 // GUILD_FORUM type
    });
  }

  async getActiveThreads(channel_id) {
    return this.makeRequest('GET', `/channels/${channel_id}/threads/active`);
  }

  async getArchivedThreads(channel_id, options = {}) {
    const params = new URLSearchParams(options);
    return this.makeRequest('GET', `/channels/${channel_id}/threads/archived/public?${params}`);
  }

  async crosspostMessage(channel_id, message_id) {
    return this.makeRequest('POST', `/channels/${channel_id}/messages/${message_id}/crosspost`);
  }

  async followNewsChannel(channel_id, webhook_channel_id) {
    return this.makeRequest('POST', `/channels/${channel_id}/followers`, {
      webhook_channel_id
    });
  }

  async getDiscoveryCategories() {
    return this.makeRequest('GET', '/discovery/categories');
  }

  async updateDiscoveryMetadata(guild_id, options) {
    return this.makeRequest('PATCH', `/guilds/${guild_id}/discovery-metadata`, options);
  }

  async getDiscoveryValidationInfo(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/discovery-metadata/validation`);
  }

  async modifyUserVoice(guild_id, user_id, options) {
    return this.makeRequest('PATCH', `/guilds/${guild_id}/members/${user_id}`, {
      mute: options.mute,
      deaf: options.deaf,
      channel_id: options.channel_id
    });
  }

  async createVoiceConnection(channel_id, options = {}) {
    this._ws.send(JSON.stringify({
      op: 4,
      d: {
        guild_id: options.guild_id,
        channel_id,
        self_mute: options.self_mute || false,
        self_deaf: options.self_deaf || false
      }
    }));
  }

  async getGuildExperiments(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/experiments`);
  }

  async toggleExperiment(guild_id, experiment_id, enabled) {
    return this.makeRequest('PATCH', `/guilds/${guild_id}/experiments/${experiment_id}`, {
      enabled
    });
  }

  async getApplicationCommands() {
    return this.makeRequest('GET', `/applications/${this._session.application.id}/commands`);
  }

  async createInteractionResponse(interaction_id, interaction_token, response) {
    return this.makeRequest('POST', `/interactions/${interaction_id}/${interaction_token}/callback`, response);
  }

  async editOriginalInteractionResponse(application_id, interaction_token, response) {
    return this.makeRequest('PATCH', `/webhooks/${application_id}/${interaction_token}/messages/@original`, response);
  }

  async createGuildFromTemplate(template_code, options) {
    return this.makeRequest('POST', `/guilds/templates/${template_code}`, options);
  }

  async getTemplateInfo(template_code) {
    return this.makeRequest('GET', `/guilds/templates/${template_code}`);
  }

  async modifyGuildTemplate(guild_id, template_code, options) {
    return this.makeRequest('PATCH', `/guilds/${guild_id}/templates/${template_code}`, options);
  }

  async setSlowMode(channel_id, seconds) {
    return this.makeRequest('PATCH', `/channels/${channel_id}`, {
      rate_limit_per_user: seconds
    });
  }

  async removeSlowMode(channel_id) {
    return this.setSlowMode(channel_id, 0);
  }

  async getGuildBoosts(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/premium/subscriptions`);
  }

  async getBoostLevel(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/premium/tier`);
  }

  async getWelcomeScreen(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/welcome-screen`);
  }

  async modifyWelcomeScreen(guild_id, options) {
    return this.makeRequest('PATCH', `/guilds/${guild_id}/welcome-screen`, options);
  }

  async getGuildInsights(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/insights`);
  }

  async getGuildPreview(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/preview`);
  }

  async getVanityURL(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/vanity-url`);
  }

  async modifyVanityURL(guild_id, code) {
    return this.makeRequest('PATCH', `/guilds/${guild_id}/vanity-url`, { code });
  }

  /**
   * Function to clean temporary storage, suitable for execution when the process exits or a crash occurs.
   */
  cleanup() {
    this._messages.migrateSync?.(); // save message data in memory to disk
    this._messages._start = false; // prevent infinite loop
    this.#removable.forEach(f => fsS.rmSync(f)); // delete temporary files
    fsS.rmSync(Discord.CACHE_PATH, { recursive: true }); // delete temporary cache directory
  }
}

class MessageCache {
  constructor(path = '', age = 30000) {
    this._dbPath = path;
    this._dbAge = age;
    this._storage = new Map();

    this.#init();
    this.#startCollector();
  }

  add(message) {
    const data = {
      update: Date.now(),
      origin: message
    }
    return this._storage.set(this.#keyHelper(message.channel_id, message.id), data);
  }

  get(channel_id, message_id) {
    const key = this.#keyHelper(channel_id, message_id);
    const target = this._dbPath ? join(this._dbPath, channel_id, message_id + '.json') : null;
    if (this._storage.has(key)) {
      return this._storage.get(key).origin;
    } else if (target && fsS.existsSync(target)) {
      return fsS.readFileSync(target);
    }
  }

  clear() {
    this._storage.clear();
    if (this._dbPath && fsS.existsSync(this._dbPath)) fsS.rmSync(this._dbPath, { recursive: true });
  }

  load(path) {
    if (!path) return;
    const lists_a = fsS.readdirSync(path).map(d => join(path, d));
    for (let i = 0; i < lists_a.length; i++) {
      const lists_b = fsS.readdirSync(lists_a[i]).filter(f => f.endsWith('.json')).map(f => join(lists_a[i], f));
      for (let j = 0; j < lists_b.length; j++) {
        const message = JSON.parse(fsS.readFileSync(lists_b[j]));
        this.add(message);
      }
    }
  }

  setPath(path) {
    this.load(this._dbPath); // refresh
    this._dbPath = path;
  }

  #keyHelper(channel_id, message_id) {
    return `${channel_id}:${message_id}`;
  }

  #init() {
    if (fsS.existsSync(this._dbPath)) load(this._dbPath);
    if (this._dbPath) fsS.mkdirSync(this._dbPath, { recursive: true });
  }

  async #migrate() {
    for (const [key, value] of this._storage.entries()) {
      if (!value) {
        this._storage.delete(key);
        continue;
      }
      if (Date.now() - value.update > this._dbAge && this._dbPath) {
        const target = join(this._dbPath, value.origin.channel_id, value.origin.id + '.json');
        try {
          await fs.mkdir(dirname(target), { recursive: true });
          await fs.writeFile(target, JSON.stringify(value.origin));
          this._storage.delete(key);
        } catch (error) {
          console.error(error.message);
          this._dbPath = '';
        }
      }
    }
  }

  migrateSync() {
    const entries = [...this._storage.entries()];
    for (const [key, value] of entries) {
      if (!value) {
        this._storage.delete(key);
        continue;
      }
      if (Date.now() - value.update > this._dbAge && this._dbPath) {
        const target = join(this._dbPath, value.origin.channel_id, value.origin.id + '.json');
        try {
          fsS.mkdirSync(dirname(target), { recursive: true });
          fsS.writeFileSync(target, JSON.stringify(value.origin));
          this._storage.delete(key);
        } catch {
          console.error(error.message);
          this._dbPath = '';
        }
      }
    }
  }

  async #startCollector() {
    this._start = true;
    while (this._start) {
      await this.#migrate();
      await sleep(500);
    }
  }
}

export default Discord;
