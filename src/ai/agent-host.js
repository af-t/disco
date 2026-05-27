import path from 'node:path';
import createAgent from 'openrouter';
import { MSG } from './ipc.js';
import { buildProxyTools } from './tools/index.js';
import { createHost } from './agent-host-core.js';

const send = (m) => process.send?.(m);

let host = null;

// Summarizer used by compaction — its own short-lived agent and LLM call.
function makeSummarizer() {
  return async (messages) => {
    const tmp = await createAgent({ maxTurns: 1 });
    tmp.messages = [];
    const body = messages
      .map((m) => `[${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
      .join('\n');
    return tmp.run(
      `Summarize the following conversation segment in 6-12 lines. Preserve names, actions, and unresolved threads. No preamble.\n\n${body}`,
    );
  };
}

async function onInit(cfg) {
  const cwd = process.cwd();
  const agent = await createAgent({
    maxTurns: cfg.maxTurns,
    systemPrompt: cfg.systemPrompt,
    storagePaths: {
      tmpDir: path.join(cwd, '.agent', 'tmp'),
      memoryDir: path.join(cwd, '.agent', 'memory'),
    },
  });
  if (Array.isArray(cfg.history)) agent.messages = cfg.history;

  host = createHost({
    agent,
    send,
    mode: cfg.mode,
    compactThreshold: cfg.compactThreshold,
    keepTail: cfg.keepTail,
    summarizer: makeSummarizer(),
    onClose: () => process.exit(0),
  });

  for (const tool of buildProxyTools(host.rpc)) agent.tools.register(tool);
  send({ t: MSG.READY });
}

process.on('message', (msg) => {
  if (msg?.t === MSG.INIT) {
    onInit(msg).catch((err) => {
      send({ t: MSG.ERROR, message: String(err?.message ?? err) });
      process.exit(1);
    });
    return;
  }
  host?.handle(msg);
});

process.on('uncaughtException', (err) => {
  send({ t: MSG.ERROR, message: `uncaught: ${String(err?.message ?? err)}` });
  process.exit(1);
});
