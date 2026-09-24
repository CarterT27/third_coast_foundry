// OWNER: Carter. Remove `.skip` as you implement.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chat, chatStream } from "../src/worker/lib/nvidia";
import { nextTurn, summarize } from "../src/worker/services/interview";
import { collect, env } from "./helpers";

vi.mock("../src/worker/lib/nvidia", () => ({ chat: vi.fn(), chatStream: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

describe("nextTurn", () => {
  it("streams the model's reply and puts the user context in the prompt", async () => {
    vi.mocked(chatStream).mockImplementation(async function* () {
      yield "Hi";
      yield " there";
    });
    const reply = await collect(nextTurn(env, "UNIQUE_CONTEXT", []));
    expect(reply).toBe("Hi there");
    expect(JSON.stringify(vi.mocked(chatStream).mock.calls[0][1])).toContain("UNIQUE_CONTEXT");
  });

  it("ends the prompt with a user turn so the model can open an empty interview", async () => {
    vi.mocked(chatStream).mockImplementation(async function* () {
      yield "Hello!";
    });
    await collect(nextTurn(env, "CTX", []));
    const messages = vi.mocked(chatStream).mock.calls[0][1];
    expect(messages[0].role).toBe("system");
    expect(messages.at(-1)?.role).toBe("user");
  });
});

describe("summarize", () => {
  it("returns a plaintext summary built from the conversation", async () => {
    vi.mocked(chat).mockResolvedValue("Target industries: fintech");
    const summary = await summarize(env, [
      { role: "assistant", content: "What industries interest you?" },
      { role: "user", content: "FINTECH_ANSWER" },
    ]);
    expect(summary).toContain("fintech");
    expect(JSON.stringify(vi.mocked(chat).mock.calls[0][1])).toContain("FINTECH_ANSWER");
  });
});
