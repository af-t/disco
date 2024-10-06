const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');
const fs = require('fs');
const { join, basename } = require('path');

const fileManager = new GoogleAIFileManager(global.gemini_token ?? process.env.GEMINI_TOKEN ?? global.config?.gemini?.token);
const genAI = new GoogleGenerativeAI(global.gemini_token ?? process.env.GEMINI_TOKEN ?? global.config?.gemini?.token);
const genOpts = {
    tools: [{ codeExecution: {} }],
    safetySettings: (() => {
        const settings = [];
        for (const key in HarmCategory) if (key !== 'HARM_CATEGORY_UNSPECIFIED') settings.push({
            category: HarmCategory[key],
            threshold: HarmBlockThreshold.BLOCK_NONE
        });
        return settings;
    })(),
    systemInstruction: (() => {
        const ipath = join(__dirname, 'instruction.txt');
        return fs.existsSync(ipath) ? fs.readFileSync(ipath).toString() : null;
    })(),
    generationConfig: {
        temperature: 0.2
    }
};

const pro = genAI.getGenerativeModel({ model: 'gemini-1.5-pro-latest', ...genOpts });
const flash = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest', ...genOpts });

if (!genAI.apiKey) console.error('Gemini API Key not found');

pro.quota = 2;
pro.quotaMax = 2;
pro.quotaPerCheck = 1;
pro.checkDelay = 1000 * 30;
pro.lastCheck = Date.now();

const sessions = new Map();
const history = require('./history');

const createSession = (id, hist = history) => {
    hist = validate(hist);
    if (!sessions.has(id)) sessions.set(id, flash.startChat({ history: hist }));
};

const removeSession = (id) => sessions.delete(id);

const recreateSession = (id, history) => {
    removeSession(id);
    createSession(id, history);
};

const executeAI = async (id, parts) => {
    if (!sessions.has(id)) createSession(id);
    let session = sessions.get(id);

    if (Date.now() - pro.lastCheck >= pro.checkDelay) {
        pro.lastCheck = Date.now();
        if (pro.quota <= pro.quotaMax) pro.quota += pro.quotaPerCheck;
    }
    if (pro.quota > 0 && !pro.quota) {
        session = pro.startChat({ history: validate(session._history) });
        pro.quota--;
    }

    // sync
    try {
        const ret = await session.sendMessage(parts);
        recreateSession(id, validate(session._history));
        pro.disabled = false;
        ret.model = session.model;
        return ret;
    } catch (error) {
        console.error(error);

        if (pro.disabled) {
            pro.disabled = false;
            throw Error('There seems to be a problem with Google servers');
        } else {
            pro.disabled = true;
            return executeAI(id, parts);
        }
    }
};

const tempExecuteAI = async (parts, hist = history) => {
    const id = Math.random().toString(16).slice(2);
    createSession(id, hist);

    const ret = await executeAI(id, parts);
    ret.history = sessions.get(id)._history;
    removeSession(id);

    return ret;
};

const getHistory = (id) => {
    if (sessions.has(id)) return sessions.get(id)._history;
    return history;
};

const validate = (history) => {
    const valid = [];
    if (!Array.isArray(history)) return valid;
    for (let i = 0; i < history.length; i += 2) if (history[i].parts.length > 0 && history[i+1].parts.length > 0) {
        valid.push(history[i]);
        valid.push(history[i+1]);
    }
    return valid;
};

const saveSessions = async (path = join(__dirname, 'histories')) => {
    resolveDir(path);
    const ids = [...sessions.keys()];
    for (const id of ids) {
        const session = sessions.get(id);
        const savePath = join(path, `generative_history_${id}.json`);
        const saveData = { history: session._history };
        await fs.promises.writeFile(savePath, JSON.stringify(saveData));
    }
};

const loadSessions = async (path = join(__dirname, 'histories')) => {
    resolveDir(path);
    const listFiles = fs.readdirSync(path).map(f => join(path, f)).filter(f => {
        const stat = fs.statSync(f);
        if (stat.isDirectory()) return false;
        if (f.match(/generative_history_(.+).json/)?.[1]) return true;
        return false;
    });
    let sucess = 0;
    let fail = 0;
    for (const f of listFiles) {
        const id = f.match(/genetative_history_(.+).json/)[1];
        try {
            const data = JSON.parse(await fs.promises.readFile(f));
            createSession(id, data.history);
            sucess++;
        } catch {
            fail++;
        }
    }
    return `Success: ${success}, Fail: ${fail}`;
};

const resolveDir = (path) => {
    if (fs.existsSync(path)) {
        const stat = fs.statSync(path);
        if (!stat.isDirectory()) {
            fs.unlinkSync(path);
            fs.mkdirSync(path);
        }
    } else fs.mkdirSync(path, { recursive: true });
};

const isMostlyText = (content) => {
    let printableChars = 0;
    for (let i = 0; i < content.length; i++) if (content[i] >= 32 && content[i] <= 126) printableChars++;
    return (printableChars / content.length >= 0.9);
};

const mimeCheck = (mimeType) => {
    const [ main, sub ] = mimeType.split('/');
    if (main === 'image') return true;
    if (main === 'audio') return true;
    if (main === 'text') return true;
    if (sub === 'pdf') return true;
};

const toGenerativePart = async (file, mimeType, leakedSize, filename) => {
    let data = Buffer.alloc(0);
    let unlink = false; // Unlink after upload

    if (typeof file !== 'string') throw TypeError(`The "file" argument must be of type string. Received ${typeof file}`);
    if (leakedSize > 10 * 1024 * 1024) throw Error('File size is too large');
    if (fs.existsSync(file)) {
        const stat = fs.statSync(file);
        if (!stat.isFile()) throw Error(`The ${file} not a file`);
        if (stat.size > 10 * 1024 * 1024) throw Error('The file size is too large. The maximum limit is 10Mb');
        data = fs.readFileSync(file);
    } else try {
        const { href, pathname } = new URL(file);
        const res = await fetch(href);
        if (!res.ok) {
            console.warn('Response not OK:', res.statusText);
            throw null;
        }
        data = await res.arrayBuffer();
        data = Buffer.from(data);
        file = join(process.env.TMPDIR ?? process.env.TEMP ?? '.', basename(pathname));
        unlink = true;
        fs.writeFileSync(file, data);
    } catch {
        throw Error(`The ${file} can't be loaded`);
    }

    // Change mime type to text/plain if possible
    if (isMostlyText(data)) {
        mimeType = 'text/plain';
    }

    // Check mime is allowed
    if (!mimeCheck(mimeType)) throw Error(`Mime type "${mimeType}" is not allowed`);

    const uploadRes = await fileManager.uploadFile(file, {
        mimeType,
        displayName: filename || file
    });
    if (unlink) fs.unlinkSync(file);

    return {
        fileData: {
            mimeType: uploadRes.file.mimeType,
            fileUri: uploadRes.file.uri
        }
    };
};

module.exports = {
    createSession,
    removeSession,
    recreateSession,
    executeAI,
    tempExecuteAI,
    getHistory,
    saveSessions,
    loadSessions,
    toGenerativePart,
    isMostlyText,
    mimeCheck
};
