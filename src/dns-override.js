import dns from 'node:dns';

// Force IPv4 only if explicitly enabled via environment
if (process.env.DNS_FORCE_IPV4 === 'true' || process.env.DNS_FORCE_IPV4 === '1') {
  const originalLookup = dns.lookup;
  dns.lookup = function (hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    } else if (typeof options === 'number') {
      options = { family: options };
    } else if (!options) {
      options = {};
    }

    options.family = 4;

    return originalLookup.call(dns, hostname, options, callback);
  };
}
