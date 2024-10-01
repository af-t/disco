const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const fs = require("fs");
const { join } = require("path");

require("dotenv").config();

const genAI = new GoogleGenerativeAI(global.gemini_token ?? process.env.GEMINI_TOKEN ?? global.config?.gemini?.token);
const pro = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
const flash = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

if (!genAI.apiKey) throw Error("Gemini API Key not found");

pro.quota = 2;
pro.refillDelay = 1000 * 30;
pro.quotaPerRefill = 1;

const sessions = new Map();
const history = require("./history");

const createSession = (id, hist = history) => {
    if (!hist) hist = history;
    hist = validateHistory(hist);
    for (const h of hist) if (h.parts.length < 1) hist = history;
    const session = flash.startChat({
        history: hist,
        tools: [{ codeExecution: {} }],
        systemInstruction: fs.existsSync(join(__dirname, "instruction.txt")) ? fs.readFileSync(join(__dirname, "instruction.txt")).toString() : null,
        safetySettings: (() => {
            const settings = [];
            for (const key in HarmCategory) settings.push({
                category: HarmCategory[key],
                threshold: HarmBlockThreshold.BLOCK_NONE
            });
            return settings;
        })()
    });
    sessions.set(id, session);
};

const removeSession = (id) => sessions.delete(id);

const executeAI = async (id, parts) => {
    if (!sessions.has(id)) createSession(id);

    let session = sessions.get(id);

    if (pro.quota > 0 && !pro.disabled) {
        if (pro.accessTime && Date.now() - pro.accessTime >= pro.refillDelay) pro.quota = pro.quotaPerRefill;
        session = pro.startChat({ history: await session.getHistory() });
        pro.accessTime = Date.now();
        pro.quota--;
    } else if (Date.now() - pro.accessTime >= pro.refillDelay) pro.quota = pro.quotaPerRefill;

    // sync
    try {
        const ret = await session.sendMessage(parts);
        createSession(id, await session.getHistory());

        pro.disabled = false;

        ret.model = session.model;
        return ret;
    } catch {
        if (pro.disabled) {
            pro.disabled = false;
            throw Error("There seems to be a problem with Google servers");
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
    ret.history = await sessions.get(id).getHistory();
    removeSession(id);

    return ret;
};

const getHistory = async (id) => {
    if (sessions.has(id)) return sessions.get(id).getHistory();
    return history;
};

const validateHistory = (history) => {
    const valid = [];
    for (let i = 0; i < history.length; i += 2) if (history[i].parts.length > 0 && history[i+1].parts.length > 0) {
        valid.push(history[i]);
        valid.push(history[i+1]);
    }
    return valid;
};

const saveSessions = async (path = join(__dirname, "histories")) => {
    resolveDir(path);
    const ids = [...session.keys()];
    for (const id of ids) {
        const session = sessions.get(id);
        const savePath = join(path, `generative_history_${id}.json`);
        const saveData = {
            model: session.model,
            history: await session.getHistoy()
        };
        await fs.promises.writeFile(savePath, JSON.stringify(saveData));
    }
};

const loadSessions = async (path = join(__dirname, "histories")) => {
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
            setupAI(id, data.model, data.history);
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

const toGenerativePart = async (file, mimeType) => {
    let data;

    if (fs.existsSync(file)) {
        const stat = fs.statSync(file);
        if (!stat.isFile()) throw Error(`The ${file} not a file`);
        if (stat.size > 5 * 1024 * 1024) throw Error("The file size provided cannot be more than 5MB");
        data = fs.readFileSync(file);
    } else try {
        const { href } = new URL(file);
        data = Buffer.from(await fetch(href).then(res => res.arrayBuffer()));
        if (data.length > 5 * 1024 * 1024) throw Error();
    } catch {
        throw Error(`Failed to process ${file}`);
    }

    data = data.toString("base64");
    return { inlineData: { data, mimeType } };
};

const isMostlyText = (content) => {
    let printableChars = 0;
    for (let i = 0; i < content.length; i++) if (content[i] >= 32 && content[i] <= 126) printableChars++;
    return (printableChars / content.length >= 0.9);
};

const mimeCheck = (mimeType) => {
    const [ main, sub ] = mimeType.split("/");
    if (main === "image") return true;
    if (main === "audio") return true;
    if (main === "text") return true;
    if (sub === "pdf") return true;
};

module.exports = {
    createSession,
    removeSession,
    executeAI,
    tempExecuteAI,
    getHistory,
    saveSessions,
    loadSessions,
    toGenerativePart,
    isMostlyText,
    mimeCheck
};
