export default async(client, m) => {
  client.logger.warn(m);
  setTimeout(() => client.connect(), 30_000);
};
