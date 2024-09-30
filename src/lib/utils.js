const { Worker, isMainThread, parentPort } = require("worker_threads");
const fs = require("fs");
const { join, basename } = require("path");
const { inspect } = require("util")

const workerJobs = {};
let worker;

const log = (...args) => {
    for (let i = 0; i < args.length; i++) {
        if (typeof args[i] === "string") process.stdout.write(args[i]);
        else process.stdout.write(inspect(args[i], null, 2, true));
        if (i < args.length) process.stdout.write(" ");
    }
    process.stdout.write("\n");
};

const err = (...args) => {
    for (let i = 0; i < args.length; i++) {
        if (typeof args[i] === "string") process.stderr.write(args[i]);
        else process.stderr.write(inspect(args[i], null, 2, true));
        if (i < args.length) process.stderr.write(" ");
    }
    process.stderr.write("\n");
};

const simple_logger = { 
    error: (...args) => err("\x1b[0;31m*\x1b[m", ...args),
    warn: (...args) => err("\x1b[0;33m*\x1b[m", ...args),
    info: (...args) => log("\x1b[0;36m*\x1b[m", ...args),
    log: (...args) => log("\x1b[0;37m*\x1b[m", ...args),
    debug: (...args) => log("\x1b[0;35m*\x1b[m", ...args),
    blue: (...args) => log("\x1b[0;34m*\x1b[m", ...args)
};

const addJob = (command, execute) => {
    let id = Math.random().toString(16).slice(2);
    while (id in workerJobs) id = Math.random().toString(16).slice(2);
    workerJobs[id] = execute;
    worker.postMessage({id, command});
};

const jobExecute = (id, data) => {
    if (workerJobs[id].unused) {
        delete workerJobs[id];
    } else workerJobs[id](data);
    if (workerJobs[id]?.unused) delete workerJobs[id];
};

const getCommandFiles = (path) => {
    const ret = [];
    const listFiles = fs.readdirSync(path).map(f => join(path, f));
    for (let i = 0; i < listFiles.length; i++) {
        if (listFiles[i].endsWith(".js")) ret.push(listFiles[i]);
        else if (fs.statSync(listFiles[i]).isDirectory()) ret.push(...getCommandFiles(listFiles[i]));
    }
    return ret;
};

/**
 * Loads commands from the specified directory.
 *
 * This function reads all JavaScript files in the given directory,
 * imports them as commands, and stores them in the provided exports object.
 * It also sets up file watchers to reload commands when their files are updated.
 *
 * @param {Object} exports The object to store the loaded commands in.
 * @param {string} path The path to the directory containing the command files.
 */
const loadCommands = (exports, path) => {
    const listFiles = getCommandFiles(path);

    const importCommand = (exports, filepath) => {
        try {
            delete require.cache[require.resolve(filepath)];
        } catch {
            // Ignore errors related to clearing the require cache
        }

        try {
            const __ = require(filepath);
            for (const key in __) exports[key] = __[key];
        } catch {
            try {
                delete require.cache[require.resolve(filepath)];
            } catch {}
        }
    };

    const startTime = performance.now();
    let loadedCount = 0;

    for (let i = 0; i < listFiles.length; i++) {
        const command = { data: null, execute: null };
        const execute = (...args) => (command.execute && command.execute(...args));
        importCommand(command, listFiles[i]);

        const copy2Execute = () => {
            for (let key in command) if (!Object.hasOwnProperty.call(execute, key)) Object.defineProperty(execute, key, {
                enumerable: true,
                get: () => command[key],
            });
        };

        if (command.data?.name && command.execute) {
            if (Array.isArray(command.data.aliases)) for (let j = 0; j < command.data.aliases.length; j++) exports[command.data.aliases[j]] = execute;
            exports[command.data.name] = execute;

            addJob(`watchFile:${listFiles[i]}`, () => {
                const temp = { data: null, execute: null };
                importCommand(temp, listFiles[i]);
                if (temp.data?.name && temp.execute) {
                    importCommand(command, listFiles[i]);
                    if (Array.isArray(command.data.aliases)) for (let j = 0; j < command.data.aliases.length; j++) exports[command.data.aliases[j]] = execute;
                    copy2Execute();
                    simple_logger.info(`Updated command: ${command.data.name}`);
                } else {
                    simple_logger.warn(`Command change error: ${basename(listFiles[i])}`);
                }

                delete temp;
            });

            copy2Execute()
            loadedCount++;
        } else {
            simple_logger.warn(`Failed to load command: ${basename(listFiles[i])}`);
        }
    }
    simple_logger.info(`Loaded ${loadedCount} commands in ${(performance.now() - startTime).toFixed(1)}ms`);
};

/**
 * Saves a message to the file system.
 *
 * @param {object} m - The message object to be saved.
 * @param {string} path - The base path for saving the message.
 * @returns {Promise} A promise that resolves when the message is saved or rejects with an error.
 */
const saveMessage = (m, path) => {
    return new Promise((resolve, reject) => {
        const data = { path: join(path, m.channel_id), message: m };
        const job = (cb) => {
            cb ? reject(cb) : resolve();
            job.unused = true;
        };
        addJob(`saveMessage:${Buffer.from(JSON.stringify(data)).toString("base64")}`, job);
    });
};

/**
 * Deletes a message or messages from the file system.
 *
 * @param {object} d - An object containing either a single message ID or an array of message IDs.
 * @param {string} path - The base path for the messages.
 */
const deleteMessage = (d, path) => {
    if (d.id) {
        const messLoc = join(path, d.channel_id, `${d.id}.json`);
        fs.existsSync(messLoc) && fs.unlinkSync(messLoc);
    } else if (d.ids) for (let id of d.ids) {
        const messLoc = join(path, d.channel_id, `${id}.json`)
        fs.existsSync(messLoc) && fs.unlinkSync(messLoc);
    }
};

if (isMainThread) {
    module.exports = {
        loadCommands,
        saveMessage,
        deleteMessage,
        logger: simple_logger
    }
    worker = new Worker(__filename);
    worker.on("message", ({id, data}) => jobExecute(id, data));
    console = Object.assign(console, simple_logger);
} else {
    // watchFile
    let watchesFile = [];
    let watchFileInterval;
    parentPort.watchFile = (id, path) => {
        watchesFile.push({id, path, current: fs.statSync(path)});
        if (!watchFileInterval) watchFileInterval = setInterval(async() => {
            let needToFilter = false;
            for (let i = 0; i < watchesFile.length; i++) {
                let same = true;
                try {
                    const stat = fs.statSync(watchesFile[i].path);
                    for (const key in stat) if (typeof stat[key] === "number" && key !== "atimeMs") if (stat[key] !== watchesFile[i].current[key]) same = false;
                    if (!same) {
                        parentPort.postMessage({id: watchesFile[i].id});
                        watchesFile[i].current = stat;
                    }
                    await new Promise(resolve => setTimeout(resolve, 200));
                } catch (error) {
                    simple_logger.error(error.message);
                    simple_logger.error("Watch stopped");
                    delete watchesFile[i];
                    needToFilter = true;
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            if (needToFilter) watchesFile = watchesFile.filter(o => o);
        }, 100);
    };

    // saveMessage
    parentPort.saveMessage = (id, data) => {
        data = JSON.parse(atob(data));
        if (!fs.existsSync(data.path)) fs.mkdirSync(data.path, { recursive: true });
        fs.writeFile(join(data.path, `${data.message.id}.json`), JSON.stringify(data.message), error => {
            if (error) return parentPort.postMessage({id, data: error});
            parentPort.postMessage({id});
        });
    };

    parentPort.on("message", ({id, command}) => {
        command = command.split(":");
        const name = command.shift();
        const data = command.join(":");
        parentPort[name](id, data);
    });
}