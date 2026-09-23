// OWNER: medium-experience teammate
// Implement the function bodies. Do not change the signatures.
// Suggested order: buildXray → parseResult → runSearch → generateQueries (tests cover all four).
import type { Candidate, XraySpec } from "../../shared/schemas";
import type { Env } from "../env";
import type { SearchResult } from "../lib/search-provider";

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
  throw new Error("TODO: implement buildXray (services/search.ts)");
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
  throw new Error("TODO: implement parseResult (services/search.ts)");
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
  throw new Error("TODO: implement runSearch (services/search.ts)");
}

/**
 * Asks the LLM for up to MAX_QUERIES search angles, then builds a query string for each.
 *
 * Contract:
 * - Returns 1..MAX_QUERIES unique X-ray strings made by buildXray.
 * - Angles should vary: alumni in target roles, target companies × roles, adjacent
 *   roles, people who made the same career switch, etc.
 *
 * Hints: `import { chatJSON } from "../lib/nvidia"` with
 * `z.object({ specs: z.array(XraySpec) })` as the schema, then map through buildXray.
 */
export async function generateQueries(env: Env, context: string): Promise<string[]> {
  throw new Error("TODO: implement generateQueries (services/search.ts)");
}
