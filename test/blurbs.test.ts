// OWNER: Tigo. Remove `.skip` as you implement.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatJSON } from "../src/worker/lib/nvidia";
import { writeBlurbs } from "../src/worker/services/blurbs";
import { candidate, env } from "./helpers";

vi.mock("../src/worker/lib/nvidia", () => ({ chatJSON: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

const mentor = (slug: string) => ({ ...candidate(slug), score: 80, reason: "Relevant", blurb: "" });

describe.skip("writeBlurbs", () => {
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
});
