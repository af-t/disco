const testPing = async(c) => {
    const wsPingStart = Date.now();
    await c.ping().catch(console.warn);
    const wsPing = Date.now() - wsPingStart;

    const apiPingStart = Date.now();
    await c.getUserInfo(`@me`).catch(console.warn);
    const apiPing = Date.now() - apiPingStart;

    return [
        `WS Ping: \`${wsPing}ms\``,
        `HTTP Ping: \`${apiPing}ms\``,
    ];
};

module.exports = {
    data: {
        name: 'ping',
        description: "Check the bot's latency"
    },
    execute: async (c, d) => c.sendMessage(d.channel_id, `Pong.`).then(async(m) => {
        const ping = await testPing(c);
        c.editMessage(m, `Pong.\n${ping.join("\n")}`).catch(console.warn);
    }).catch(console.warn)
};
