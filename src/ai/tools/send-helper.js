import { formatToolError } from './error.js';

export async function finishSend(runtime, sendPromise) {
  try {
    const sent = await sendPromise;
    runtime.onBotMessage(sent);
    return JSON.stringify({ ok: true, message_id: sent.id });
  } catch (err) {
    return JSON.stringify({ ok: false, error: formatToolError(err) });
  }
}
