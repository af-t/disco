const { join } = require('path');
const { randomBytes } = require('crypto');

const lang2ext = {
    'python': 'py',
    'cheetah': 'tmpl',
    'javascript': 'js',
    'bash': 'sh',
    'typescript': 'ts',
    'brainfuck': 'bf',
    'blitzmax': 'bmx',
    'clojure': 'clj',
    'coffeescript': 'coffee',
    'console': 'ssh-session',
    'csharp': 'cs',
    'cython': 'pyx',
    'delphi': 'pas',
    'erl': 'erl-sh',
    'erlang': 'erl',
    'genshi': 'kid',
    'glsl': 'vert',
    'gnuplot': 'plt',
    'haskell': 'hs',
    'hybris': 'hy',
    'ioke': 'ik',
    'make': 'mak',
    'mako': 'mao',
    'mason': 'mc',
    'markdown': 'md',
    'modelica': 'mo',
    'modula2': 'def',
    'moocode': 'moo',
    'mupad': 'mu',
    'myghty': 'myt',
    'nasm': 'asm',
    'newspeak': 'ns2',
    'objectivec': 'm',
    'objectivej': 'j',
    'ocaml': 'ml',
    'perl': 'pl',
    'postscript': 'ps',
    'protobuf': 'proto',
    'r': 'R',
    'rconsole': 'Rout',
    'rebol': 'r',
    'redcode': 'cw',
    'scheme': 'scm',
    'smalltalk': 'st',
    'smarty': 'tpl',
    'splus': 'S',
    'text': 'txt',
    'vbnet': 'vb',
    'velocity': 'vm',
    'xquery': 'xqy',
    'yaml': 'yml'
};

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

const getFileSuffix = (line) => {
    const ss = new RegExp('```');
    const sf = new RegExp('^```([A-z]+)');
    if (line.match(ss)) {
        const lang = line.match(sf)?.[1];
        if (lang) return lang2ext[lang.toLowerCase()];
        return 'txt';
    }
    return null;
};

const content2file = (content) => {
    const files = [];
    let suffix = 'txt';
    let reading = false;
    let readContent = [];

    for (let i = 0; i < content.length; i++) {
        const cursf = getFileSuffix(content[i]);
        if (cursf && !reading) {
            suffix = cursf;
            reading = true; // start reading code block
            delete content[i];
        } else if (cursf && reading) {
            const file = {
                file_name: randomBytes(3).toString('hex') + `.${suffix}`,
                file_data: readContent.join('\n')
            };
            reading = false;
            readContent = []; // reset code buffer
            content[i] = `\n__*See code in* **${file.file_name}**__\n`;
            files.push(file);
        } else if (reading) {
            readContent.push(content[i]);
            delete content[i];
        }
    }

    return files;
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
            eTime: new Map,
            mHist: new Map,
            service: setInterval(() => {
                for (let kv of global.gemini.eTime) {
                    const [ key, val ] = kv;
                    if (Date.now() > val) {
                        plugins.gemini.recreateSession(key);
                        global.gemini.eTime.set(key, Date.now() + (1000 * config.gemini.sessionDuration));
                    }
                }
                for (let kv of global.gemini.mHist) {
                    const [ key, val ] = kv;
                    if (Date.now() > val.eTime) {
                        global.gemini.mHist.delete(key);
                        console.info('Deleted history with id:', key);
                    }
                }
            }, 10000)
        };

        if (!_a) return; // ignore if no arguments are given

        let subject = `${d.channel_id}${d.author.id}`;
        let history;
        const parts = [];

        if (d.message_reference) try {
            const m = await client.getMessage(d.channel_id, d.message_reference.message_id);
            if (m.author.id !== client._user.id) subject = `${m.channel_id}${m.author.id}`;
            if (gemini.mHist.has(`${m.channel_id}/${m.id}`)) history = gemini.mHist.get(`${m.channel_id}/${m.id}`).data;
        } catch {}

        if (!gemini.eTime.has(subject)) gemini.eTime.set(subject, Date.now());

        // Recreate the session if the history period has expired
        const curTime = gemini.eTime.get(subject);
        if (Date.now() > curTime) plugins.gemini.recreateSession(subject);

        // reset expired time
        gemini.eTime.set(subject, Date.now() + (1000 * config.gemini.sessionDuration));

        if (d.attachments) for (let att of d.attachments) {
            let mimeType = att.content_type.split(';')[0];
            try {
                const part = await plugins.gemini.toGenerativePart(att.url, mimeType, att.size, att.filename);
                parts.push(part);
            } catch (error) {
                console.warn('file attachment detected, but cannot be used in AI prompt');
                console.warn(error);
            }
        }

        let continueTyping = true;
        const typing = async () => {
            if (continueTyping) {
                await client.sendTyping(d.channel_id).catch(console.warn);
                setTimeout(() => typing(), 5000);
            }
        };
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
            const files = content2file(content);

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
                gemini.mHist.set(`${m.channel_id}/${m.id}`, {
                    eTime: Date.now() + (1000 * config.gemini.sessionDuration),
                    data: history
                });
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
        continueTyping = false; // stop typing
    }
};
