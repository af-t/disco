export function shouldCompact(messages, threshold) {
  return Array.isArray(messages) && messages.length > threshold;
}

export async function compact(messages, { keepTail = 10, summarizer }) {
  if (!Array.isArray(messages) || messages.length <= keepTail) return messages;
  const toSummarize = messages.slice(0, -keepTail);
  const tail = messages.slice(-keepTail);
  let summary;
  try {
    summary = await summarizer(toSummarize);
  } catch {
    summary = `(failed to summarize ${toSummarize.length} earlier messages)`;
  }
  return [{ role: 'system', content: `[compacted: ${summary}]` }, ...tail];
}
