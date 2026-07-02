import { executeModAction } from '../../lib/adminUtils.js';

const execute = async (client, message, args) => {
  await executeModAction(client, message, args, 'ban', 'Banned', async (uid, reason) =>
    client.banMember(message.guild_id, uid, { reason }),
  );
};

export default {
  execute,
  data: {
    name: 'ban',
    description: 'Ban a user from the server.',
    slash: true,
    usage: 'ban {user} [reason]',
    permissions: ['BAN_MEMBERS'],
    options: [
      {
        name: 'user',
        description: 'The user to ban',
        type: 6, // USER type
        required: true,
      },
      {
        name: 'reason',
        description: 'The reason for the ban',
        type: 3, // STRING type
        required: false,
      },
    ],
  },
};
