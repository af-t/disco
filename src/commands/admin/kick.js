import { executeModAction } from '../../lib/adminUtils.js';

const execute = async (client, message, args) => {
  await executeModAction(client, message, args, 'kick', 'Kicked', async (uid, reason) =>
    client.kickMember(message.guild_id, uid, reason),
  );
};

export default {
  execute,
  data: {
    name: 'kick',
    description: 'Kick a user from the server.',
    slash: true,
    usage: 'kick {user} [reason]',
    permissions: ['KICK_MEMBERS'],
    options: [
      {
        name: 'user',
        description: 'The user to kick',
        type: 6, // USER type
        required: true,
      },
      {
        name: 'reason',
        description: 'The reason for the kick',
        type: 3, // STRING type
        required: false,
      },
    ],
  },
};
