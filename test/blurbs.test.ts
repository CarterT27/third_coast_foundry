// OWNER: Tigo. Remove `.skip` as you implement.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatJSON } from "../src/worker/lib/llm";
import { writeBlurbs } from "../src/worker/services/blurbs";
import { candidate, env } from "./helpers";

vi.mock("../src/worker/lib/llm", () => ({ chatJSON: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

const mentor = (slug: string) => ({ ...candidate(slug), score: 80, reason: "Relevant", blurb: "" });

describe("writeBlurbs", () => {
  it("returns one blurb per mentor in one LLM call", async () => {
    vi.mocked(chatJSON).mockResolvedValue({
      blurbs: [
        { slug: "a", blurb: "You both studied economics." },
        { slug: "b", blurb: "They made the switch you want." },
        { slug: "invented", blurb: "?" },
      ],
    });
    const blurbs = await writeBlurbs(env, "context", [mentor("a"), mentor("b")]);
    expect(chatJSON).toHaveBeenCalledTimes(1);
    expect(blurbs.map((b) => b.slug).sort()).toEqual(["a", "b"]);
  });

  it("asks again for mentors the model skipped, then falls back to the reason", async () => {
    vi.mocked(chatJSON)
      .mockResolvedValueOnce({ blurbs: [{ slug: "a", blurb: "You both studied economics." }, { slug: "b", blurb: " " }] })
      .mockResolvedValueOnce({ blurbs: [{ slug: "b", blurb: "They made the switch you want." }] });
    const blurbs = await writeBlurbs(env, "context", [mentor("a"), mentor("b"), mentor("c")]);
    expect(chatJSON).toHaveBeenCalledTimes(2);
    expect(blurbs).toEqual([
      { slug: "a", blurb: "You both studied economics." },
      { slug: "b", blurb: "They made the switch you want." },
      { slug: "c", blurb: "Relevant" },
    ]);
  });
});
