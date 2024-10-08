module.exports = {
    data: {
        name: "delrole",
        usage: "delrole <member> <role>",
        description: "Removes a role from a member",
        aliases: [
            "removerole",
            "deleterole",
            "roledelete",
            "roleremove",
            "rmrole",
            "rolerm"
        ]
    },
    execute: async (d, a) => {
        const user = a[0] ? a[0].match(/<@([0-9]+)>/)?.[1] : null;
        const role = a[1] ? a[1].match(/<@&([0-9]+)>/)?.[1] : null;

        if (!user || !role) return client.reply(d, "Please specify a member and a role" ).catch(console.warn);

        try {
            const guildId = (await client.getChannelInfo(d.channel_id)).guild_id;
            await client.removeMemberRole(guildId, user, role);

            client.reply(d, `Removed role <@&${role}> from <@${user}>`).catch(console.warn);
        } catch (error) {
            client.reply(d, `Failed to remove role <@&${role}> from <@${user}>.`).catch(console.warn);
            console.warn(error);
        }
    }
};
