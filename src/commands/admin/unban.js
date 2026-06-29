import { executeModAction } from './adminUtils.js';

const execute = async (client, message, args) => {
  await executeModAction(client, message, args, 'unban', 'Unbanned', async (uid, reason) =>
    client.unbanMember(message.guild_id, uid, reason),
  );
};

export default {
  execute,
  data: {
    name: 'unban',
    description: 'Unban a user from the server.',
    slash: true,
    usage: 'unban {user}',
    permissions: ['BAN_MEMBERS'],
    options: [
      {
        name: 'user',
        description: 'The user ID to unban',
        type: 3, // STRING type (since they are not in the guild, USER type might not work as easily with autocomplete if not cached)
        required: true,
      },
    ],
  },
};
