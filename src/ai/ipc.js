// Message types exchanged over the fork() IPC channel.
// Parent = bot process, child = forked agent host.
export const MSG = Object.freeze({
  // parent -> child
  INIT: 'init',
  PROMPT: 'prompt',
  TOOL_RESULT: 'tool-result',
  SHUTDOWN: 'shutdown',
  // child -> parent
  READY: 'ready',
  TOOL: 'tool',
  CHARGE: 'charge',
  DONE: 'done',
  ERROR: 'error',
});
