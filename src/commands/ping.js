export default {
  data: { name: 'ping', usage: 'ping' },
  execute: async (c, m) => {
    const ping = await c.ping();
    return c.reply(m, 'Pong! `' + ping + 'ms`');
  }
}
