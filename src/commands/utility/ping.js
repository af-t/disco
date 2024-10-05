const testPing = async(c) => {
    const wsPingStart = Date.now();
    await client.ping().catch(console.warn);
    const wsPing = Date.now() - wsPingStart;

    const apiPingStart = Date.now();
    await client.getUserInfo(`@me`).catch(console.warn);
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
    execute: async (d) => client.sendMessage(d.channel_id, `Pong.`).then(async(m) => {
        const ping = await testPing(c);
        client.editMessage(m, `Pong.\n${ping.join("\n")}`).catch(console.warn);
    }).catch(console.warn)
};
