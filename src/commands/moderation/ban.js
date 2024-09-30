module.exports = {
    data: {
        name: "ban",
        usage: "ban <member> [reason]",
        description: "Bans a member from the server"
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

        if (uids.size < 1) response = "Please specify at least one user to ban";
        else {
            let banned = 0;
            for (const uid of uids) try {
                await c.banMember(d.guild_id, uid, reason);
                banned++;
            } catch {}
            response = `Banned ${banned} user${banned === 1 ? "" : "s"}`;
        }
        setTimeout(() => c.reply(d, response).catch(console.warn)); // using timeout to solve bad request error problem
    }
};
