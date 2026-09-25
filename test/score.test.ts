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

  it("computes the score from quoted evidence and caps, dropping points the profile doesn't show", async () => {
    const rubric = `SCORING RUBRIC (points add up to 100)
- Employer (up to 60): full points if they work at Stripe; about half if fintech; otherwise 0.
- School (up to 40): full points if UChicago; about half if another Chicago school; otherwise 0.
Caps (these override the points):
- Recruiters, talent acquisition or HR staff, and current students: at most 10.
- Their headline and snippet mention none of: payments, fintech: at most 30.`;
    const context = `## RESUME (cv.pdf)\nUChicago\n\n## INTERVIEW (interview)\nfintech\n\n${rubric}`;
    vi.mocked(chatJSON).mockResolvedValue({
      scores: [
        {
          slug: "a",
          awards: [
            { criterion: "Employer", level: "full", quote: "Product Manager at Stripe" },
            { criterion: "School", level: "full", quote: "Education: Harvard" }, // not on the profile
          ],
          caps: [{ cap: 1, applies: false }, { cap: 2, applies: false }],
          score: 100,
          reason: "PM at Stripe",
        },
      ],
    });
    // The profile never says payments or fintech, so the "mention none of" cap applies in code.
    const [score] = await scoreBatch(env, context, [candidate("a")]);
    expect(score.score).toBe(30);
  });

  it("ignores the model's verdict on a mention-none-of cap when the word is on the profile", async () => {
    const ai = { ...candidate("a"), headline: "Engineer at Hudson River Trading", snippet: "Building Generative AI tools" };
    const context = `## INTERVIEW (interview)\nx\n\nSCORING RUBRIC (points add up to 100)\n- Firm (up to 100): full points if HRT; about half if other; otherwise 0.\nCaps (these override the points):\n- Their headline and snippet mention none of: machine learning, AI: at most 25.`;
    vi.mocked(chatJSON).mockResolvedValue({
      scores: [{ slug: "a", awards: [{ criterion: "Firm", level: "full", quote: "Hudson River Trading" }], caps: [{ cap: 1, applies: true }], score: 25, reason: "HRT" }],
    });
    const [score] = await scoreBatch(env, context, [ai]);
    expect(score.score).toBe(100);
  });

  it("drops the student cap when the rubric has none", async () => {
    const student = { ...candidate("s"), headline: "Biomedical Engineering Student at Duke University" };
    const rubric = (caps: string) =>
      `## INTERVIEW (interview)\nx\n\nSCORING RUBRIC (points add up to 100)\n- School (up to 100): full points if Duke; about half if other; otherwise 0.\nCaps (these override the points):\n${caps}`;
    const answer = { scores: [{ slug: "s", awards: [{ criterion: "School", level: "full", quote: "Duke University" }], caps: [], score: 100, reason: "Duke BME" }] };
    vi.mocked(chatJSON).mockResolvedValue(answer);
    const [capped] = await scoreBatch(env, rubric("- Recruiters, talent acquisition or HR staff, and current students: at most 10."), [student]);
    const [welcome] = await scoreBatch(env, rubric("- Recruiters, talent acquisition or HR staff: at most 10."), [student]);
    expect(capped.score).toBe(10);
    expect(welcome.score).toBe(100);
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
