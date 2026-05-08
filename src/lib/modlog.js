/**
 * Modlog utility — Posts moderation action logs to the configured log channel.
 *
 * Log channel is configured via `.setchannel log #channel` and stored at:
 *   `config:{guild_id}:log_channel`
 */

/**
 * Post a moderation action log embed to the guild's configured log channel.
 *
 * @param {object} client - Discord client instance
 * @param {string} guildId - Guild ID where action occurred
 * @param {object} options - Log details
 * @param {string} options.action - Action name (e.g., 'ban', 'kick', 'mute', 'warn', 'unban', 'unmute')
 * @param {string} options.userId - Target user ID
 * @param {string} options.moderatorId - Moderator user ID
 * @param {string} [options.reason] - Reason for the action
 * @param {number} [options.caseId] - Case ID number
 * @param {number} [options.duration] - Duration in ms (for mutes)
 * @returns {Promise<object|null>} The sent message object, or null if no log channel configured
 */
export async function postModLog(client, guildId, { action, userId, moderatorId, reason, caseId, duration }) {
  try {
    const logChannelId = await client.store.get(`config:${guildId}:log_channel`);
    if (!logChannelId) return null; // No log channel configured, silently skip

    // Colors for different action types
    const colors = {
      ban: 0xe74c3c, // Red
      kick: 0xf39c12, // Orange
      mute: 0xf1c40f, // Yellow
      warn: 0x9b59b6, // Purple
      unban: 0x2ecc71, // Green
      unmute: 0x2ecc71, // Green
    };

    const actionEmojis = {
      ban: '🔨',
      kick: '👢',
      mute: '🔇',
      warn: '⚠️',
      unban: '🔓',
      unmute: '🔊',
    };

    const emoji = actionEmojis[action] || '📝';
    const color = colors[action] || 0x3498db;

    const embed = {
      title: `${emoji} Moderation Action: ${action.toUpperCase()}`,
      color,
      timestamp: new Date().toISOString(),
      fields: [
        { name: 'User', value: `<@${userId}> (${userId})`, inline: true },
        { name: 'Moderator', value: `<@${moderatorId}> (${moderatorId})`, inline: true },
      ],
      footer: { text: caseId ? `Case #${caseId}` : 'Moderation Log' },
    };

    if (reason) {
      embed.fields.push({ name: 'Reason', value: reason.length > 1024 ? reason.slice(0, 1021) + '...' : reason });
    }

    if (duration) {
      const totalSeconds = Math.floor(duration / 1000);
      const days = Math.floor(totalSeconds / 86400);
      const hours = Math.floor((totalSeconds % 86400) / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;

      let durStr = '';
      if (days > 0) durStr += `${days}d `;
      if (hours > 0) durStr += `${hours}h `;
      if (minutes > 0) durStr += `${minutes}m `;
      if (seconds > 0 || durStr === '') durStr += `${seconds}s`;

      embed.fields.push({ name: 'Duration', value: durStr.trim(), inline: true });
    }

    return await client.sendMessage(logChannelId, '', { embeds: [embed] });
  } catch (error) {
    client.logger?.error?.('Failed to post modlog:', error);
    return null;
  }
}
