const fs = require('fs').promises;
const https = require('https');
const { basename } = require('path');

// environment
let reqTimeout = 30000;
let token;

const getFileInfo = async (fileObj) => {
    if (typeof fileObj === 'string') {
        if (fileObj.startsWith('http://') || fileObj.startsWith('https://')) {
            try {
                const response = await fetch(fileObj);
                const buffer = await response.arrayBuffer();
                return {
                    file_name: basename(URL.parse(fileObj).pathname),
                    file_size: buffer.byteLength,
                    file_data: Buffer.from(buffer)
                };
            } catch {
                console.warn(`Can't download: ${fileObj}`);
                return;
            }
        } else {
            const stats = await fs.stat(fileObj);
            const data = await fs.readFile(fileObj);
            return {
                file_name: basename(fileObj),
                file_size: stats.size,
                file_data: data
            };
        }
    } else if (fileObj instanceof Object) {
        if (fileObj.path) {
            const stats = await fs.stat(fileObj.path);
            const data = await fs.readFile(fileObj.path);
            return {
                file_name: fileObj.name || fileObj.filename || basename(fileObj.path),
                file_size: stats.size,
                file_data: data
            };
        } else if (fileObj.url) {
            const response = await fetch(fileObj.url);
            const buffer = await response.arrayBuffer();
            return {
                file_name: fileObj.name || fileObj.filename || basename(new URL(fileObj.url).pathname),
                file_size: buffer.byteLength,
                file_data: Buffer.from(buffer)
            };
        } else if ('file_name' in fileObj && 'file_data' in fileObj) return Object.assign(fileObj, { file_size: fileObj.file_data.length });
    }
};

const makeRequest = async (method, endpoint, body = null, headers = {}) => {
    return new Promise((resolve, reject) => {
        const options = {
            method,
            hostname: 'discord.com',
            path: `/api/v10${endpoint}`,
            headers: {
                'Authorization': `Bot ${token}`,
                'Content-Type': 'application/json',
                ...headers
            },
            timeout: reqTimeout
        };

        const req = https.request(options, (res) => {
            let data = Buffer.alloc(0);
            res.on('data', (chunk) => data = Buffer.concat([data,chunk]));
            res.on('end', () => {
                let parsed = data;
                try {
                    parsed = JSON.parse(data);
                } catch {}

                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(parsed);
                } else {
                    reject(parsed);
                }
            });
        });

        req.on('error', (error) => {
            req.destroy();
            reject(error);
        });
        req.on('timeout', () => reject(new Error('Request timed out')));

        if (body) req.write(JSON.stringify(body));
        req.end();
    });
};


class Client extends require('./gateway') {
    constructor() {
        super(...arguments);

        token = this._token;

        Object.defineProperties(this, {
            "_timeout": {
                enumerable: true,
                get() {
                    return reqTimeout;
                },
                set(value) {
                    value = Number(value);
                    if (!Number.isNaN(value)) reqTimeout = value;
                }
            },
            "_token": {
                enumerable: true,
                get() {
                    return token;
                },
                set(value) {
                    token = value;
                }
            }
        });
    }

    /**
     * Get information about a channel.
     * @param {string} channelId The ID of the channel.
     * @returns {Promise<object>} The channel object.
     */
    async getChannelInfo(channelId) {
        return makeRequest('GET', `/channels/${channelId}`);
    }

    /**
     * Get information about a user.
     * @param {string} userId The ID of the user.
     * @returns {Promise<object>} The user object.
     */
    async getUserInfo(userId) {
        return makeRequest('GET', `/users/${userId}`);
    }

    /**
     * Get information about a guild.
     * @param {string} guildId The ID of the guild.
     * @returns {Promise<object>} The guild object.
     */
    async getGuildInfo(guildId) {
        return makeRequest('GET', `/guilds/${guildId}`);
    }

    /**
     * Get information about a guild member.
     * @param {string} guildId The ID of the guild.
     * @param {string} userId The ID of the user.
     * @returns {Promise<object>} The guild member object.
     */
    async getGuildMemberInfo(guildId, userId) {
        return makeRequest('GET', `/guilds/${guildId}/members/${userId}`);
    }

    /**
     * Get information about a guild member.
     * This is an alias for the `getGuildMemberInfo` method.
     * @param {string} guildId The ID of the guild.
     * @param {string} userId The ID of the user.
     * @returns {Promise<object>} The guild member object.
     */
    async getMemberInfo(...args) {
        return this.getGuildMemberInfo(...args);
    }


    /**
     * Load a message.
     * @param {string} channel_id The channel ID.
     * @param {string} id The message ID.
     * @returns {Promise<object>} The message object.
     */
    async loadMessage(channel_id, id) {
        return makeRequest('GET', `/channels/${channel_id}/messages/${id}`);
    }

    /**
     * Load a message.
     * This is an alias for the `loadMessage` method.
     * @param {string} channel_id The channel ID.
     * @param {string} id The message ID.
     * @returns {Promise<object>} The message object.
     */
    async getMessage(...args) {
        return this.loadMessage(...args);
    }

    /**
     * Update a message.
     * @param {{channel_id: string, id: string}} param0 The channel and message ID.
     * @param {object} update The update object.
     * @returns {Promise<object>} The updated message object.
     */
    async editMessage({channel_id, id}, content, options = {}) {
        return makeRequest('PATCH', `/channels/${channel_id}/messages/${id}`, { content, ...options });
    }

    /**
     * Send a message to a channel.
     * @param {string} channelId The ID of the channel to send the message to.
     * @param {string} content The content of the message.
     * @param {object} options The options for the message.
     * @returns {Promise<object>} The message object.
     */
    async sendMessage(channelId, content, options = {}) {
        return makeRequest('POST', `/channels/${channelId}/messages`, { content, ...options });
    }

    /**
     * Reply to a message.
     * @param {{channel_id: string, id: string}} param0 The channel and message ID.
     * @param {string} content The content of the message.
     * @param {boolean} mention Whether to mention the user.
     * @returns {Promise<object>} The message object.
     */
    async reply({channel_id, id}, content, mention = false) {
        return this.sendMessage(channel_id, content, { message_reference: { channel_id, message_id: id }, ...(mention ? {} : { allowed_mentions: {} }) });
    }

    /**
     * Edit a channel.
     * @param {string} channelId The channel ID.
     * @param {object} options The options to edit the channel with.
     * @returns {Promise<object>} The updated channel object.
     */
    async editChannel(channelId, options = {}) {
        return makeRequest('PATCH', `/channels/${channelId}`, options);
    }

    /**
     * Edit channel permissions.
     * @param {string} channelId The channel ID.
     * @param {string} overwriteId The overwrite ID.
     * @param {object} options The options to edit the channel permissions with.
     * @returns {Promise<object>} The updated channel permissions object.
     */
    async editChannelPermissions(channelId, overwriteId, options = {}) {
        return makeRequest('PATCH', `/channels/${channelId}/permissions/${overwriteId}`, options);
    }

    /**
     * Edit channel webhooks.
     * @param {string} channelId The channel ID.
     * @param {string} webhookId The webhook ID.
     * @param {object} options The options to edit the channel webhooks with.
     * @returns {Promise<object>} The updated channel webhooks object.
     */
    async editChannelWebhooks(channelId, webhookId, options = {}) {
        return makeRequest('PATCH', `/channels/${channelId}/webhooks/${webhookId}`, options);
    }

    /**
     * Edit channel position.
     * @param {string} channelId The channel ID.
     * @param {number} position The new position of the channel.
     * @returns {Promise<object>} The updated channel position object.
     */
    async editChannelPosition(channelId, position) {
        return makeRequest('PATCH', `/channels/${channelId}`, { position });
    }

    /**
     * Edit channel topic.
     * @param {string} channelId The channel ID.
     * @param {string} topic The new topic of the channel.
     * @returns {Promise<object>} The updated channel topic object.
     */
    async editChannelTopic(channelId, topic) {
        return makeRequest('PATCH', `/channels/${channelId}`, { topic });
    }

    /**
     * Upload files to a channel.
     * @param {string} channelId The channel ID.
     * @param {string} content The message content.
     * @param {Array<string|object>} files An array of file paths or objects.
     * @param {object} options Optional parameters.
     * @returns {Promise<object>} The message object.
     */
    async uploadFiles(channelId, content, files, options = {}) {
        const fileInfos = (await Promise.all(files.map(file => getFileInfo(file)))).filter(o => o);
        const attachments = await makeRequest('POST', `/channels/${channelId}/attachments`, { files: fileInfos.map(f => ({ filename: f.file_name, file_size: f.file_size })) });

        for (let i = 0; i < attachments.attachments.length; i++) await new Promise((resolve, reject) => {
            const attachment = attachments.attachments[i];;
            const req = https.request(attachment.upload_url, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': fileInfos[i].file_data.length
                }
            }, (res) => {
                res.on('data', () => {});
                res.on("end", () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve();
                    } else {
                        reject(new Error(`HTTP Error: ${res.statusCode}`));
                    }
                });
            });
            req.on('error', reject);
            req.write(fileInfos[i].file_data);
            req.end();
        });

        return makeRequest('POST', `/channels/${channelId}/messages`, {
            ...options,
            content,
            attachments: attachments.attachments.map((item, index) => ({
                id: index,
                filename: fileInfos[index].file_name,
                uploaded_filename: item.upload_filename
            }))
        });
    }

    /**
     * Create a new channel in a guild.
     * @param {string} guildId - The ID of the guild.
     * @param {string} name - The name of the channel.
     * @param {string} type - The type of channel.
     * @param {object} options - Additional options for the channel.
     * @returns {Promise<object>} - A promise that resolves with the created channel object.
     */
    async createChannel(guildId, name, type, options = {}) {
        return makeRequest('POST', `/guilds/${guildId}/channels`, {
            name,
            type,
            ...options
        });
    }

    /**
     * Deletes a channel.
     * @param {string} channelId - The ID of the channel to delete.
     * @returns {Promise} 
     */
    async deleteChannel(channelId) {
        return makeRequest('DELETE', `/channels/${channelId}`);
    }

    
    /**
     * Get a list of channels in a guild.
     * @param {string} guildId - The ID of the guild.
     * @returns {Promise<object[]>} - A promise that resolves with an array of channel objects.
     */
    async getGuildChannels(guildId) {
        return makeRequest('GET', `/guilds/${guildId}/channels`);
    }

    /**
     * Create a new role in a guild.
     * @param {string} guildId - The ID of the guild.
     * @param {object} options - Options for the new role.
     * @returns {Promise<object>} - A promise that resolves with the created role object.
     */
    async createRole(guildId, options = {}) {
        return makeRequest('POST', `/guilds/${guildId}/roles`, options);
    }

    /**
     * Edits a role in a guild.
     * @param {string} guildId - The ID of the guild.
     * @param {string} roleId - The ID of the role to edit.
     * @param {object} options - Options for editing the role.
     * @returns {Promise}
     */
    async editRole(guildId, roleId, options = {}) {
        return makeRequest('PATCH', `/guilds/${guildId}/roles/${roleId}`, options);
    }

    /**
     * Deletes a role from a guild.
     * @param {string} guildId - The ID of the guild.
     * @param {string} roleId - The ID of the role to delete.
     * @returns {Promise}
     */
    async deleteRole(guildId, roleId) {
        return makeRequest('DELETE', `/guilds/${guildId}/roles/${roleId}`);
    }

    /**
     * Gets a list of roles in a guild.
     * @param {string} guildId - The ID of the guild.
     * @returns {Promise}
     */
    async getGuildRoles(guildId) {
        return makeRequest('GET', `/guilds/${guildId}/roles`);
    }

    /**
     * Adds a role to a member.
     * @param {string} guildId - The ID of the guild.
     * @param {string} userId - The ID of the member.
     * @param {string} roleId - The ID of the role to add.
     * @returns {Promise}
     */
    async addMemberRole(guildId, userId, roleId) {
        return makeRequest('PUT', `/guilds/${guildId}/members/${userId}/roles/${roleId}`);
    }

    /**
     * Removes a role from a member.
     * @param {string} guildId - The ID of the guild.
     * @param {string} userId - The ID of the member.
     * @param {string} roleId - The ID of the role to remove.
     * @returns {Promise}
     */
    async removeMemberRole(guildId, userId, roleId) {
        return makeRequest('DELETE', `/guilds/${guildId}/members/${userId}/roles/${roleId}`);
    }

    /**
     * Adds a reaction to a message.
     * @param {string} channelId - The ID of the channel the message is in.
     * @param {string} messageId - The ID of the message.
     * @param {string} emoji - The emoji to add.
     * @returns {Promise}
     */
    async addReaction(channelId, messageId, emoji) {
        return makeRequest('PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
    }

    /**
     * Removes a reaction from a message.
     * @param {string} channelId - The ID of the channel the message is in.
     * @param {string} messageId - The ID of the message.
     * @param {string} emoji - The emoji to remove.
     * @param {string} userId - The ID of the user who added the reaction.
     * @returns {Promise}
     */
    async removeReaction(channelId, messageId, emoji, userId = '@me') {
        return makeRequest('DELETE', `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/${userId}`);
    }

    /**
     * Gets a list of users who reacted to a message with a specific emoji.
     * @param {string} channelId - The ID of the channel the message is in.
     * @param {string} messageId - The ID of the message.
     * @param {string} emoji - The emoji to get reactions for.
     * @returns {Promise}
     */
    async getReactions(channelId, messageId, emoji) {
        return makeRequest('GET', `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
    }


    /**
     * Create a webhook.
     * @param {string} channelId The ID of the channel.
     * @param {string} name The name of the webhook.
     * @param {object} options The options to create the webhook with.
     * @returns {Promise<object>} The webhook object.
     */
    async createWebhook(channelId, name, options = {}) {
        return makeRequest('POST', `/channels/${channelId}/webhooks`, {
            name,
            ...options
        });
    }

    /**
     * Execute a webhook.
     * @param {string} webhookId The ID of the webhook.
     * @param {string} webhookToken The token of the webhook.
     * @param {object} options The options to execute the webhook with.
     * @returns {Promise<object>} The webhook object.
     */
    async executeWebhook(webhookId, webhookToken, options = {}) {
        return makeRequest('POST', `/webhooks/${webhookId}/${webhookToken}`, options);
    }

    /**
     * Get a list of bans for a guild.
     * @param {string} guildId The ID of the guild.
     * @returns {Promise<object>} The list of bans.
     */
    async getBans(guildId) {
        return makeRequest('GET', `/guilds/${guildId}/bans`);
    }

    /**
     * Ban a member from a guild.
     * @param {string} guildId The ID of the guild.
     * @param {string} userId The ID of the user.
     * @param {object} options The options to ban the member with.
     * @returns {Promise<object>} The ban object.
     */
    async banMember(guildId, userId, reason = "") {
        return makeRequest('PUT', `/guilds/${guildId}/bans/${userId}`, { reason });
    }

    /**
     * Unban a member from a guild.
     * @param {string} guildId The ID of the guild.
     * @param {string} userId The ID of the user.
     * @returns {Promise<object>} The unban object.
     */
    async unbanMember(guildId, userId) {
        return makeRequest('DELETE', `/guilds/${guildId}/bans/${userId}`);
    }

    /**
     * Kick a member from a guild.
     * @param {string} guildId The ID of the guild.
     * @param {string} userId The ID of the user.
     * @param {string} reason The reason for kicking the member.
     * @returns {Promise<object>} The kick object.
     */
    async kickMember(guildId, userId, reason = '') {
        return makeRequest('DELETE', `/guilds/${guildId}/members/${userId}`, { reason });
    }

    /**
     * Mute a member in a guild.
     * @param {string} guildId The ID of the guild.
     * @param {string} userId The ID of the user.
     * @param {number} duration The duration of the mute in milliseconds.
     * @returns {Promise<object>} The mute object.
     */
    async muteMember(guildId, userId, duration = 0) {
        const currentTime = Date.now();
        const timeoutUntil = new Date(currentTime + duration).toISOString();
        return makeRequest('PATCH', `/guilds/${guildId}/members/${userId}`, { communication_disabled_until: timeoutUntil });
    }

    /**
     * Unmute a member in a guild.
     * @param {string} guildId The ID of the guild.
     * @param {string} userId The ID of the user.
     * @returns {Promise<object>} The unmute object.
     */
    async unmuteMember(guildId, userId) {
        // Send a PATCH request to the Discord API to unmute the member.
        return makeRequest('PATCH', `/guilds/${guildId}/members/${userId}`, { communication_disabled_until: null });
    }


    /**
     * Get a list of invites for a guild.
     * @param {string} guildId The ID of the guild.
     * @returns {Promise<object>} The list of invites.
     */
    async getInvites(guildId) {
        return makeRequest('GET', `/guilds/${guildId}/invites`);
    }

    /**
     * Create an invite for a channel.
     * @param {string} channelId The ID of the channel.
     * @param {object} options The options to create the invite with.
     * @returns {Promise<object>} The invite object.
     */
    async createInvite(channelId, options = {}) {
        return makeRequest('POST', `/channels/${channelId}/invites`, options);
    }

    /**
     * Delete an invite.
     * @param {string} inviteCode The code of the invite.
     * @returns {Promise<object>} The deleted invite object.
     */
    async deleteInvite(inviteCode) {
        return makeRequest('DELETE', `/invites/${inviteCode}`);
    }

    /**
     * Get the audit logs for a guild.
     * @param {string} guildId The ID of the guild.
     * @param {object} options The options to get the audit logs with.
     * @returns {Promise<object>} The audit logs object.
     */
    async getAuditLogs(guildId, options = {}) {
        const queryParams = new URLSearchParams(options).toString();
        return makeRequest('GET', `/guilds/${guildId}/audit-logs?${queryParams}`);
    }

    /**
     * Get the emojis for a guild.
     * @param {string} guildId The ID of the guild.
     * @returns {Promise<object>} The emojis object.
     */
    async getEmojis(guildId) {
        return makeRequest('GET', `/guilds/${guildId}/emojis`);
    }

    /**
     * Create an emoji for a guild.
     * @param {string} guildId The ID of the guild.
     * @param {string} name The name of the emoji.
     * @param {string} image The image of the emoji.
     * @param {array} roles The roles to restrict the emoji to.
     * @returns {Promise<object>} The created emoji object.
     */
    async createEmoji(guildId, name, image, roles = []) {
        return makeRequest('POST', `/guilds/${guildId}/emojis`, { name, image, roles });
    }

    /**
     * Delete an emoji from a guild.
     * @param {string} guildId The ID of the guild.
     * @param {string} emojiId The ID of the emoji.
     * @returns {Promise<object>} The deleted emoji object.
     */
    async deleteEmoji(guildId, emojiId) {
        return makeRequest('DELETE', `/guilds/${guildId}/emojis/${emojiId}`);
    }

    /**
     * Get the pinned messages for a channel.
     * @param {string} channelId The ID of the channel.
     * @returns {Promise<object>} The pinned messages object.
     */
    async getPinnedMessages(channelId) {
        return makeRequest('GET', `/channels/${channelId}/pins`);
    }

    /**
     * Pin a message to a channel.
     * @param {string} channelId The ID of the channel.
     * @param {string} messageId The ID of the message.
     * @returns {Promise<object>} The pinned message object.
     */
    async pinMessage(channelId, messageId) {
        return makeRequest('PUT', `/channels/${channelId}/pins/${messageId}`);
    }

    /**
     * Unpin a message from a channel.
     * @param {string} channelId The ID of the channel.
     * @param {string} messageId The ID of the message.
     * @returns {Promise<object>} The unpinned message object.
     */
    async unpinMessage(channelId, messageId) {
        return makeRequest('DELETE', `/channels/${channelId}/pins/${messageId}`);
    }

    /**
     * Delete a message from a channel.
     * @param {string} channelId The ID of the channel.
     * @param {string} messageId The ID of the message.
     * @returns {Promise<object>} The deleted message object.
     */
    async deleteMessage(channelId, messageId) {
        return makeRequest('DELETE', `/channels/${channelId}/messages/${messageId}`);
    }

    /**
     * Delete messages in bulk from a channel.
     * @param {string} channelId The ID of the channel.
     * @param {array} messageIds The IDs of the messages to delete.
     * @returns {Promise<object>} The deleted messages object.
     */
    async deleteMessageBulk(channelId, messageIds) {
        const res = await makeRequest('POST', `/channels/${channelId}/messages/bulk-delete`, { messages: messageIds });
        if (res.retry_after) {
            await (new Promise(resolve => setTimeout(resolve, res.retry_after * 1000)));
            return this.deleteMessageBulk(channelId, messageIds);
        }
        return res;
    }

    /**
     * Delete messages from a channel.
     * @param {string} channelId The ID of the channel.
     * @param {number} count The number of messages to delete.
     * @returns {Promise<number>} The number of deleted messages.
     */
    async purgeMessages(channelId, count) {
        if (!count || Number.isNaN(count)) return 0;

        const twoWeekMs = 14 * 24 * 60 * 60 * 1000;
        const twoWeeksAgo = Date.now() - twoWeekMs;

        let deleted = 0;
        let remain = count;

        while (remain > 0) try {
            const messages = await this.getMessages(channelId, { limit: Math.min(remain, 100) });
            if (Array.isArray(messages)) {
                let has2WeeksAgo = false;
                const messagesToDelete = messages.filter(msg => {
                    const timestamp = new Date(msg.timestamp).getTime();
                    if (timestamp > twoWeeksAgo) return true;
                    else has2WeeksAgo = true;
                });

                if (messagesToDelete.length > 1) await this.deleteMessageBulk(channelId, messagesToDelete.map(o => o.id));
                else if (messagesToDelete.length > 0) await this.deleteMessage(channelId, messagesToDelete[messagesToDelete.length - 1].id);

                deleted += messagesToDelete.length;
                remain = count - deleted;

                if (messages.length < 100) break;
                if (has2WeeksAgo) break;
            }
        } catch (error) {
            await new Promise(resolve => setTimeout(resolve, (error.retry_after ? error.retry_after : 2.5) * 1000));
        }

        return deleted;
    }

    /**
     * Callback for an interaction.
     * @param {object} interaction The interaction object.
     * @param {string} type The type of callback.
     * @param {object} data The data to send with the callback.
     * @returns {Promise<object>} The callback response.
     */
    async interactionCallback(interaction, type, data) {
        return makeRequest('POST', `/interactions/${interaction.id}/${interaction.token}/callback`, { type, data });
    }

    /**
     * Get messages from a channel.
     * @param {string} channelId The ID of the channel.
     * @param {object} queries The query parameters.
     * @returns {Promise<object>} The messages object.
     */
    async getMessages(channelId, queries = {}) {
        let endpoint = `/channels/${channelId}/messages`;
        let hasquery = false;
        for (const key in queries) if (queries[key]) if (hasquery) {
            endpoint += `&${key}=${queries[key]}`;
        } else {
            endpoint += `?${key}=${queries[key]}`;
            hasquery = true;
        }
        return makeRequest('GET', endpoint);
    }

    async sendTyping(channelId) {
        return makeRequest('POST', `/channels/${channelId}/typing`);
    }
}

module.exports = Client;
