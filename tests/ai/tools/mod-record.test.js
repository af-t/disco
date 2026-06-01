import { describe, it } from 'node:test';
import assert from 'node:assert';
import { recordModeration } from '../../../src/ai/tools/mod-record.js';

function mapStore(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { map: m, store: { get: async (k) => m.get(k), set: async (k, v) => void m.set(k, v) } };
}

describe('recordModeration', () => {
  it('creates a case and posts the modlog with the case id', async () => {
    const { map, store } = mapStore({ 'config:g1:log_channel': 'log1' });
    const sent = [];
    const client = { store, sendMessage: async (ch, content, opts) => sent.push({ ch, opts }), logger: { warn() {} } };
    const caseId = await recordModeration(client, {
      guildId: 'g1',
      action: 'mute',
      caseType: 'mute',
      userId: 'u1',
      moderatorId: 'a1',
      reason: 'spam',
      duration: 1000,
    });
    assert.equal(caseId, 1);
    assert.equal(map.get('modcase:g1:1').type, 'mute');
    assert.equal(map.get('modcase:g1:1').moderator_id, 'a1');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].opts.embeds[0].footer.text, 'Case #1');
  });

  it('still posts the modlog when createCase fails, returning null', async () => {
    const m = new Map(Object.entries({ 'config:g1:log_channel': 'log1' }));
    const store = {
      get: async (k) => m.get(k),
      set: async () => {
        throw new Error('store down');
      },
    };
    const sent = [];
    const client = { store, sendMessage: async (ch, content, opts) => sent.push({ ch, opts }), logger: { warn() {} } };
    const caseId = await recordModeration(client, {
      guildId: 'g1',
      action: 'kick',
      caseType: 'kick',
      userId: 'u1',
      moderatorId: 'a1',
      reason: 'x',
    });
    assert.equal(caseId, null);
    assert.equal(sent.length, 1);
  });
});
