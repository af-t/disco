const { join } = require("path");

module.exports = {
    data: {
        name: "gemini",
        aliases: [ "ai" ],
        usage: "gemini <text>",
        description: "Use Gemini to generate text"
    },
    execute: async (c, d, a, _a) => {
        if (!global.gemini) global.gemini = {
            aTime: new Map,
            mHist: new Map
        };

        if (!_a) return;

        let subject = `${d.channel_id}${d.author.id}`;
        let history;
        const parts = [];

        if (d.message_reference) try {
            const m = await c.getMessage(d.channel_id, d.message_reference.message_id);
            subject = `${m.channel_id}${m.author.id}`;

            if (gemini.mHist.has(`${m.channel_id}/${m.id}`)) history = gemini.mHist.get(`${m.channel_id}/${m.id}`);
        } catch {}

        if (!gemini.aTime.has(subject)) gemini.aTime.set(subject, Date.now());

        const date = gemini.aTime.get(subject);
        if (Date.now() > date) {
            plugins.gemini.removeSession(subject);
            plugins.gemini.createSession(subject);
        }
        gemini.aTime.set(subject, Date.now() + (1000 * config.gemini.sessionDuration));

        if (d.attachments) for (const att of d.attachments) {
            let mimeType = att.content_type.split(";")[0];
            const charset = (att.content_type.split(";")[1] || "").trim().split("=")[1];
            let push = false;
            if (charset) {
                push = true;
                mimeType = 'text/plain';
            } else if (plugins.gemini.mimeCheck(att.content_type)) push = true;
            if (att.size > 5 * 1024 * 1024) push = false;
            if (push) try {
                const ret = await plugins.gemini.toGenerativePart(att.url, mimeType);
                parts.push(ret);
            } catch {};
        }

        const typing = async () => (await c.sendTyping(d.channel_id).catch(console.warn));
        const typing_i = setInterval(() => typing(), 5000);
        typing();

        try {
            let res;
            if (history) {
                res = await plugins.gemini.tempExecuteAI([ _a, ...parts ], history);
                history = res.history;
            } else {
                res = await plugins.gemini.executeAI(subject, [ _a, ...parts ]);
                history = await plugins.gemini.getHistory(subject);
            }

            const m = await c.sendMessage(d.channel_id, "", {
                embeds: [{
                    type: "rich",
                    description: res.response.text(),
                    //footer: { text: res.model.split("/")[1] }
                }],
                message_reference: {
                    channel_id: d.channel_id,
                    message_id: d.id
                },
                allowed_mentions: {} // no mention
            });
            gemini.mHist.set(`${m.channel_id}/${m.id}`, history);
        } catch (error) {
            try {
                const m = await c.reply(d, error.message);
                setTimeout(() => c.deleteMessage(m.channel_id, m.id).catch(console.warn), 5000);
            } catch {}
            console.warn(error);
        }
        clearInterval(typing_i);
    }
};
