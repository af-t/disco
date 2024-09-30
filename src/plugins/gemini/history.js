module.exports = [];

const fs = require("fs");
const { join } = require("path");

const safeRequire = (file) => {
    try {
        const _req = require(file);
        delete require.cache[require.resolve(file)];
        if (_req instanceof Array) return _req;
        throw Error();
    } catch {
        return [];
    }
};

try {
    const fileLists = fs.readdirSync(join(__dirname, "history_files"));
    const higherNum = (() => {
        let max = 0;
        for (const f of fileLists) {
            let num = Number(f.match(/^([0-9]+)-/)[1]);
            max = Math.max(max, num);
        }
        return max + 1;
    })();

    for (let i = 0; i < higherNum; i++) {
        const userFile = join(__dirname, "history_files", `${i}-user.txt`);
        const partsFile = join(__dirname, "history_files", `${i}-user.js`);
        const modelFile = join(__dirname, "history_files", `${i}-model.txt`);
        if (fs.existsSync(userFile) && fs.existsSync(modelFile)) {
            const parts = [{ text: fs.readFileSync(userFile).toString() }];
            if (fs.existsSync(partsFile)) {
                const _parts = safeRequire(partsFile);
                for (const part of _parts) parts.push(part);
            }
            module.exports.push({ role: "user", parts });
            module.exports.push({ parts: [{ text: fs.readFileSync(modelFile).toString() }], role: "model" });
        } else throw Error("there is a file that does not exist");
    }
} catch (error) {}
