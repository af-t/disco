const os = require("os");

function formatDuration(ms) {
    const time = {
        year: Math.floor(ms / (1000 * 60 * 60 * 24 * 365)),
        month: Math.floor((ms % (1000 * 60 * 60 * 24 * 365)) / (1000 * 60 * 60 * 24 * 30)),
        week: Math.floor((ms % (1000 * 60 * 60 * 24 * 30)) / (1000 * 60 * 60 * 24 * 7)),
        day: Math.floor((ms % (1000 * 60 * 60 * 24 * 7)) / (1000 * 60 * 60 * 24)),
        hour: Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
        minute: Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60)),
        second: Math.floor((ms % (1000 * 60)) / 1000),
        millisecond: ms % 1000
    };

    const parts = [];

    // Display years, months, weeks, and days as before
    if (time.year > 0) parts.push(`${time.year} ${time.year > 1 ? 'years' : 'year'}`);
    if (time.month > 0) parts.push(`${time.month} ${time.month > 1 ? 'months' : 'month'}`);
    if (time.week > 0) parts.push(`${time.week} ${time.week > 1 ? 'weeks' : 'week'}`);
    if (time.day > 0) {
        parts.push(`${time.day} ${time.day > 1 ? 'days' : 'day'}`);

        // Format hours, minutes, and seconds as HH:MM:SS
        const formattedTime = [
            String(time.hour).padStart(2, '0'),
            String(time.minute).padStart(2, '0'),
            String(time.second).padStart(2, '0')
        ].join(':');
        parts.push(formattedTime);
    } else {
        if (time.hour) parts.push(`${time.hour} ${time.hour > 1 ? 'hours' : 'hour'}`);
        if (time.minute) parts.push(`${time.minute} ${time.minute > 1 ? 'minutes' : 'minute'}`);
        if (time.second) parts.push(`${time.second} ${time.second > 1 ? 'seconds' : 'second'}`);
    }

    // Add milliseconds only if relevant
    if (time.millisecond > 0 && time.year === 0) {
        parts.push(`${time.millisecond}ms`);
    }

    // Again, use ", " for stylistic separation of larger time units
    return parts.join(", ");
}

function formatMemory(bytes) {
    if (bytes >= 1024 * 1024 * 1024) {
        return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GiB';
    } else if (bytes >= 1024 * 1024) {
        return (bytes / (1024 * 1024)).toFixed(2) + ' MiB';
    } else if (bytes >= 1024) {
        return (bytes / 1024).toFixed(2) + ' KiB';
    } else {
        return bytes + ' B';
    }
}

function getCpuInfo() {
    return os.cpus().map((cpu, index) => {
        const { model, speed, times } = cpu;
        return {
            core: `Core ${index}`,
            model,
            speed: `${speed} MHz`,
            times: {
                user: `${Math.round(times.user / 1000)}s`,
                system: `${Math.round(times.sys / 1000)}s`,
                idle: `${Math.round(times.idle / 1000)}s`
            }
        }
    });
}

function getSystemInfo() {
    return {
        platform: os.platform(),
        architecture: os.arch(),
        uptime: formatDuration(1000 * os.uptime()),
        hostname: os.hostname(),
        release: os.release(),
        totalMemory: formatMemory(os.totalmem()),
        freeMemory: formatMemory(os.freemem()),
        loadAverage: os.loadavg().map(load => load.toFixed(2)).join(', '), // Load average for 1, 5, 15 minutes
        cpuCount: os.cpus().length,
        cpuInfo: getCpuInfo(),
        processMemoryUsage: {
            rss: formatMemory(process.memoryUsage().rss), // Resident Set Size
            heapTotal: formatMemory(process.memoryUsage().heapTotal),
            heapUsed: formatMemory(process.memoryUsage().heapUsed),
            external: formatMemory(process.memoryUsage().external),
        },
        processCpuUsage: (() => {
            const usage = process.cpuUsage();
            return {
                user: `${(usage.user / 1000000).toFixed(2)}s`,
                system: `${(usage.system / 1000000).toFixed(2)}s`
            }
        })(),
        nodeVersion: process.version
    };
}

getSystemInfo.getCpuInfo = getCpuInfo;
getSystemInfo.formatDuration = formatDuration;
module.exports = getSystemInfo;
