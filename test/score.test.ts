// OWNER: Carter. Remove `.skip` as you implement.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatJSON } from "../src/worker/lib/llm";
import { scoreBatch } from "../src/worker/services/score";
import { candidate, env } from "./helpers";

vi.mock("../src/worker/lib/llm", () => ({ chatJSON: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

describe("scoreBatch", () => {
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

  it("makes no LLM call for an empty batch", async () => {
    expect(await scoreBatch(env, "context", [])).toEqual([]);
    expect(chatJSON).not.toHaveBeenCalled();
  });

  it("asks again only for candidates the model skipped", async () => {
    vi.mocked(chatJSON)
      .mockResolvedValueOnce({ scores: [{ slug: "a", score: 88, reason: "PM in fintech" }] })
      .mockResolvedValueOnce({ scores: [{ slug: "b", score: 45, reason: "Adjacent field" }] });
    const scores = await scoreBatch(env, "context", [candidate("a"), candidate("b")]);
    expect(chatJSON).toHaveBeenCalledTimes(2);
    const retryPrompt = JSON.stringify(vi.mocked(chatJSON).mock.calls[1][1]);
    expect(retryPrompt).toContain("slug: b");
    expect(retryPrompt).not.toContain("slug: a");
    expect(scores).toEqual([
      { slug: "a", score: 88, reason: "PM in fintech" },
      { slug: "b", score: 45, reason: "Adjacent field" },
    ]);
  });

  it("keeps first-pass scores if the retry fails", async () => {
    vi.mocked(chatJSON)
      .mockResolvedValueOnce({ scores: [{ slug: "a", score: 70, reason: "PM" }] })
      .mockRejectedValueOnce(new Error("LLM down"));
    const scores = await scoreBatch(env, "context", [candidate("a"), candidate("b")]);
    expect(scores).toEqual([
      { slug: "a", score: 70, reason: "PM" },
      { slug: "b", score: 0, reason: "" },
    ]);
  });

  it("rounds and clamps scores into 0-100 integers and keeps the first duplicate", async () => {
    vi.mocked(chatJSON).mockResolvedValue({
      scores: [
        { slug: "a", score: 105, reason: "Too high" },
        { slug: "b", score: 87.6, reason: "Fractional" },
        { slug: "c", score: -3, reason: "Negative" },
        { slug: "a", score: 10, reason: "Duplicate" },
      ],
    });
    const scores = await scoreBatch(env, "context", [candidate("a"), candidate("b"), candidate("c")]);
    expect(scores.map((s) => s.score)).toEqual([100, 88, 0]);
    expect(scores[0].reason).toBe("Too high");
  });

  it("scores with the student's own rubric when the interview wrote one", async () => {
    vi.mocked(chatJSON).mockResolvedValue({ scores: [] });
    const context =
      "## RESUME (cv.pdf)\nIntern at Optiver\n\n## INTERVIEW (interview)\nTarget industries: AI\n\nSCORING RUBRIC (points add up to 100)\n- UNIQUE_CRITERION (up to 100): ...";
    await scoreBatch(env, context, [candidate("a")]);
    const system = vi.mocked(chatJSON).mock.calls[0][1][0].content;
    expect(system).toContain("UNIQUE_CRITERION");
    expect(system).not.toContain("Stage (up to 10)");
    expect(system).toMatch(/<preferences>\nTarget industries: AI\n<\/preferences>/);
    expect(system).toContain("Intern at Optiver");
  });

  it("falls back to the default rubric before the interview is finished", async () => {
    vi.mocked(chatJSON).mockResolvedValue({ scores: [] });
    await scoreBatch(env, "## RESUME (cv.pdf)\nIntern at Optiver", [candidate("a")]);
    expect(vi.mocked(chatJSON).mock.calls[0][1][0].content).toContain("Stage (up to 10)");
  });

  it("tells the model how to read evidence so job ads, students and bare company names don't score as matches", async () => {
    vi.mocked(chatJSON).mockResolvedValue({ scores: [] });
    await scoreBatch(env, "context", [candidate("a")]);
    const system = vi.mocked(chatJSON).mock.calls[0][1][0].content;
    expect(system).toMatch(/job ad.*NOT evidence they work there/);
    expect(system).toMatch(/current student and gets the student cap/);
    expect(system).toMatch(/only a company name shows the employer but not the role/);
    expect(system).toMatch(/90 or more needs full points/);
  });
});
