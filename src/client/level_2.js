import { setTimeout as sleep } from 'node:timers/promises';
import level1 from './level_1.js';

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
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        'Authorization': `Bot ${this.token}`,
        'Content-Type': 'application/json',
        ...headers
      }
    };
    const targetUrl = BASE_URL + endpoint;

    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        const res = await fetch(targetUrl, options);
        const buffer = await res.arrayBuffer();
        let data;
        try {
          data = JSON.parse(Buffer.from(buffer));
        } catch {
          data = Buffer.from(buffer);
        }

        if (res.ok) return data;
        throw data;
      } catch (err) {
        if (err?.retry_after) {
          await sleep(err.retry_after * 1000);
          continue; // Retry after sleep
        }
        if (err?.cause?.name !== 'ConnectTimeoutError' && i === MAX_RETRIES - 1) {
          throw err;
        }
      }
    }
    throw new Error(`Request failed after ${MAX_RETRIES} attempt(s)`);
  }

  async _cacheableGet(endpoint) {
    let cached = await this.store.get(endpoint);
    if (!cached) {
      cached = await this.makeRequest('GET', endpoint);
      await this.store.set(endpoint, cached, true);
    }

    return cached;
  }

  async getUser(id) {
    return this._cacheableGet(`/users/${id}`);
  }

  async getMessage(channel_id, message_id) {
    const msg = await this._cacheableGet(`/channels/${channel_id}/messages/${message_id}`);
    this.store.set(`${channel_id}:${message_id}`, msg);
    return msg;
  }

  async getMessages(channel_id, options = {}) {
    const params = new URLSearchParams(options);
    return this.makeRequest('GET', `/channels/${channel_id}/messages?${params}`);
  }

  async sendTyping(channel_id) {
    return this.makeRequest('POST', `/channels/${channel_id}/typing`);
  }

  async editMessage(message, content, options = {}) {
    if (message.isInteractionResponse) {
      return this.editOriginalInteractionResponse(this._session.application.id, message.interactionToken, { content, ...options });
    }
    const { id, channel_id } = message;
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

  async deleteMessage(channel_id, id) {
    return this.makeRequest('DELETE', `/channels/${channel_id}/messages/${id}`);
  }

  async bulkDeleteMessages(channel_id, messages) {
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

  async getGuild(guild_id, options = {}) {
    const params = new URLSearchParams(options);
    return this._cacheableGet(`/guilds/${guild_id}?${params}`);
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
    const headers = reason ? { 'X-Audit-Log-Reason': reason } : {};
    return this.makeRequest('DELETE', `/guilds/${guild_id}/members/${user_id}`, null, headers);
  }

  async banMember(guild_id, user_id, options = {}) {
    let { reason, ...body } = options;
    const headers = reason ? { 'X-Audit-Log-Reason': reason } : {};
    return this.makeRequest('PUT', `/guilds/${guild_id}/bans/${user_id}`, body, headers);
  }

  async unbanMember(guild_id, user_id, reason) {
    const headers = reason ? { 'X-Audit-Log-Reason': reason } : {};
    return this.makeRequest('DELETE', `/guilds/${guild_id}/bans/${user_id}`, null, headers);
  }

  async muteMember(guild_id, user_id, duration = 0, reason) {
    const timeoutUntil = new Date(Date.now() + duration).toISOString();
    const headers = reason ? { 'X-Audit-Log-Reason': reason } : {};
    return this.makeRequest('PATCH', `/guilds/${guild_id}/members/${user_id}`, { communication_disabled_until: timeoutUntil }, headers);
  }

  async unmuteMember(guild_id, user_id, reason) {
    const headers = reason ? { 'X-Audit-Log-Reason': reason } : {};
    return this.makeRequest('PATCH', `/guilds/${guild_id}/members/${user_id}`, { communication_disabled_until: null }, headers);
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

  async getReactions(channel_id, message_id, emoji, options = {}) {
    const params = new URLSearchParams(options);
    return this.makeRequest('GET', `/channels/${channel_id}/messages/${message_id}/reactions/${encodeURIComponent(emoji)}?${params}`);
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

  async getGuildEmojis(guild_id) {
    return this._cacheableGet(`/guilds/${guild_id}/emojis`);
  }

  async createEmoji(guild_id, options = {}) {
    return this.makeRequest('POST', `/guilds/${guild_id}/emojis`, options);
  }

  async deleteEmoji(guild_id, emoji_id) {
    return this.makeRequest('DELETE', `/guilds/${guild_id}/emojis/${emoji_id}`);
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

  async getGuildAuditLog(guild_id, options = {}) {
    const params = new URLSearchParams(options);
    return this.makeRequest('GET', `/guilds/${guild_id}/audit-logs?${params}`);
  }

  async createDM(recipient_id) {
    return this.makeRequest('POST', '/users/@me/channels', { recipient_id });
  }

  async setSlowMode(channel_id, seconds) {
    return this.editChannel(channel_id, { rate_limit_per_user: seconds });
  }

  async executeWebhook(webhook_id, webhook_token, options = {}, wait = false) {
    let endpoint = `/webhooks/${webhook_id}/${webhook_token}`;
    if (wait) endpoint += '?wait=true';
    return this.makeRequest('POST', endpoint, options);
  }

  async getGuildApplicationCommands(application_id, guild_id) {
    return this._cacheableGet(`/applications/${application_id}/guilds/${guild_id}/commands`);
  }

  async createGuildApplicationCommand(application_id, guild_id, options) {
    return this.makeRequest('POST', `/applications/${application_id}/guilds/${guild_id}/commands`, options);
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

  async createStageInstance(channel_id, options = {}) {
    return this.makeRequest('POST', '/stage-instances', { channel_id, ...options });
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

  async moveUser(guild_id, user_id, channel_id) {
    return this.modifyGuildMember(guild_id, user_id, { channel_id });
  }

  async setUserVoiceState(guild_id, user_id, options = {}) {
    return this.modifyGuildMember(guild_id, user_id, { mute: options.mute, deaf: options.deaf });
  }

  async createCategory(guild_id, name) {
    return this.createChannel(guild_id, { name, type: 4 });
  }

  async moveChannelToCategory(channel_id, category_id) {
    return this.editChannel(channel_id, { parent_id: category_id });
  }

  async setChannelNSFW(channel_id, nsfw) {
    return this.editChannel(channel_id, { nsfw });
  }

  async getArchivedThreads(channel_id, options = {}) {
    const params = new URLSearchParams(options);
    return this.makeRequest('GET', `/channels/${channel_id}/threads/archived/public?${params}`);
  }

  async followNewsChannel(channel_id, webhook_channel_id) {
    return this.makeRequest('POST', `/channels/${channel_id}/followers`, { webhook_channel_id });
  }

  async getWelcomeScreen(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/welcome-screen`);
  }

  async modifyWelcomeScreen(guild_id, options) {
    return this.makeRequest('PATCH', `/guilds/${guild_id}/welcome-screen`, options);
  }

  async getVanityURL(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/vanity-url`);
  }

  async modifyVanityURL(guild_id, code) {
    return this.makeRequest('PATCH', `/guilds/${guild_id}/vanity-url`, { code });
  }

  async getApplicationRoleConnections(application_id) {
    return this.makeRequest('GET', `/applications/${application_id}/role-connections/metadata`);
  }

  async updateApplicationRoleConnections(application_id, metadata) {
    return this.makeRequest('PUT', `/applications/${application_id}/role-connections/metadata`, metadata);
  }

  async createForumPost(channel_id, options = {}) {
    return this.createThread(channel_id, { ...options, type: 11 });
  }

  async getDiscoveryCategories() {
    return this.makeRequest('GET', '/discovery/categories');
  }

  async updateDiscoveryMetadata(guild_id, options = {}) {
    return this.makeRequest('PATCH', `/guilds/${guild_id}/discovery-metadata`, options);
  }

  async getDiscoveryValidationInfo(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/discovery-metadata/validation`);
  }

  async getGuildBoosts(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/premium/subscriptions`);
  }

  async getBoostLevel(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/premium/tier`);
  }

  async getGuildInsights(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/insights`);
  }

  async createGuildFromTemplate(template_code, options = {}) {
    return this.makeRequest('POST', `/guilds/templates/${template_code}`, options);
  }

  async getTemplateInfo(template_code) {
    return this.makeRequest('GET', `/guilds/templates/${template_code}`);
  }

  async modifyGuildTemplate(guild_id, template_code, options = {}) {
    return this.makeRequest('PATCH', `/guilds/${guild_id}/templates/${template_code}`, options);
  }

  async getGuildIntegrations(guild_id) {
    return this.makeRequest('GET', `/guilds/${guild_id}/integrations`);
  }

  async deleteGuildIntegration(guild_id, integration_id) {
    return this.makeRequest('DELETE', `/guilds/${guild_id}/integrations/${integration_id}`);
  }
}

export default DiscordClient;
