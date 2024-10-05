module.exports = {
    data: {
        name: "info",
        description: "Displays information about the bot"
    },
    execute: (d) => {
        const info = plugins.systemInfo();
        const embeds = [
            {
                title: "System Information",
                type: "rich",
                fields: [
                    {
                        name: "Platform",
                        value: info.platform
                    },
                    {
                        name: "Architecture",
                        value: info.architecture
                    },
                    {
                        name: "Uptime",
                        value: info.uptime
                    },
                    {
                        name: "Hostname",
                        value: info.hostname
                    },
                    {
                        name: "Release",
                        value: info.release
                    },
                    {
                        name: "Total Memory",
                        value: info.totalMemory
                    },
                    {
                        name: "Free Memory",
                        value: info.freeMemory
                    },
                    {
                        name: "Load Average (1, 5, 15 min)",
                        value: info.loadAverage
                    },
                    {
                        name: "CPU Count",
                        value: info.cpuCount
                    }
                ].map(o => ({ inline: true, ...o })),
                author: {
                    name: client._user.username,
                    icon_url: `https://cdn.discordapp.com/avatars/${client._user.id}/${client._user.avatar}`
                },
                color: 46433
            },
            {
                title: "CPU Info",
                type: "rich",
                fields: info.cpuInfo.map(cpu => {
                    const ret = { inline: true, name: `${cpu.core} (${cpu.model}, ${cpu.speed})` };
                    const value = [];
                    value.push(`User Time: ${cpu.times.user}`);
                    value.push(`System Time: ${cpu.times.system}`);
                    value.push(`Idle Time: ${cpu.times.idle}`);
                    ret.value = value.join("\n");
                    return ret;
                }),
                color: 46433
            },
            {
                title: "Bot Information",
                type: "rich",
                fields: [
                    {
                        name: "Version",
                        value: require("../../../package.json").version
                    },
                    {
                        name: "Uptime",
                        value: plugins.systemInfo.formatDuration(1000 * Math.round(process.uptime()))
                    },
                    {
                        name: "Memory Usage",
                        value: info.processMemoryUsage.rss
                    },
                    {
                        name: "Shards",
                        value: client._shard[1]
                    },
                    {
                        name: "Servers",
                        value: client._servers.size
                    }
                ].map(o => ({ inline: true, ...o })),
                color: 46433
            },
            {
                title: "Node.js Info",
                type: "rich",
                fields: [{
                    inline: true,
                    name: "Version",
                    value: process.version
                }],
                color: 46433
            }
        ];
        client.sendMessage(d.channel_id, null, { embeds }).catch(console.warn);
    }
};
