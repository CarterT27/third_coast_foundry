// OWNER: Tigo. Remove `.skip` from each describe as you implement.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_QUERIES } from "../src/shared/schemas";
import { chatJSON } from "../src/worker/lib/llm";
import { search, SearchCapacityError } from "../src/worker/lib/search-provider";
import { buildXray, generateQueries, parseResult, runSearch } from "../src/worker/services/search";
import { env } from "./helpers";

vi.mock("../src/worker/lib/llm", () => ({ chatJSON: vi.fn() }));
vi.mock("../src/worker/lib/search-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/worker/lib/search-provider")>()),
  search: vi.fn(),
}));

beforeEach(() => vi.resetAllMocks());

describe("buildXray", () => {
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

  it("strips quotes inside terms so the query stays balanced", () => {
    expect(
      buildXray({ titles: ['"lead" engineer', '""'], keywords: ['say "hi"'], companies: ['Toys "R" Us'], schools: [], location: '"NYC"' }),
    ).toBe('site:linkedin.com/in ("lead engineer") "say hi" ("Toys R Us") "NYC"');
  });
});

describe("parseResult", () => {
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

  it("accepts a trailing language code", () => {
    for (const path of ["jane/en", "jane/pt-br/", "jane/zh_CN"]) {
      expect(parseResult({ title: "Jane Doe - PM | LinkedIn", url: `https://www.linkedin.com/in/${path}`, snippet: "" })).toMatchObject({
        slug: "jane",
        url: "https://www.linkedin.com/in/jane",
      });
    }
    expect(parseResult({ title: "x", url: "https://www.linkedin.com/in/jane/details/experience", snippet: "" })).toBeNull();
  });

  it("drops results with no name", () => {
    expect(parseResult({ title: " | LinkedIn", url: "https://www.linkedin.com/in/jane", snippet: "" })).toBeNull();
    expect(parseResult({ title: "", url: "https://www.linkedin.com/in/jane", snippet: "" })).toBeNull();
  });

  it("rejects non-profile URLs", () => {
    for (const url of ["https://www.linkedin.com/company/stripe", "https://www.linkedin.com/jobs/view/1", "https://example.com/in/janedoe"]) {
      expect(parseResult({ title: "x", url, snippet: "" })).toBeNull();
    }
  });
});

describe("runSearch", () => {
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
    await expect(runSearch(env, ["q1", "q2"])).rejects.toThrow("Every search query failed");
  });

  it("passes the Brave cap error through as-is", async () => {
    vi.mocked(search).mockRejectedValue(new SearchCapacityError());
    await expect(runSearch(env, ["q1"])).rejects.toBeInstanceOf(SearchCapacityError);
  });
});

describe("generateQueries", () => {
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

  it("gives the model the interview preferences apart from the documents", async () => {
    vi.mocked(chatJSON).mockResolvedValue({ specs: [{ titles: ["research engineer"], keywords: [], companies: [], schools: [] }] });
    await generateQueries(env, "## RESUME (cv.pdf)\nIntern at Optiver\n\n## INTERVIEW (interview)\nTarget industries: frontier AI");
    const user = vi.mocked(chatJSON).mock.calls[0][1][1].content;
    expect(user).toMatch(/<preferences>\nTarget industries: frontier AI\n<\/preferences>/);
    expect(user).toMatch(/<documents>\n## RESUME \(cv.pdf\)\nIntern at Optiver\n<\/documents>/);
  });

  it("gives school searches without a keyword one of the plan's focus words", async () => {
    vi.mocked(chatJSON).mockResolvedValue({
      specs: [
        { titles: ["professor"], keywords: [], companies: [], schools: ["University of Chicago"] },
        { titles: ["postdoc"], keywords: [], companies: [], schools: ["University of Chicago"] },
        { titles: ["engineer"], keywords: [], companies: ["Tempus AI"], schools: [] },
      ],
      focusWords: ["neuroscience", "NLP", "natural language"],
    });
    expect(await generateQueries(env, "context")).toEqual([
      'site:linkedin.com/in ("professor") neuroscience ("University of Chicago")',
      'site:linkedin.com/in ("postdoc") NLP ("University of Chicago")',
      'site:linkedin.com/in ("engineer") ("Tempus AI")',
    ]);
  });

  it("replaces a generic focus word on school searches with a specific one from the plan", async () => {
    vi.mocked(chatJSON).mockResolvedValue({
      specs: [
        { titles: ["professor"], keywords: ["computational"], companies: [], schools: ["University of Chicago"] },
        { titles: ["postdoc"], keywords: ["neuroscience"], companies: [], schools: ["University of Chicago"] },
        { titles: ["PhD candidate"], keywords: [], companies: [], schools: ["University of Chicago"] },
      ],
    });
    expect(await generateQueries(env, "context")).toEqual([
      'site:linkedin.com/in ("professor") neuroscience ("University of Chicago")',
      'site:linkedin.com/in ("postdoc") neuroscience ("University of Chicago")',
      'site:linkedin.com/in ("PhD candidate") neuroscience ("University of Chicago")',
    ]);
  });

  it("keeps a focus word over a location next to a school", async () => {
    vi.mocked(chatJSON).mockResolvedValue({
      specs: [{ titles: ["postdoc"], keywords: ["neuroscience"], companies: [], schools: ["University of Chicago"], location: "Chicago" }],
    });
    expect(await generateQueries(env, "context")).toEqual(['site:linkedin.com/in ("postdoc") neuroscience ("University of Chicago")']);
  });

  it("falls back to a plain spec list when the full plan comes back broken", async () => {
    vi.mocked(chatJSON)
      .mockRejectedValueOnce(new Error("LLM returned invalid JSON"))
      .mockResolvedValueOnce({ specs: [{ titles: ["analyst"], keywords: [], companies: ["Lazard"], schools: [] }] });
    expect(await generateQueries(env, "context")).toEqual(['site:linkedin.com/in ("analyst") ("Lazard")']);
    expect(chatJSON).toHaveBeenCalledTimes(2);
  });

  it("pairs the plan's skills and senior titles with its target companies", async () => {
    vi.mocked(chatJSON).mockResolvedValue({
      specs: [{ titles: ["quantitative researcher"], keywords: [], companies: ["Two Sigma"], schools: [] }],
      targetCompanies: ["Two Sigma", "Citadel"],
      skills: ["machine learning", "machine learning researcher"], // the second is a title: skipped
      seniorTitles: [],
    });
    expect(await generateQueries(env, "context")).toEqual([
      'site:linkedin.com/in ("machine learning") ("Two Sigma" OR "Citadel")',
      'site:linkedin.com/in ("quantitative researcher") ("Two Sigma")',
    ]);
  });

  it("keeps at most two filters besides titles, preferring school and companies", async () => {
    vi.mocked(chatJSON).mockResolvedValue({
      specs: [
        {
          titles: ["engineer"],
          keywords: ["AI"],
          companies: ["OpenAI", "Anthropic"],
          schools: ["University of Chicago"],
          location: "San Francisco",
        },
      ],
    });
    const [query] = await generateQueries(env, "context");
    expect(query).toBe('site:linkedin.com/in ("engineer") ("OpenAI" OR "Anthropic") ("University of Chicago")');
  });
});
