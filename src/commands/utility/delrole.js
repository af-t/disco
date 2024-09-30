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
    execute: async (c, d, a) => {
        const user = a[0] ? a[0].match(/<@([0-9]+)>/)?.[1] : null;
        const role = a[1] ? a[1].match(/<@&([0-9]+)>/)?.[1] : null;

        if (!user || !role) return c.reply(d, "Please specify a member and a role" ).catch(console.warn);

        try {
            const guildId = (await c.getChannelInfo(d.channel_id)).guild_id;
            await c.removeMemberRole(guildId, user, role);

            c.reply(d, `Removed role <@&${role}> from <@${user}>`).catch(console.warn);
        } catch (error) {
            c.reply(d, `Failed to remove role <@&${role}> from <@${user}>.`).catch(console.warn);
            console.warn(error);
        }
    }
};
