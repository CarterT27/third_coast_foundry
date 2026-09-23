import { describe, expect, it } from "vitest";
import { readSSE } from "../src/shared/sse";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function all(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const data of readSSE(stream)) out.push(data);
  return out;
}

describe("readSSE", () => {
  it("yields each event's data", async () => {
    expect(await all(streamOf("data: a\n\ndata: b\n\n"))).toEqual(["a", "b"]);
  });

  it("handles events split across chunks and CRLF line endings", async () => {
    expect(await all(streamOf("data: {\"x\"", ":1}\r\n\r\ndata: [DONE]\r\n\r\n"))).toEqual(['{"x":1}', "[DONE]"]);
  });

  it("joins multi-line data and ignores other fields", async () => {
    expect(await all(streamOf("event: msg\nid: 1\ndata: line1\ndata: line2\n\n: comment\n\n"))).toEqual([
      "line1\nline2",
    ]);
  });

  it("flushes a final event without a trailing blank line", async () => {
    expect(await all(streamOf("data: last"))).toEqual(["last"]);
  });
});
