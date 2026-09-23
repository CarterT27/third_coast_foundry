// OWNER: medium-experience teammate. Remove `.skip` from each describe as you implement.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_QUERIES } from "../src/shared/schemas";
import { chatJSON } from "../src/worker/lib/nvidia";
import { search } from "../src/worker/lib/search-provider";
import { buildXray, generateQueries, parseResult, runSearch } from "../src/worker/services/search";
import { env } from "./helpers";

vi.mock("../src/worker/lib/nvidia", () => ({ chatJSON: vi.fn() }));
vi.mock("../src/worker/lib/search-provider", () => ({ search: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

describe.skip("buildXray", () => {
  it("builds every part in order", () => {
    expect(
      buildXray({
        titles: ["product manager", "PM"],
        keywords: ["fintech"],
        companies: ["Stripe", "Plaid"],
        schools: ["University of Chicago"],
        location: "Chicago",
      }),
    ).toBe('site:linkedin.com/in ("product manager" OR "PM") fintech ("Stripe" OR "Plaid") ("University of Chicago") "Chicago"');
  });

  it("omits empty parts", () => {
    expect(buildXray({ titles: ["data scientist"], keywords: [], companies: [], schools: [] })).toBe(
      'site:linkedin.com/in ("data scientist")',
    );
  });

  it("quotes multi-word keywords only", () => {
    expect(
      buildXray({ titles: ["analyst"], keywords: ["machine learning", "healthcare"], companies: [], schools: [] }),
    ).toBe('site:linkedin.com/in ("analyst") "machine learning" healthcare');
  });
});

describe.skip("parseResult", () => {
  it("parses a standard profile result", () => {
    expect(
      parseResult({
        title: "Jane Doe - Senior PM - Stripe | LinkedIn",
        url: "https://www.linkedin.com/in/janedoe/",
        snippet: "Chicago · UChicago",
      }),
    ).toEqual({
      slug: "janedoe",
      name: "Jane Doe",
      headline: "Senior PM - Stripe",
      snippet: "Chicago · UChicago",
      url: "https://www.linkedin.com/in/janedoe",
    });
  });

  it("normalizes country subdomains, casing and query strings", () => {
    const c = parseResult({ title: "Sam Lee – Analyst at Ramp | LinkedIn", url: "https://uk.linkedin.com/in/Sam-Lee-123?trk=x", snippet: "" });
    expect(c).toMatchObject({ slug: "sam-lee-123", name: "Sam Lee", headline: "Analyst at Ramp", url: "https://www.linkedin.com/in/sam-lee-123" });
  });

  it("rejects non-profile URLs", () => {
    for (const url of ["https://www.linkedin.com/company/stripe", "https://www.linkedin.com/jobs/view/1", "https://example.com/in/janedoe"]) {
      expect(parseResult({ title: "x", url, snippet: "" })).toBeNull();
    }
  });
});

describe.skip("runSearch", () => {
  const result = (slug: string) => ({ title: `${slug} - PM | LinkedIn`, url: `https://www.linkedin.com/in/${slug}`, snippet: "" });

  it("runs all queries, drops non-profiles and dedupes by slug", async () => {
    vi.mocked(search)
      .mockResolvedValueOnce([result("a"), result("b")])
      .mockResolvedValueOnce([result("b"), { title: "Stripe", url: "https://www.linkedin.com/company/stripe", snippet: "" }]);
    const found = await runSearch(env, ["q1", "q2"]);
    expect(search).toHaveBeenCalledTimes(2);
    expect(found.map((c) => c.slug)).toEqual(["a", "b"]);
  });

  it("tolerates some failed queries", async () => {
    vi.mocked(search).mockRejectedValueOnce(new Error("rate limited")).mockResolvedValueOnce([result("a")]);
    expect((await runSearch(env, ["q1", "q2"])).map((c) => c.slug)).toEqual(["a"]);
  });

  it("throws when every query fails", async () => {
    vi.mocked(search).mockRejectedValue(new Error("down"));
    await expect(runSearch(env, ["q1", "q2"])).rejects.toThrow();
  });
});

describe.skip("generateQueries", () => {
  it("returns unique X-ray strings, capped at MAX_QUERIES", async () => {
    const spec = (title: string) => ({ titles: [title], keywords: [], companies: [], schools: [] });
    const specs = [spec("pm"), spec("pm"), ...Array.from({ length: 15 }, (_, i) => spec(`role ${i}`))];
    vi.mocked(chatJSON).mockResolvedValue({ specs });
    const queries = await generateQueries(env, "## RESUME\nEconomics student interested in fintech");
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.length).toBeLessThanOrEqual(MAX_QUERIES);
    expect(new Set(queries).size).toBe(queries.length);
    expect(queries.every((q) => q.startsWith("site:linkedin.com/in"))).toBe(true);
  });
});
