const { join } = require('path');
const { randomBytes } = require('crypto');

const split = (data) => {
    const splited = [];
    const parts = data.split('\n');
    let message = '';

    for (let part of parts) if ((message + part).length > 2000) {
        splited.push(message);
        message = part + '\n';
    } else {
        message += part + '\n';
    }
    if (message.length > 0) splited.push(message);

    return splited;
};

module.exports = {
    data: {
        name: 'gemini',
        aliases: [ 'ai' ],
        usage: 'gemini <text>',
        description: 'Use Gemini to generate text'
    },
    execute: async (d, a, _a) => {
        if (!global.gemini) global.gemini = {
            aTime: new Map,
            mHist: new Map
        };

        if (!_a) return;

        let subject = `${d.channel_id}${d.author.id}`;
        let history;
        const parts = [];

        if (d.message_reference) try {
            const m = await client.getMessage(d.channel_id, d.message_reference.message_id);
            if (m.author.id !== client._user.id) subject = `${m.channel_id}${m.author.id}`;
            if (gemini.mHist.has(`${m.channel_id}/${m.id}`)) history = gemini.mHist.get(`${m.channel_id}/${m.id}`);
        } catch {}

        if (!gemini.aTime.has(subject)) gemini.aTime.set(subject, Date.now());

        const date = gemini.aTime.get(subject);
        if (Date.now() > date) plugins.gemini.recreateSession(subject);
        gemini.aTime.set(subject, Date.now() + (1000 * config.gemini.sessionDuration));

        if (d.attachments) for (let att of d.attachments) {
            let mimeType = att.content_type.split(';')[0];
            try {
                const part = await plugins.gemini.toGenerativePart(att.url, mimeType, att.size);
                parts.push(part);
            } catch (error) {
                console.warn('file attachment detected, but cannot be used in AI prompt');
                console.warn(error);
            }
        }

        const typing = async () => (await client.sendTyping(d.channel_id).catch(console.warn));
        const typing_i = setInterval(() => typing(), 5000);
        typing();

        try {
            let res;
            if (history) {
                res = await plugins.gemini.tempExecuteAI([ _a, ...parts ], history);
                history = res.history;
            } else {
                res = await plugins.gemini.executeAI(subject, [ _a, ...parts ]);
                history = plugins.gemini.getHistory(subject);
            }

            let content = res.response.text().split('\n');
            const files = [];

            let reading = false;
            let suffix = 'txt';
            let readContent = [];
            let ss = new RegExp('^```');
            let sf = new RegExp('^```([A-z]+)');
            for (let i = 0; i < content.length; i++) {
                if (content[i].match(ss) && !reading) {
                    const suf = content[i].match(sf)?.[1];
                    if (suf) suffix = suf;
                    reading = true;
                    delete content[i];
                } else if (content[i].match(ss)) {
                    const file = {
                        file_name: randomBytes(2).toString('hex') + `.${suffix}`,
                        file_data: readContent.join('\n')
                    };
                    reading = false;
                    readContent = [];
                    content[i] = `\nsee **${file.file_name}**\n`;
                    files.push(file);
                } else if (reading) {
                    readContent.push(content[i]);
                    delete content[i];
                }
            }

            content = split(content.filter(x => x).join('\n'));
            for (let i = 0; i < content.length; i++) {
                let m;
                if (i + 1 === content.length && files.length > 0) {
                    m = await client.uploadFiles(d.channel_id, content[i], files);
                } else if (i === 0) {
                    m = await client.reply(d, content[i]);
                } else {
                    m = await client.sendMessage(d.channel_id, content[i]);
                }
                gemini.mHist.set(`${m.channel_id}/${m.id}`, history);
            }
            plugins.gemini.recreateSession(subject, history);
            //console.log(require('util').inspect(history, null, 20, true));
        } catch (error) {
            try {
                const m = await client.reply(d, error?.response?.text ? error.response.text() : error?.message);
                setTimeout(() => client.deleteMessage(m.channel_id, m.id).catch(console.warn), 8000);
            } catch (error) {}
            console.warn(error);
        }
        clearInterval(typing_i);
    }
};
