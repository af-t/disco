module.exports = {
    data: {
        name: "kick",
        usage: "kick <member> [reason]",
        description: "Kicks a member from the server"
    },
    execute: async (c, d, a) => {
        let reason = '';
        let response;
        const uids = new Set();

        if (d.message_reference) {
            try {
                const m = await c.getMessage(d.message_reference.channel_id, d.message_reference.message_id);
                uids.add(m.author.id);
            } catch {}
            reason = a.join(' ');
        }

        if (uids.size < 1) for (let _a of a) {
            let id = _a.match(/<@([0-9]+)>/)?.[1];
            if (!id) if (!Number.isNaN(Number(_a))) id = _a;
            if (id?.length > 15) uids.add(id);
            else reason += ` ${_a}`;
        }

        if (uids.size < 1) response = "Please specify at least one user to kick";
        else {
            let kicked = 0;
            for (const uid of uids) try {
                await c.kickMember(d.guild_id, uid, reason);
                kicked++;
            } catch {}
            response = `Kicked ${kicked} user${kicked === 1 ? "" : "s"}`;
        }
        setTimeout(() => c.reply(d, response).catch(console.warn)); // using timeout to solve bad request error problem
    }
};
