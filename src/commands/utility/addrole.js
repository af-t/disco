module.exports = {
    data: {
        name: "addrole",
        usage: "addrole <member> <role>",
        description: "Adds a role to a member",
        aliases: [ "roleadd" ]
    },
    execute: async (d, a) => {
        const user = a[0] ? a[0].match(/<@([0-9]+)>/)?.[1] : null;
        const role = a[1] ? a[1].match(/<@&([0-9]+)>/)?.[1] : null;

        if (!user || !role) return client.reply(d, "Please specify a member and a role" ).catch(console.warn);

        try {
            const guildId = (await client.getChannelInfo(d.channel_id)).guild_id;
            await client.addMemberRole(guildId, user, role);

            client.reply(d, `Added role <@&${role}> to <@${user}>`).catch(console.warn);
        } catch (error) {
            client.reply(d, `Failed to add role <@&${role}> to <@${user}>.`).catch(console.warn);
            console.warn(error);
        }
    }
};
