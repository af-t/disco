// makeRequest rejects with the raw Discord error body, which may be a
// plain object or a Buffer rather than an Error. String(err) alone yields
// "[object Object]" and hides the cause, so format every shape usefully.
export function formatToolError(err) {
  if (err instanceof Error) return err.message;
  if (Buffer.isBuffer(err)) return err.toString('utf8');
  if (err && typeof err === 'object') {
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

export async function withToolErrorHandling(fn) {
  try {
    return await fn();
  } catch (err) {
    return JSON.stringify({ ok: false, error: formatToolError(err) });
  }
}
