module.exports = {
    data: {
        name: "unmute",
        usage: "unmute <members>",
        description: "Unmutes a member"
    },
    execute: async (d, a) => {
        let guildId;
        try {
            guildId = (await client.getChannelInfo(d.channel_id)).guild_id;
        } catch {
            return client.reply(d, "This command can only be used in a server channel").catch(console.warn);
        }

        const uids = new Set();
        for (let _a of a) {
            let id = _a.match(/<@([0-9]+)>/)?.[1];
            if (!id) if (!Number.isNaN(Number(_a))) id = _a;
            if (id?.length > 15) uids.add(id);
        }

        if (uids.size < 1) return client.reply(d, "Please specify at least one user to unmute").catch(console.warn);
        for (const uid of uids) try {
            await client.unmuteMember(guildId, uid);
            await client.sendMessage(d.channel_id, `<@${uid}> has been unmuted`);
        } catch {}

        client.deleteMessage(d.channel_id, d.id).catch(console.warn);
    }
};
