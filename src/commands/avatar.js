module.exports = {
    data: {
        name: "avatar",
        usage: "avatar [users]",
        aliases: [ "av" ],
        description: "Displays the avatar of the user(s) specified."
    },
    execute: async (c, d, a) => {
        const uids = new Set();
        const embeds = [];
        let guildId;
        let channelId;

        for (let _a of a) {
            let id = _a.match(/<@([0-9]+)>/)?.[1];
            if (!id) if (!Number.isNaN(Number(_a))) id = _a;
            if (id?.length > 15) uids.add(id);
        }

        if (uids.size < 1 && d.message_reference) {
            guildId = d.message_reference.guild_id;
            channelId = d.message_reference.channel_id;
            try {
                const m = await c.getMessage(channelId, d.message_reference.message_id);
                uids.add(m.author.id);
            } catch {
                guildId = null;
                channelId = null;
            }
        }
        if (uids.size < 1) uids.add(d.author.id);

        if (!channelId) channelId = d.channel_id;
        if (!guildId) try {
            guildId = (await c.getChannelInfo(channelId)).guild_id;
        } catch (err) {
            console.warn(err);
        }

        for (let id of uids) {
            let avatar;
            let username;
            let title = "Server Avatar";
            try {
                const memberInfo = await c.getMemberInfo(guildId, id);
                if (memberInfo.avatar) {
                    avatar = memberInfo.avatar;
                    username = memberInfo.user.username;
                } else if (memberInfo.user?.avatar) {
                    avatar = memberInfo.user.avatar;
                    username = memberInfo.user.username;
                } else throw "";
            } catch {
                try {
                    const userInfo = await c.getUserInfo(id);
                    avatar = userInfo.avatar;
                    username = userInfo.username;
                    title = "User Avatar";
                } catch (err) {
                    console.warn(err);
                    continue;
                }
            }
            embeds.push({
                author: {
                    name: username,
                    icon_url: `https://cdn.discordapp.com/avatars/${id}/${avatar}`
                },
                image: {
                    width: 1024,
                    height: 1024,
                    url: `https://cdn.discordapp.com/avatars/${id}/${avatar}.png?size=4096`
                },
                title,
                type: "rich"
            });
        }
        c.sendMessage(d.channel_id, null, { embeds }).catch(() => c.reply(d, "No avatars found").catch(console.warn));
    }
};
