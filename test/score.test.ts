// OWNER: Carter. Remove `.skip` as you implement.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatJSON } from "../src/worker/lib/llm";
import { scoreBatch } from "../src/worker/services/score";
import { candidate, env } from "./helpers";

vi.mock("../src/worker/lib/llm", () => ({ chatJSON: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

describe.skip("scoreBatch", () => {
  it("returns exactly one score per input, dropping invented slugs and zeroing missing ones", async () => {
    vi.mocked(chatJSON).mockResolvedValue({
      scores: [
        { slug: "a", score: 88, reason: "PM in fintech" },
        { slug: "invented", score: 99, reason: "?" },
      ],
    });
    const scores = await scoreBatch(env, "context", [candidate("a"), candidate("b")]);
    expect(scores).toHaveLength(2);
    expect(scores.find((s) => s.slug === "a")?.score).toBe(88);
    expect(scores.find((s) => s.slug === "b")?.score).toBe(0);
    expect(scores.some((s) => s.slug === "invented")).toBe(false);
  });

  it("includes the user context and every candidate in the prompt", async () => {
    vi.mocked(chatJSON).mockResolvedValue({ scores: [] });
    await scoreBatch(env, "UNIQUE_CONTEXT", [candidate("alpha"), candidate("beta")]);
    const prompt = JSON.stringify(vi.mocked(chatJSON).mock.calls[0][1]);
    expect(prompt).toContain("UNIQUE_CONTEXT");
    expect(prompt).toContain("alpha");
    expect(prompt).toContain("beta");
  });
});
