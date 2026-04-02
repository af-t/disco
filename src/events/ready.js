export default (client, d) => {
  client.logger.info(`Logged in as \x1b[0;33m${d.user.username}\x1b[m${client.connectTime ? ' in \x1b[0;33m' + (Date.now() - client.connectTime) + 'ms\x1b[m' : ''}`);
  client.logger.info(`Currently serving \x1b[0;33m${d.guilds.length}\x1b[m server${d.guilds.length > 1 ? 's' : ''}`);
};
