function formatToMS(duration) {
    if (!duration) return 0;
    let ret = 0;

    if (duration.endsWith("s")) ret = Number(duration.slice(0, -1)) * 1000;
    else if (duration.endsWith("m")) ret = Number(duration.slice(0, -1)) * 1000 * 60;
    else if (duration.endsWith("h")) ret = Number(duration.slice(0, -1)) * 1000 * 60 * 60;
    else if (duration.endsWith("d")) ret = Number(duration.slice(0, -1)) * 1000 * 60 * 60 * 24;
    else if (duration.endsWith("w")) ret = Number(duration.slice(0, -1)) * 1000 * 60 * 60 * 24 * 7;
    else if (duration.endsWith("M")) ret = Number(duration.slice(0, -1)) * 1000 * 60 * 60 * 24 * 30;
    else if (duration.endsWith("y")) ret = Number(duration.slice(0, -1)) * 1000 * 60 * 60 * 24 * 365;
    else if (duration.endsWith("ms")) ret = Number(duration)
    else ret = Number(duration);

    return ret;
}

function formatToID(text) {
    if (!text) return;
    let id = text.match(/<@([0-9]+)>/)?.[1];
    if (!id) if (!Number.isNaN(Number(text))) id = text;
    return id;
}

module.exports = {
    data: {
        name: "mute",
        usage: "mute <member> [duration]",
        description: "Mutes a member for a specified duration"
    },
    execute: async (c, d, a) => {
        let member = formatToID(a[0]);
        let duration = formatToMS(a[1]);
        let guildId = d.guild_id;

        if (!member) if (d.message_reference) try {
            const m = await c.getMessage(d.message_reference.channel_id, d.message_reference.message_id);
            member = m.author.id;
            duration = formatToMS(a[0]);
            guildId = d.message_reference.guild_id;
        } catch {}

        if (Number.isNaN(duration)) return c.reply(d, "Invalid duration").catch(console.warn);
        if (!member) return c.reply(d, "Invalid member").catch(console.warn);

        try {
            if (!guildId) {
                const channelInfo = await c.getChannelInfo(d.channel_id);
                guildId = channelInfo.guild_id;
            }
            await c.muteMember(guildId, member, duration);

            c.reply(d, `Muted <@${member}>`).catch(console.warn);
        } catch (error) {
            c.reply(d, `Failed to mute <@${member}>.`).catch(console.warn);
            console.warn(error);
        }
    }
};
