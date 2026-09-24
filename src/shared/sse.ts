/**
 * Reads a Server-Sent Events stream and yields each event's `data` payload.
 * Used by the Worker (LLM streaming responses) and the page (our own streams).
 */
export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      // Normalize CRLF/CR to LF; a trailing CR waits in case its LF is in the next chunk.
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n|\r(?!$)/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const data = parseEvent(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (data !== null) yield data;
      }
    }
    const data = parseEvent(buffer.replace(/\r/g, "\n"));
    if (data !== null) yield data;
  } finally {
    reader.releaseLock();
  }
}

function parseEvent(raw: string): string | null {
  const lines = raw
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  return lines.length ? lines.join("\n") : null;
}
