import path from 'node:path';
import { MSG } from './ipc.js';
import { shouldCompact, compact } from './compactor.js';
import { ACTION_TOOL_NAMES } from './tools/index.js';

// Memory lives at the spawner-provided dir (scoped per guild/user, surviving
// workspace cleanup); tmp stays workspace-local so it dies with the channel.
export function resolveStoragePaths(cfg, cwd) {
  return {
    tmpDir: path.join(cwd, '.agent', 'tmp'),
    memoryDir: cfg?.memoryDir || path.join(cwd, '.agent', 'memory'),
  };
}

// A run finished naturally only if the last message is assistant text
// with no pending tool calls. Anything else means the loop was cut short.
function finishedNaturally(messages) {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant' || last.tool_calls?.length) return false;
  if (typeof last.content === 'string') return last.content.trim().length > 0;
  if (Array.isArray(last.content)) {
    return last.content.some((p) => p?.type === 'text' && typeof p.text === 'string' && p.text.trim());
  }
  return false;
}

function getLastTextContent(messages) {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant' || last.tool_calls?.length) return null;
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    const textPart = last.content.find((p) => p?.type === 'text' && typeof p.text === 'string');
    return textPart ? textPart.text : null;
  }
  return null;
}

export function createHost({
  agent,
  send,
  mode,
  compactThreshold,
  keepTail,
  summarizer,
  onClose = () => process.exit(0),
}) {
  const abort = new AbortController();
  const pendingTools = new Map();
  let toolSeq = 0;
  let activeLoop = null;
  let actionToolCalled = false;
  // SDK v1.3.0 removed groupToolCalls; all tool calls now run in parallel.
  // Chain action-tool RPCs through a promise queue to preserve send order.
  let actionQueue = Promise.resolve();

  // Used by proxy tools: RPC a Discord tool call to the parent.
  function rpc(name, input) {
    if (ACTION_TOOL_NAMES.has(name)) {
      actionToolCalled = true;
      const p = actionQueue.then(
        () =>
          new Promise((resolve, reject) => {
            const id = `t${++toolSeq}`;
            pendingTools.set(id, { resolve, reject });
            send({ t: MSG.TOOL, id, name, input });
          }),
      );
      actionQueue = p.catch(() => {});
      return p;
    }
    return new Promise((resolve, reject) => {
      const id = `t${++toolSeq}`;
      pendingTools.set(id, { resolve, reject });
      send({ t: MSG.TOOL, id, name, input });
    });
  }

  async function ownLoop(runId, runPromise) {
    send({ t: MSG.CHARGE, kind: 'run' });
    let aborted = false;
    try {
      await runPromise;
    } catch (err) {
      if (abort.signal.aborted) {
        aborted = true;
      } else {
        send({ t: MSG.ERROR, id: runId, message: String(err?.message ?? err) });
        return;
      }
    }
    if (!aborted && shouldCompact(agent.messages, compactThreshold)) {
      try {
        agent.messages = await compact(agent.messages, { keepTail, summarizer });
        send({ t: MSG.CHARGE, kind: 'compact' });
      } catch {
        // compaction failure is non-fatal — keep the uncompacted history
      }
    }
    const outcome = !aborted && finishedNaturally(agent.messages) ? 'finished' : 'truncated';
    const done = { t: MSG.DONE, id: runId, outcome, usage: agent.usage };
    if (mode === 'command') done.messages = agent.messages;
    if (outcome === 'finished') {
      done.text = getLastTextContent(agent.messages);
      done.actionToolCalled = actionToolCalled;
    }
    send(done);
  }

  function onPrompt({ id, content }) {
    const wasIdle = !agent.isRunning;
    if (wasIdle) {
      actionToolCalled = false;
      actionQueue = Promise.resolve();
    }
    let p;
    try {
      p = agent.run(content, null, { signal: abort.signal });
    } catch (err) {
      send({ t: MSG.ERROR, id, message: String(err?.message ?? err) });
      return;
    }
    // Only the call that started the loop owns the `done` signal; a
    // re-entrant run() just enqueues into the live loop.
    if (wasIdle) {
      activeLoop = ownLoop(id, p).finally(() => {
        activeLoop = null;
      });
    }
  }

  function onToolResult({ id, ok, result, error }) {
    const pending = pendingTools.get(id);
    if (!pending) return;
    pendingTools.delete(id);
    if (ok) pending.resolve(result);
    else pending.reject(new Error(error || 'tool call failed'));
  }

  async function onShutdown() {
    abort.abort();
    if (activeLoop) {
      try {
        await activeLoop;
      } catch {
        // already reported
      }
    }
    try {
      await agent.cleanup?.();
    } catch {
      // best effort
    }
    onClose();
  }

  function handle(msg) {
    if (!msg || typeof msg.t !== 'string') return undefined;
    switch (msg.t) {
      case MSG.PROMPT:
        onPrompt(msg);
        return undefined;
      case MSG.TOOL_RESULT:
        onToolResult(msg);
        return undefined;
      case MSG.SHUTDOWN:
        return onShutdown();
      default:
        return undefined;
    }
  }

  return { handle, rpc };
}
