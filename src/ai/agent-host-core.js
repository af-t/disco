import { MSG } from './ipc.js';
import { shouldCompact, compact } from './compactor.js';

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

  // Used by proxy tools: RPC a Discord tool call to the parent.
  function rpc(name, input) {
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
    send(done);
  }

  function onPrompt({ id, content }) {
    const wasIdle = !agent.isRunning;
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
