import { describe, it } from 'node:test';
import assert from 'node:assert';
import { fork } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const HOST = path.resolve('src/ai/agent-host.js');
const FAKE = path.resolve('tests/ai/fixtures/fake-openrouter.js');

describe('agent-host integration', () => {
  it('runs init -> ready -> prompt -> tool -> done over real IPC', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agenthost-'));
    // Redirect the bare "openrouter" import to the fake via an import map.
    const child = fork(HOST, [], {
      cwd,
      env: { ...process.env, OPENROUTER_API_KEY: 'test' },
      execArgv: [
        '--import',
        `data:text/javascript,${encodeURIComponent(
          `import { register } from 'node:module';` +
            `register('data:text/javascript,' + encodeURIComponent(` +
            `'export async function resolve(s,c,n){return s===\\'openrouter\\'?n(${JSON.stringify(FAKE)}):n(s);}'` +
            `), import.meta.url);`,
        )}`,
      ],
    });

    const received = [];
    const done = new Promise((resolve, reject) => {
      child.on('message', (m) => {
        received.push(m);
        if (m.t === 'ready') {
          child.send({ t: 'prompt', id: 'r1', content: 'hello' });
        }
        if (m.t === 'tool') {
          child.send({ t: 'tool-result', id: m.id, ok: true, result: '{"ok":true}' });
        }
        if (m.t === 'done') resolve(m);
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (!received.some((x) => x.t === 'done')) reject(new Error(`exited ${code} before done`));
      });
    });

    child.send({
      t: 'init',
      mode: 'natural',
      systemPrompt: 'test',
      maxTurns: 10,
      compactThreshold: 1000,
      keepTail: 10,
      history: null,
    });

    const result = await done;
    child.send({ t: 'shutdown' });
    await fs.rm(cwd, { recursive: true, force: true });
    assert.equal(result.outcome, 'finished');
    assert.ok(received.some((m) => m.t === 'tool' && m.name === 'discord_send'));
    assert.ok(received.some((m) => m.t === 'charge' && m.kind === 'run'));
  });
});
