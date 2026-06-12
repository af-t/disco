import utility from '../lib/utility.js';

const { unrefTimeout } = utility;

export default async (client, m) => {
  client.logger.warn(m);
  unrefTimeout(() => client.connect(), 30_000);
};
