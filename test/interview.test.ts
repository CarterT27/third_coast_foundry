// OWNER: Carter. Remove `.skip` as you implement.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chat, chatJSON, chatStream } from "../src/worker/lib/llm";
import { RUBRIC_HEADING, nextTurn, splitContext, summarize } from "../src/worker/services/interview";
import { collect, env } from "./helpers";

vi.mock("../src/worker/lib/llm", () => ({ chat: vi.fn(), chatJSON: vi.fn(), chatStream: vi.fn() }));

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

  it("tells the model to be brief, ask one question and hide its reasoning", async () => {
    vi.mocked(chatStream).mockImplementation(async function* () {
      yield "Which cities?";
    });
    await collect(nextTurn(env, "CTX", []));
    const system = vi.mocked(chatStream).mock.calls[0][1][0].content;
    expect(system).toContain("Exactly one question");
    expect(system).toMatch(/under 35 words/);
    expect(system).toMatch(/Never show your reasoning/);
  });

  it("lists the questions already asked so the model doesn't repeat them", async () => {
    vi.mocked(chatStream).mockImplementation(async function* () {
      yield "Which cities?";
    });
    await collect(
      nextTurn(env, "CTX", [
        { role: "assistant", content: "What seniority level would be most helpful?" },
        { role: "user", content: "Anyone" },
      ]),
    );
    const system = vi.mocked(chatStream).mock.calls[0][1][0].content;
    expect(system).toMatch(/Never repeat or rephrase/);
    expect(system).toContain("- What seniority level would be most helpful?");
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

describe("summarize rubric", () => {
  const conversation = [
    { role: "assistant" as const, content: "What industries interest you?" },
    { role: "user" as const, content: "Frontier AI labs" },
  ];

  it("appends the student's rubric with points scaled to 100 and the fixed caps", async () => {
    vi.mocked(chat).mockResolvedValue("Target industries: frontier AI");
    vi.mocked(chatJSON).mockResolvedValue({
      criteria: [
        { name: "Employer", points: 3, full: "they work at a frontier AI lab", partial: "they work at an AI startup" },
        { name: "Shared background", points: 1, full: "they share a school or past employer", partial: "they share a city" },
      ],
      caps: ["Works at Palantir: at most 15."],
    });
    const note = await summarize(env, conversation);
    expect(note.startsWith("Target industries: frontier AI")).toBe(true);
    expect(note).toContain(RUBRIC_HEADING);
    expect(note).toContain("Employer (up to 75)");
    expect(note).toContain("Shared background (up to 25)");
    expect(note).toMatch(/Recruiters.*at most 10/);
    expect(note).toContain("Works at Palantir: at most 15.");
    expect(JSON.stringify(vi.mocked(chatJSON).mock.calls[0][1])).toContain("Frontier AI labs");
  });

  it("keeps points summing to exactly 100 after rounding", async () => {
    vi.mocked(chat).mockResolvedValue("summary");
    vi.mocked(chatJSON).mockResolvedValue({
      criteria: [1, 1, 1].map((points, i) => ({ name: `C${i}`, points, full: "x", partial: "y" })),
      caps: [],
    });
    const note = await summarize(env, conversation);
    const points = [...note.matchAll(/\(up to (\d+)\)/g)].map((m) => Number(m[1]));
    expect(points.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("still returns the summary if the rubric call fails", async () => {
    vi.mocked(chat).mockResolvedValue("Target industries: fintech");
    vi.mocked(chatJSON).mockRejectedValue(new Error("LLM down"));
    expect(await summarize(env, conversation)).toBe("Target industries: fintech");
  });
});

describe("splitContext", () => {
  it("separates the interview summary, its rubric and the documents", () => {
    const context = `## RESUME (cv.pdf)\nIntern at Optiver\n\n## INTERVIEW (interview)\nTarget industries: AI\n\n${RUBRIC_HEADING} (points add up to 100)\n- Employer (up to 100): ...`;
    expect(splitContext(context)).toEqual({
      preferences: "Target industries: AI",
      rubric: `${RUBRIC_HEADING} (points add up to 100)\n- Employer (up to 100): ...`,
      documents: "## RESUME (cv.pdf)\nIntern at Optiver",
    });
  });

  it("treats a context without sections as documents", () => {
    expect(splitContext("just text")).toEqual({ preferences: "", rubric: "", documents: "just text" });
  });
});
