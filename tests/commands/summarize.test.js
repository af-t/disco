import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert';
import { mockExports } from '../module_mock.js';

const CHANNEL_ID = '200000000000000001';
const USER_ID = '100000000000000001';

function createMockClient(replyCalls = []) {
  return {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    getMessages: async () => [
      {
        id: '800000000000000001',
        author: { username: 'Alice' },
        content: 'hello world',
        attachments: [],
        embeds: [],
        timestamp: new Date().toISOString(),
      },
    ],
    sendTyping: async () => {},
    reply: async (_msg, content) => {
      replyCalls.push(content);
      return { id: 'reply_001', channel_id: CHANNEL_ID };
    },
  };
}

function createMockMessage(overrides = {}) {
  return {
    id: '900000000000000001',
    channel_id: CHANNEL_ID,
    author: { id: USER_ID, username: 'TestUser' },
    isInteraction: false,
    ...overrides,
  };
}

describe('summarize command', () => {
  afterEach(() => mock.restoreAll());

  it('creates a fresh agent per invocation, not a shared module-level singleton', async () => {
    const createdAgents = [];

    const mockAgentCreator = async () => {
      const agent = {
        messages: [],
        run: async () => 'summary text',
      };
      createdAgents.push(agent);
      return agent;
    };

    await mock.module('@af-t/agent-sdk', mockExports({ default: mockAgentCreator }));

    const { default: summarize } = await import('../../src/commands/utils/summarize.js');

    const client = createMockClient();
    const msg = createMockMessage();

    await summarize.execute(client, msg, []);
    await summarize.execute(client, msg, []);

    assert.strictEqual(
      createdAgents.length,
      2,
      'createAgent() must be called once per invocation, not once at module load',
    );
    assert.notStrictEqual(
      createdAgents[0],
      createdAgents[1],
      'Each invocation must receive its own independent agent instance',
    );
  });
});
