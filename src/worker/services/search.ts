// OWNER: Tigo
// Implement the function bodies. Do not change the signatures.
// Suggested order: buildXray → parseResult → runSearch → generateQueries (tests cover all four).
import { z } from "zod";
import { type Candidate, MAX_QUERIES, XraySpec } from "../../shared/schemas";
import type { Env } from "../env";
import { chatJSON, type LLMMessage } from "../lib/llm";
import { SubrequestLimitError } from "../lib/subrequests";
import { search, SearchCapacityError, type SearchResult } from "../lib/search-provider";
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
  // A `"` inside a term would unbalance the query, and search engines have no escape for it.
  const clean = (terms: string[]) => terms.map((t) => t.replaceAll('"', "").trim()).filter(Boolean);
  const quote = (term: string) => `"${term}"`;
  const orGroup = (terms: string[]) => {
    const kept = clean(terms);
    return kept.length > 0 ? `(${kept.map(quote).join(" OR ")})` : "";
  };
  const [location] = clean(spec.location ? [spec.location] : []);
  return [
    "site:linkedin.com/in",
    orGroup(spec.titles),
    ...clean(spec.keywords).map((k) => (/\s/.test(k) ? quote(k) : k)),
    orGroup(spec.companies),
    orGroup(spec.schools),
    location ? quote(location) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Converts one search result into a Candidate, or null if it isn't a profile.
 *
 * Contract:
 * - Only URLs like https://www.linkedin.com/in/<slug> (any subdomain such as uk.,
 *   optional language path like /en or /pt-br, trailing slash or query string) count;
 *   anything else → null. So does a result with no name in its title.
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
  const match = /^\/in\/([^/]+)(?:\/[a-z]{2}(?:[-_][a-z]{2,4})?)?\/?$/i.exec(url.pathname);
  if (!match?.[1]) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(match[1]).toLowerCase();
  } catch {
    return null;
  }

  const title = result.title.replace(/\s*\|\s*LinkedIn\s*$/i, "").trim();
  const sep = /\s[-–]\s/.exec(title);
  const name = (sep ? title.slice(0, sep.index) : title).trim();
  if (!name) return null;
  return {
    slug,
    name,
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
 * - Throws only if EVERY query failed. A SearchCapacityError or SubrequestLimitError is
 *   rethrown as-is, so callers can tell the quota or budget ran out.
 * - `page` asks for the next page of each query's results (see search-provider).
 *
 * Hints: `import { search } from "../lib/search-provider"`.
 */
export async function runSearch(env: Env, queries: string[], page = 0): Promise<Candidate[]> {
  const settled = await Promise.allSettled(queries.map((q) => search(env, q, 20, page)));
  const failures = settled.filter((r) => r.status === "rejected");
  if (queries.length > 0 && failures.length === queries.length) {
    const known = failures.find((f) => f.reason instanceof SearchCapacityError || f.reason instanceof SubrequestLimitError);
    if (known) throw known.reason;
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
  const messages: LLMMessage[] = [
    {
      role: "system",
      content: `You plan LinkedIn searches to find mentors for someone's coffee chats.

Return ${MAX_QUERIES} search specs. Each spec becomes one Google-style query restricted to LinkedIn profiles:
- titles: 1-3 job titles (e.g. "product manager", "PM"). Only the first is searched: an OR of several quoted titles finds far fewer people than one title alone. Put the best short title first.
- keywords: usually empty. At most 1 single word that literally appears on people's profiles (e.g. fintech, neuroscience). Never a descriptive phrase like "frontier AI" or "early-stage": profiles don't say that, so the query finds nobody.
- companies: 0-4 real company names, OR'd together. Never a description like "Chicago startup".
- schools: 0-2 schools, OR'd together (the user's own school finds alumni).
- location: one city, only if the user cares about location. Just the city ("Houston"), never "Houston, Texas": profiles show "Location: Houston", so the longer form finds almost nobody.

Also return:
- targetCompanies: up to 6 companies the user is aiming for (named, or well-known ones that fit), best first.
- skills: if they want a technique applied inside a field (e.g. machine learning at quant trading firms, ML engineers with clinical training), 1-2 names of the technique as profiles write it ("machine learning", "deep learning"); otherwise empty. Never a job title ("machine learning researcher") and never an industry or product ("power", "natural gas", "M&A"). Extra searches pair these with targetCompanies, because a title that combines both finds almost nobody.
- focusWords: if they want people in specific research or focus areas, 1-3 single words those people's profiles contain ("neuroscience", "NLP", "linguistics"); otherwise empty. Research areas go here, not in skills. School searches without a keyword get one of these.
- seniorTitles: if they want senior leaders, 1-3 short senior titles ("managing director", "head of", "partner"); otherwise empty. Extra searches pair these with targetCompanies.

The user's interview preferences are what they want; their documents are background. When the two conflict, follow the preferences. The scoring rubric shows what matters most to them, so aim most specs at the criteria worth the most points.

Vary the angles across specs:
- alumni of the user's school in their target roles (if a shared school matters to the user, give at least 3 specs with the school)
- people at the user's past employers (from their documents) who now hold target roles, or target companies' people who list those employers
- target companies × target roles
- adjacent roles in the target industry, especially ones the user said they are open to
- people who made the same career switch or took the same path
- the target role in the preferred location
- for research at a school: academic titles ("professor", "postdoc", "PhD student", "research assistant") with the school and one focus word as the keyword ("neuroscience", "linguistics"); these find far more people than a focus phrase. Every research spec needs a focus word: an academic title and the school alone return people from every department

Rules:
- Use only facts from the user's information. Don't invent schools, past employers or goals.
- You may add well-known real companies that clearly fit what the user described. If they give examples ("labs like OpenAI") or a category ("AI inference startups"), include similar companies in that category, not only the ones named.
- Write company and school names in full, the way they appear on LinkedIn: "Google DeepMind", never "GDM"; "University of Chicago", never "UChicago".
- Match titles to what they asked for, including the exact titles people in that field use (e.g. "member of technical staff" at AI labs). If they gave a seniority preference, use titles at that level; if not, don't.
- Prefer short, common titles ("trader", "quantitative researcher") over long exact ones ("natural gas scheduler"). A long title plus companies plus a location usually finds nobody.
- For two things together, put the skill in titles, not keywords.
- Only set location when the user wants one or two specific places and doesn't accept remote. Otherwise leave it out. If they said the location is required, set it on every spec.
- Search results rarely show a school next to an exact job title, so specs with a school must use broad one-word titles ("engineer", "research", "researcher") plus the target companies, and no location unless the location is required.
- Keep each spec broad enough to return results: besides titles, fill in at most 2 of keywords, companies, schools and location. Never 3 or more.
- Skip companies or paths the user wants to avoid.
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
  ];
  const plan: SearchPlan = await chatJSON(env, messages, SearchPlan, { maxTokens: 3000 }).catch(
    // The model sometimes breaks the JSON after a long spec list; a plain spec list still works.
    () => chatJSON(env, messages, z.object({ specs: z.array(XraySpec) }), { maxTokens: 3000 }),
  );
  // The skill and senior-title searches are built here rather than left to the model, which
  // tends to write combined titles ("machine learning researcher") that find nobody.
  const companies = (plan.targetCompanies ?? []).filter((c) => c.trim()).slice(0, 6);
  const groups = companies.length > 3 ? [companies.slice(0, 3), companies.slice(3)] : [companies];
  const pairWith = (titles: string[]) =>
    companies.length === 0
      ? []
      : titles
          .filter((t) => t.trim())
          .slice(0, 2)
          .flatMap((title) => groups.map((group) => ({ titles: [title], keywords: [], companies: group, schools: [] })));
  // A "skill" that is really a job title finds nobody next to the companies; skip it.
  const skills = (plan.skills ?? []).filter((t) => !ROLE_NOUN.test(t.trim()));
  const extra = [...pairWith(skills), ...pairWith(plan.seniorTitles ?? [])].slice(0, EXTRA_QUERIES);
  // A school search with no focus word, or a generic one ("computational"), returns people from
  // every department. The pool also takes the words the planner put on its other school searches.
  const schoolOnly = (spec: XraySpec) => spec.schools.length > 0 && spec.companies.length === 0;
  const focus = [
    ...new Set(
      [...(plan.focusWords ?? []), ...(plan.skills ?? []), ...plan.specs.filter(schoolOnly).flatMap((spec) => spec.keywords)]
        .map((w) => w.trim())
        .filter((w) => w && !/\s/.test(w) && !GENERIC_FOCUS.test(w)),
    ),
  ];
  let next = 0;
  const focused = plan.specs.map((spec) =>
    focus.length && schoolOnly(spec) && (spec.keywords.length === 0 || GENERIC_FOCUS.test(spec.keywords[0]))
      ? { ...spec, keywords: [focus[next++ % focus.length]] }
      : spec,
  );
  const specs = [...extra, ...focused];
  const queries = [...new Set(specs.map((spec) => buildXray(narrowest(spec))))].slice(0, MAX_QUERIES);
  if (queries.length === 0) throw new Error("The LLM returned no search queries");
  return queries;
}

/** The planner's answer. The short plan fields come before the long spec list: the model
 * sometimes garbles whatever follows that list. */
const SearchPlan = z.object({
  targetCompanies: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  seniorTitles: z.array(z.string()).optional(),
  focusWords: z.array(z.string()).optional(),
  specs: z.array(XraySpec),
});
type SearchPlan = z.infer<typeof SearchPlan>;

/** Filters besides titles kept per query; every extra one shrinks the results a lot. */
const MAX_FILTERS = 2;

/** Skill × company and senior title × company searches taken from the plan, out of MAX_QUERIES. */
const EXTRA_QUERIES = 4;

/** Words too broad to narrow a school search to a field. */
const GENERIC_FOCUS = /^(computational|research|science|sciences|data|analysis|engineering|studies|technology|systems|modeling|lab|academic|theory)$/i;

/** Ends in a job title word: "machine learning researcher" is a title, not a skill. */
const ROLE_NOUN = /\b(researchers?|engineers?|scientists?|analysts?|traders?|developers?|managers?|associates?|directors?|consultants?|specialists?)$/i;

/**
 * Searches the first title only, since the search engine returns far fewer results for an OR
 * of quoted titles. Keeps the MAX_FILTERS most useful filters, in the order schools, companies, location, keywords
 * (a one-word keyword before the location next to a school),
 * dropping companies next to a city when the title is more than one word.
 * A multi-word keyword is dropped next to a school or companies (it finds almost nobody), and a
 * location is cut to its city ("Houston, Texas" → "Houston"), the form profiles show.
 */
function narrowest(spec: XraySpec): XraySpec {
  let left = MAX_FILTERS;
  const keep = (has: boolean) => has && left-- > 0;
  const schools = keep(spec.schools.length > 0) ? spec.schools : [];
  let companies = keep(spec.companies.length > 0) ? spec.companies : [];
  // A one-word keyword narrows well ("PhD student" + school + neuroscience); a phrase next to a
  // school or companies finds almost nobody. Next to a school it goes before the location, which
  // the school mostly implies anyway.
  const [keyword] = spec.keywords;
  const fits = Boolean(keyword) && ((schools.length === 0 && companies.length === 0) || !/\s/.test(keyword.trim()));
  const early = fits && schools.length > 0 && keep(true);
  const city = spec.location?.split(",")[0].trim();
  const location = keep(Boolean(city)) ? city : undefined;
  // Companies and a city together only find people with a one-word title ("trader").
  if (location && companies.length > 0 && /\s/.test(spec.titles[0]?.trim() ?? "")) companies = [];
  const keywords = early || keep(fits) ? [keyword] : [];
  return { titles: spec.titles.slice(0, 1), keywords, companies, schools, location };
}
