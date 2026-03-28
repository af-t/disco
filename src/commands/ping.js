export default {
  data: { name: 'ping', usage: 'ping' },
  execute: async (c, m) => {
    const ping = await c.latency();
    return c.reply(m, 'Pong! `' + ping + 'ms`');
  }
}
