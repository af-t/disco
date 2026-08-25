const DRAIN_POLL_MS = 50;
const DEFAULT_DRAIN_TIMEOUT_MS = 3000;

/**
 * Signal handler factory for the store server.  Clients flush their cache and
 * disconnect when they shut down, so give them a window to finish before
 * persisting.  The default stays well under the supervisor's 5s force-kill
 * budget, leaving time for the engine's own disk flush.
 * @param {object} options
 * @param {() => object | null} options.getStore Returns the live store engine (may be null).
 * @param {Map<string, {destroy: () => void}>} options.requestLog Live client sockets by IP.
 * @param {() => void} options.closeServer Stops the HTTP/WebSocket server.
 * @param {number} [options.drainTimeoutMs] Fixed drain window; overrides the env default.
 * @returns {() => Promise<void>} Idempotent signal handler.
 */
export function createSignalHandler({ getStore, requestLog, closeServer, drainTimeoutMs }) {
  let shutdownPromise = null;

  async function shutdown() {
    const requested = drainTimeoutMs ?? Number(process.env.STORE_SHUTDOWN_DRAIN_MS);
    const timeout = Number.isFinite(requested) && requested >= 0 ? requested : DEFAULT_DRAIN_TIMEOUT_MS;

    const deadline = Date.now() + timeout;
    while (requestLog.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    }

    await getStore()?.close?.();

    for (const [ip, socket] of requestLog.entries()) {
      socket.destroy();
      requestLog.delete(ip);
    }

    closeServer();
  }

  return () => {
    shutdownPromise ??= shutdown();
    return shutdownPromise;
  };
}
