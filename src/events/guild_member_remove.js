import { sendMemberStatusMessage } from '../lib/event_utils.js';

export default async (client, member) => {
  const user = member.user;
  await sendMemberStatusMessage(
    client,
    member,
    'leave_channel',
    'Goodbye!',
    `**${user.username}** has left the server. We'll miss you!`,
    0xff0000,
    'Failed to send leave message in',
  );
};
