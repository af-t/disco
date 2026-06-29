import permissionFlags from '../../../src/lib/permission.js';

export function gatedCtx({ perms = permissionFlags.ADMINISTRATOR, bufferIds = ['m-admin'], rest = {} } = {}) {
  const map = new Map();
  const client = {
    getChannel: async () => ({ guild_id: 'g1' }),
    getMessage: async () => ({ author: { id: 'a1', bot: false } }),
    getGuildMember: async () => ({ roles: ['role1'] }),
    getRoles: async () => [
      { id: 'g1', permissions: '0' },
      { id: 'role1', permissions: String(perms) },
    ],
    store: { get: async (k) => map.get(k), set: async (k, v) => void map.set(k, v) },
    logger: { warn() {} },
    ...rest,
  };
  const runtime = {
    _agentGuild: new Map(),
    channels: new Map([['c1', { authorizableIds: new Set(bufferIds) }]]),
  };
  return { ctx: { client, runtime }, map };
}
