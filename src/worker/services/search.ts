// OWNER: Tigo
// Implement the function bodies. Do not change the signatures.
// Suggested order: buildXray → parseResult → runSearch → generateQueries (tests cover all four).
import { z } from "zod";
import { type Candidate, MAX_QUERIES, XraySpec } from "../../shared/schemas";
import type { Env } from "../env";
import { chatJSON } from "../lib/llm";
import { search, type SearchResult } from "../lib/search-provider";
import { splitContext } from "./interview";

/**
 * Turns one spec into a Google/Brave "X-ray" query restricted to LinkedIn profiles.
 *
 * Contract (see test/search.test.ts for exact examples):
 * - Always starts with `site:linkedin.com/in`.
 * - `titles` → one OR group, each term quoted: ("product manager" OR "PM").
 * - each `keywords` entry → AND'd, quoted if it contains a space.
 * - `companies` and `schools` → one OR group each, quoted.
 * - `location` → quoted.
 * - Empty arrays/undefined add nothing. Parts are joined by single spaces.
 */
export function buildXray(spec: XraySpec): string {
  const quote = (term: string) => `"${term}"`;
  const orGroup = (terms: string[]) => (terms.length > 0 ? `(${terms.map(quote).join(" OR ")})` : "");
  return [
    "site:linkedin.com/in",
    orGroup(spec.titles),
    ...spec.keywords.map((k) => (/\s/.test(k) ? quote(k) : k)),
    orGroup(spec.companies),
    orGroup(spec.schools),
    spec.location ? quote(spec.location) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Converts one search result into a Candidate, or null if it isn't a profile.
 *
 * Contract:
 * - Only URLs like https://www.linkedin.com/in/<slug> (any subdomain such as uk.,
 *   optional trailing slash or query string) count; anything else → null.
 * - `slug` is the lowercase, URL-decoded path segment after /in/.
 * - `url` is normalized to https://www.linkedin.com/in/<slug>.
 * - Titles look like "Jane Doe - Senior PM - Stripe | LinkedIn": `name` is the part
 *   before the first " - " (or " – "), `headline` the rest without " | LinkedIn".
 * - `snippet` is the result snippet unchanged.
 */
export function parseResult(result: SearchResult): Candidate | null {
  let url: URL;
  try {
    url = new URL(result.url);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
  const match = /^\/in\/([^/]+)\/?$/.exec(url.pathname);
  if (!match?.[1]) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(match[1]).toLowerCase();
  } catch {
    return null;
  }

  const title = result.title.replace(/\s*\|\s*LinkedIn\s*$/i, "").trim();
  const sep = /\s[-–]\s/.exec(title);
  return {
    slug,
    name: (sep ? title.slice(0, sep.index) : title).trim(),
    headline: sep ? title.slice(sep.index + sep[0].length).trim() : "",
    snippet: result.snippet,
    url: `https://www.linkedin.com/in/${slug}`,
  };
}

/**
 * Runs every query and returns unique candidates.
 *
 * Contract:
 * - Queries run in parallel (Promise.allSettled): one failing query must not fail the run.
 * - Results go through parseResult; nulls are dropped.
 * - Deduplicated by slug (first occurrence wins).
 * - Throws only if EVERY query failed.
 *
 * Hints: `import { search } from "../lib/search-provider"`.
 */
export async function runSearch(env: Env, queries: string[]): Promise<Candidate[]> {
  const settled = await Promise.allSettled(queries.map((q) => search(env, q)));
  const failures = settled.filter((r) => r.status === "rejected");
  if (queries.length > 0 && failures.length === queries.length) {
    throw new Error(`Every search query failed: ${String(failures[0]?.reason)}`);
  }

  const bySlug = new Map<string, Candidate>();
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    for (const result of r.value) {
      const c = parseResult(result);
      if (c && !bySlug.has(c.slug)) bySlug.set(c.slug, c);
    }
  }
  return [...bySlug.values()];
}

/**
 * Asks the LLM for up to MAX_QUERIES search angles, then builds a query string for each.
 *
 * Contract:
 * - Returns 1..MAX_QUERIES unique X-ray strings made by buildXray.
 * - Angles should vary: alumni in target roles, target companies × roles, adjacent
 *   roles, people who made the same career switch, etc.
 *
 * Hints: `import { chatJSON } from "../lib/llm"` with
 * `z.object({ specs: z.array(XraySpec) })` as the schema, then map through buildXray.
 */
export async function generateQueries(env: Env, context: string): Promise<string[]> {
  const { preferences, rubric, documents } = splitContext(context);
  const { specs } = await chatJSON(
    env,
    [
      {
        role: "system",
        content: `You plan LinkedIn searches to find mentors for a student's coffee chats.

Return ${MAX_QUERIES} search specs. Each spec becomes one Google-style query restricted to LinkedIn profiles:
- titles: 1-3 job titles, OR'd together (e.g. "product manager", "PM").
- keywords: 0-1 term that must appear (usually the industry, e.g. fintech). Every keyword narrows the results a lot.
- companies: 0-4 real company names, OR'd together. Never a description like "Chicago startup".
- schools: 0-2 schools, OR'd together (the student's own school finds alumni).
- location: one city or region, only if the student cares about location.

The student's interview preferences are what they want; their documents are background. When the two conflict, follow the preferences. The scoring rubric shows what matters most to them, so aim most specs at the criteria worth the most points.

Vary the angles across specs:
- alumni of the student's school in their target roles
- people at the student's past employers (from their documents) who now hold target roles, or target companies' people who list those employers
- target companies × target roles
- adjacent roles in the target industry, especially ones the student said they are open to
- people who made the same career switch or took the same path
- the target role in the preferred location

Rules:
- Use only facts from the student's information. Don't invent schools, past employers or goals.
- You may add well-known real companies that clearly fit what the student described. If they give examples ("labs like OpenAI") or a category ("AI inference startups"), include similar companies in that category, not only the ones named.
- Write company and school names in full, the way they appear on LinkedIn: "Google DeepMind", never "GDM"; "University of Chicago", never "UChicago".
- Match titles to what they asked for, including the exact titles people in that field use (e.g. "member of technical staff" at AI labs). If they gave a seniority preference, use titles at that level; if not, don't.
- Only set location when the student wants one or two specific places and doesn't accept remote. Otherwise leave it out.
- Keep each spec broad enough to return results: besides titles, fill in at most 2 fields.
- Skip companies or paths the student wants to avoid.
- Every spec must be different.`,
      },
      {
        role: "user",
        content: `<preferences>
${preferences || "No interview yet."}
</preferences>

<rubric>
${rubric || "None yet."}
</rubric>

<documents>
${documents || "No documents yet."}
</documents>`,
      },
    ],
    z.object({ specs: z.array(XraySpec) }),
  );
  const queries = [...new Set(specs.map(buildXray))].slice(0, MAX_QUERIES);
  if (queries.length === 0) throw new Error("The LLM returned no search queries");
  return queries;
}
