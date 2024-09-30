module.exports = {
    data: {
        name: "unban",
        usage: "unban <member>",
        description: "Unbans a member from the server"
    },
    execute: async (c, d, a) => {
        let response;
        const uids = new Set();

        for (let _a of a) {
            let id = _a.match(/<@([0-9]+)>/)?.[1];
            if (!id) if (!Number.isNaN(Number(_a))) id = _a;
            if (id?.length > 15) uids.add(id);
        }

        if (uids.size < 1) response = "Please specify at least one user to unban";
        else {
            let unbanned = 0;
            for (const uid of uids) try {
                await c.unbanMember(d.guild_id, uid);
                unbanned++;
            } catch {}
            response = `Unbanned ${unbanned} user${unbanned === 1 ? "" : "s"}`;
        }
        setTimeout(() => c.reply(d, response).catch(console.warn)); // using timeout to solve bad request error problem
    }
};
