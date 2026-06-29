import { sendMemberStatusMessage } from '../lib/event_utils.js';

export default async (client, member) => {
  const user = member.user;
  const guildName = (await client.getGuild(member.guild_id)).name;
  await sendMemberStatusMessage(
    client,
    member,
    'welcome_channel',
    'Welcome to the server!',
    `Hello <@${user.id}>, welcome to **${guildName}**! We're glad to have you here.`,
    0x00ff00,
    'Failed to send welcome message in',
  );
};
