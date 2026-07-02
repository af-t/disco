import permissionFlags from './permission.js';
import tools from './utility.js';

const { getPermissions, unrefTimeout } = tools;

const ALLOWED_DOMAINS = [
  'discord.com',
  'discord.gg',
  'discordapp.com',
  'discordapp.net',
  'cdn.discordapp.com',
  'media.discordapp.net',
  'tenor.com',
  'giphy.com',
  'imgur.com',
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'youtube.com',
  'youtu.be',
  'twitch.tv',
  'spotify.com',
  'x.com',
  'twitter.com',
  'reddit.com',
  'medium.com',
  'stackoverflow.com',
  'stackexchange.com',
  'npmjs.com',
  'docs.python.org',
  'nodejs.org',
  'canva.com',
  'drive.google.com',
  'docs.google.com',
];

const urlRegex = /https?:\/\/([^\s/?#]+)/gi;

// Deletes a message carrying a non-allowlisted link and warns; returns true when it acted.
export async function moderateDisallowedLink(client, message) {
  const urls = message.content?.match(urlRegex);
  if (!urls) return false;

  const hasDisallowedLink = urls.some((url) => {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, '');
      return !ALLOWED_DOMAINS.some((allowed) => hostname === allowed || hostname.endsWith('.' + allowed));
    } catch {
      return true; // Invalid URL, treat as disallowed
    }
  });
  if (!hasDisallowedLink) return false;

  const member = message.member || (await client.getGuildMember(message.guild_id, message.author.id));
  const perms = await getPermissions(client, message.guild_id, member);
  const isMod =
    (perms & permissionFlags.ADMINISTRATOR) === permissionFlags.ADMINISTRATOR ||
    (perms & permissionFlags.MANAGE_MESSAGES) === permissionFlags.MANAGE_MESSAGES;
  if (isMod) return false;

  await client.deleteMessage(message.channel_id, message.id);
  const warn = await client.sendMessage(
    message.channel_id,
    `🚫 **${message.author.username}**, posting links is not allowed here!`,
  );
  unrefTimeout(
    () =>
      client
        .deleteMessage(message.channel_id, warn.id)
        .catch((err) => client.logger?.warn?.('Failed to delete link warning:', err)),
    5000,
  );
  return true;
}
