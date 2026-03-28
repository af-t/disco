import level1 from './level_1.js';
import fs from 'node:fs';

const BASE_URL = 'https://discord.com/api/v10';
const MAX_RETRIES = 3;

class DiscordClient extends level1 {
  constructor(...args) {
    super(...args);
  }

  async makeRequest(method, endpoint, body, headers = {}) {
    if (!this._initialised) throw new Error('call ready() first');

    const options = {
      method,
      body: (() => {
        try {
          body = JSON.parse(body);
        } finally {
          return body;
        }
      })(),
      headers: {
        'Authorization': `Bot ${this.token}`,
        'Content-Type': 'application/json',
        ...headers
      }
    };
    const targetUrl = BASE_URL + endpoint;

    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        const res  = await fetch(targetUrl, options);
        let data   = Buffer.from(await res.arrayBuffer());
        try {
          data = JSON.parse(data);
        } finally {
          if (res.ok) return data;
          throw data;
        }
      } catch (err) {
        if (err?.retry_delay) {
          await sleep(err.retry_delay * 1000);
        } else
        if (err?.cause?.name !== 'ConnectTimeoutError') {
          throw err;
        }
      }
    }
    throw new Error(`Request failed after ${MAX_RETRIES} attempt(s)`);
  }

  async _cacheableGet(endpoint) {
    let cached = await this._store.get(endpoint);
    if (!cached) {
      cached = await this.makeRequest('GET', endpoint);
      await this._store.set(endpoint, cached, true);
    }

    return cached;
  }

  async getUser(id) {
    return this._cacheableGet(`/users/${id}`);
  }

  async getMessage(channel_id, message_id, useFetch = false) {
    if (useFetch) {
      const msg = await this._cacheableGet(`/channels/${channel_id}/messages/${message_id}`);
      // update stored message data
      await this._store.set(`${channel_id}:${id}`, msg);

      return msg;
    }
    return this._store.get(`${channel_id}:${id}`);
  }

  async getMessages(channel_id) {
    return this.makeRequest('GET', `/channels/${channel_id}/messages`);
  }

  async sendTyping(channel_id) {
    return this.makeRequest('POST', `/channels/${channel_id}/typing`);
  }

  async editMessage({ id, channel_id }, content, options = {}) {
    return this.makeRequest('PATCH', `/channels/${channel_id}/messages/${id}`, { content, ...options });
  }

  async editChannel(channel_id, options = {}) {
    return this.makeRequest('PATCH', `/channels/${channel_id}`, options);
  }

  async editChannelPermission(channel_id, overwrite_id, options = {}) {
    return this.makeRequest('PATCH', `/channels/${channel_id}/permissions/${overwrite_id}`, options);
  }

  async editChannelWebhook(channel_id, webhook_id, options = {}) {
    return this.makeRequest('PATCH', `/channels/${channel_id}/webhooks/${webhook_id}`, options);
  }

  async editChannelPosition(channel_id, position) {
    return this.editChannel(channel_id, { position });
  }

  async editChannelTopic(channel_id, topic) {
    return this.editChannel(channel_id, { topic });
  }

  async deleteMessage(id, channel_id) {
    return this.makeRequest('DELETE', `/channels/${channel_id}/messages/${id}`);
  }

  async bulkDeleteMessages(messages, channel_id) {
    return this.makeRequest('POST', `/channels/${channel_id}/messages/bulk-delete`, { messages });
  }

  async createChannel(guild_id, options = {}) {
    return this.makeRequest('POST', `/guilds/${guild_id}/channels`, options);
  }

  async deleteChannel(channel_id) {
    return this.makeRequest('DELETE', `/channels/${channel_id}`);
  }

  async getChannel(channel_id) {
    return this._cacheableGet(`/channels/${channel_id}`);
  }

  async getChannels(guild_id) {
    return this._cacheableGet(`/guilds/${guild_id}/channels`);
  }

  async getGuild(guild_id) {
    return this._cacheableGet(`/guilds/${guild_id}`);
  }

  async getGuildPreview(guild_id) {
    return this._cacheableGet(`/guilds/${guild_id}/preview`);
  }

  async modifyGuild(guild_id, options = {}) {
    return this.makeRequest('PATCH', `/guilds/${guild_id}`, options);
  }

  async createWebhook(channel_id, options = {}) {
    return this.makeRequest('POST', `/channels/${channel_id}/webhooks`, options);
  }

  async getChannelWebhooks(channel_id) {
    return this._cacheableGet(`/channels/${channel_id}/webhooks`);
  }

  async getGuildWebhooks(guild_id) {
    return this._cacheableGet(`/guilds/${guild_id}/webhooks`);
  }

  async getWebhook(webhook_id) {
    return this._cacheableGet(`/webhooks/${webhook_id}`);
  }

  async getRoles(guild_id) {
    return this._cacheableGet(`/guilds/${guild_id}/roles`);
  }

  async createRole(guild_id, options = {}) {
    return this.makeRequest('POST', `/guilds/${guild_id}/roles`, options);
  }

  async editRole(guild_id, role_id, options = {}) {
    return this.makeRequest('PATCH', `/guilds/${guild_id}/roles/${role_id}`, options);
  }

  async deleteRole(guild_id, role_id) {
    return this.makeRequest('DELETE', `/guilds/${guild_id}/roles/${role_id}`);
  }

  async getGuildMember(guild_id, user_id) {
    return this._cacheableGet(`/guilds/${guild_id}/members/${user_id}`);
  }

  async getGuildMembers(guild_id, options = {}) {
    const params = new URLSearchParams(options);
    return this._cacheableGet(`/guilds/${guild_id}/members?${params}`);
  }

  async kickMember(guild_id, user_id, reason) {
    return this.makeRequest('DELETE', `/guilds/${guild_id}/members/${user_id}`, { reason });
  }

  async addGuildMember(guild_id, user_id, options = {}) {
    return this.makeRequest('PUT', `/guilds/${guild_id}/members/${user_id}`, options);
  }

  async modifyGuildMember(guild_id, user_id, options = {}) {
    return this.makeRequest('PATCH', `/guilds/${guild_id}/members/${user_id}`, options);
  }

  async addRoleToMember(guild_id, user_id, role_id) {
    return this.makeRequest('PUT', `/guilds/${guild_id}/members/${user_id}/roles/${role_id}`);
  }

  async removeRoleFromMember(guild_id, user_id, role_id) {
    return this.makeRequest('DELETE', `/guilds/${guild_id}/members/${user_id}/roles/${role_id}`);
  }

  async getGlobalCommands(application_id) {
    return this._cacheableGet(`/applications/${application_id}/commands`);
  }

  async createGlobalCommand(application_id, body) {
    return this.makeRequest('POST', `/applications/${application_id}/commands`, body);
  }

  async deleteGlobalCommand(application_id, command_id) {
    return this.makeRequest('DELETE', `/applications/${application_id}/commands/${command_id}`);
  }

  async createInteractionResponse(interaction_id, interaction_token, body) {
    return this.makeRequest(
      'POST',
      `/interactions/${interaction_id}/${interaction_token}/callback`,
      body
    );
  }

  async editOriginalInteractionResponse(application_id, interaction_token, body) {
    return this.makeRequest(
      'PATCH',
      `/webhooks/${application_id}/${interaction_token}/messages/@original`,
      body
    );
  }

  async followupMessage(application_id, interaction_token, body) {
    return this.makeRequest(
      'POST',
      `/webhooks/${application_id}/${interaction_token}`,
      body
    );
  }

  async sendMessage(channel_id, content, options = {}) {
    return this.makeRequest('POST', `/channels/${channel_id}/messages`, {
      content,
      ...options
    });
  }

  async crosspostMessage(channel_id, message_id) {
    return this.makeRequest('POST', `/channels/${channel_id}/messages/${message_id}/crosspost`);
  }

  async addReaction(channel_id, message_id, emoji) {
    return this.makeRequest('PUT', `/channels/${channel_id}/messages/${message_id}/reactions/${encodeURIComponent(emoji)}/@me`);
  }

  async removeReaction(channel_id, message_id, emoji, user_id) {
    return this.makeRequest('DELETE', `/channels/${channel_id}/messages/${message_id}/reactions/${encodeURIComponent(emoji)}/${user_id}`);
  }

  async getReactions(channel_id, message_id, emoji) {
    return this.makeRequest('GET', `/channels/${channel_id}/messages/${message_id}/reactions/${encodeURIComponent(emoji)}`);
  }

  async removeAllReactions(channel_id, message_id) {
    return this.makeRequest('DELETE', `/channels/${channel_id}/messages/${message_id}/reactions`);
  }

  async getGuildStickers(guild_id) {
    return this._cacheableGet(`/guilds/${guild_id}/stickers`);
  }

  async createGuildSticker(guild_id, options = {}) {
    return this.makeRequest('POST', `/guilds/${guild_id}/stickers`, options);
  }

  async deleteGuildSticker(guild_id, sticker_id) {
    return this.makeRequest('DELETE', `/guilds/${guild_id}/stickers/${sticker_id}`);
  }

  async createInvite(channel_id, options = {}) {
    return this.makeRequest('POST', `/channels/${channel_id}/invites`, options);
  }

  async getInvite(code) {
    return this.makeRequest('GET', `/invites/${code}`);
  }

  async deleteInvite(code) {
    return this.makeRequest('DELETE', `/invites/${code}`);
  }

  async getGuildInvites(guild_id) {
    return this._cacheableGet(`/guilds/${guild_id}/invites`)
  }

  async createThread(channel_id, options = {}) {
    return this.makeRequest('POST', `/channels/${channel_id}/threads`, options);
  }

  async joinThread(thread_id) {
    return this.makeRequest('PUT', `/channels/${thread_id}/thread-members/@me`);
  }

  async leaveThread(thread_id) {
    return this.makeRequest('DELETE', `/channels/${thread_id}/thread-members/@me`);
  }

  async getThreads(channel_id) {
    return this.makeRequest('GET', `/channels/${channel_id}/threads/active`);
  }

  async getThreadMembers(thread_id) {
    return this.makeRequest('GET', `/channels/${thread_id}/thread-members`);
  }

  async getGuildIntegrations(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/integrations`);
  }

  async deleteGuildIntegration(guild_id, integration_id) {
    return this.makeRequest('DELETE', `/guilds/${guild_id}/integrations/${integration_id}`);
  }
}

export default DiscordClient;
