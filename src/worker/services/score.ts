// OWNER: Carter
// Implement the function body. Do not change the signature.
import { z } from "zod";
import type { Candidate, Score } from "../../shared/schemas";
import type { Env } from "../env";
import { chatJSON } from "../lib/llm";
import { splitContext } from "./interview";

/** Used until the user finishes the interview, which writes their own rubric. */
const DEFAULT_RUBRIC = `- Role (up to 35): full points if they work in the user's target role; about half if in a closely related role; otherwise 0.
- Industry and employer (up to 35): full points if they work in the user's target industry or at a target company; about half if in an adjacent industry; otherwise 0.
- Shared background (up to 20): full points if they share a school or past employer with the user; about half if they share a city or affinity group; otherwise 0.
- Stage (up to 10): full points if they are a few years ahead on the path the user wants; about half if they are much more senior; otherwise 0.
Caps (these override the points):
- Recruiters, talent acquisition or HR staff, and current students: at most 10.
- Too little information in the headline and snippet to judge: at most 20.`;

/**
 * Scores one batch (≤ SCORE_BATCH_SIZE) of candidates against the user's context
 * with the user's own rubric (written once by summarize and stored in the interview
 * note; DEFAULT_RUBRIC until then). pipeline.ts calls this once per batch, in parallel,
 * and ranks everything by score — so scores from different batches must mean the same
 * thing, which is why the rubric is read from context rather than written per batch.
 *
 * Contract:
 * - Returns exactly one Score per input candidate, matched by `slug`.
 *   Drop any slug the model invents; give missing candidates score 0.
 * - `score` is an integer 0–100 on an ABSOLUTE scale (not relative to the batch).
 * - `reason` is one sentence citing evidence from the candidate's headline/snippet.
 *
 * Hints:
 * - `import { chatJSON } from "../lib/llm"` with `z.object({ scores: z.array(Score) })`.
 * - The rubric is points per criterion summing to 100, plus caps (recruiters, students,
 *   anything the user wants to avoid), so a score means the same in every batch.
 * - temperature 0 (chatJSON's default).
 */
export async function scoreBatch(env: Env, context: string, candidates: Candidate[]): Promise<Score[]> {
  if (candidates.length === 0) return [];
  const bySlug = await requestScores(env, context, candidates);
  // A missing candidate would be saved as 0 for this context version, so ask once more.
  const missing = candidates.filter((c) => !bySlug.has(c.slug));
  if (missing.length > 0) {
    try {
      for (const [slug, score] of await requestScores(env, context, missing)) bySlug.set(slug, score);
    } catch {
      // Keep the scores we already have; the rest fall back to 0 below.
    }
  }
  return candidates.map((c) => bySlug.get(c.slug) ?? { slug: c.slug, score: 0, reason: "" });
}

// Looser than the shared Score so an out-of-range or fractional score doesn't fail the
// whole batch; requestScores rounds and clamps it instead.
// `awards` are the criteria a person earned points on, each with a quote from their profile,
// and `caps` a verdict on every cap by its number (asking about each cap keeps the model from
// skipping them; numbering them keeps a miscounted list from shifting every verdict). When the rubric can be read, the score is
// computed from these in code (so the arithmetic and caps are exact, and a point without
// evidence on the profile doesn't count); otherwise the model's own `score` is used.
const RawScores = z.object({
  scores: z.array(
    z.object({
      slug: z.string(),
      awards: z
        .array(z.object({ criterion: z.string(), level: z.enum(["full", "half"]), quote: z.string() }))
        .optional(),
      caps: z.array(z.object({ cap: z.number(), applies: z.boolean() })).optional(),
      score: z.number(),
      reason: z.string(),
    }),
  ),
});
type RawScore = z.infer<typeof RawScores>["scores"][number];

/** `absent`: for a "mention none of: a, b, c" cap, the words whose absence triggers it. */
type ParsedRubric = { criteria: { name: string; points: number }[]; caps: { text: string; max: number; absent: string[] }[] };

/** The words listed in a "Their headline and snippet mention none of: a, b, c: at most N." cap. */
function absentTerms(cap: string): string[] {
  const listed = /mention none of:?\s*(.+?):\s*at most/i.exec(cap)?.[1];
  if (!listed) return [];
  return listed
    .split(/,|\bor\b|\band\b/i)
    .map((t) => normalize(t))
    .filter(Boolean);
}

/** Reads "- Name (up to N): …" criteria and "…: at most N." caps; null if there are no criteria. */
function parseRubric(rubric: string): ParsedRubric | null {
  const capsAt = rubric.search(/^Caps\b/m);
  const body = capsAt >= 0 ? rubric.slice(0, capsAt) : rubric;
  const criteria = [...body.matchAll(/^- (.+?) \(up to (\d+)\)/gm)].map((m) => ({ name: m[1].trim(), points: Number(m[2]) }));
  if (criteria.length === 0) return null;
  const caps =
    capsAt < 0
      ? []
      : rubric
          .slice(capsAt)
          .split("\n")
          .filter((line) => line.startsWith("- "))
          .map((line) => ({
            text: line.slice(2).trim(),
            max: Number(/at most (\d+)/i.exec(line)?.[1] ?? 100),
            absent: absentTerms(line),
          }));
  return { criteria, caps };
}

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^\p{L}\p{N}&+#]+/gu, " ")
    .trim();

/** True if the quote is on the profile: verbatim, or nearly every word of it. */
function onProfile(quote: string, profile: string): boolean {
  const q = normalize(quote);
  if (!q) return false;
  if (profile.includes(q)) return true;
  const words = q.split(" ").filter((w) => w.length > 2);
  if (words.length === 0) return false;
  const found = words.filter((w) => profile.includes(w)).length;
  return found / words.length >= 0.8;
}

/** Someone still in school: says so in the headline, or lists a .edu email. */
const STUDENT = /\b(student|undergrad(uate)?|phd candidate|class of 20\d\d)\b/i;
const EDU_EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)*\.edu\b/i;
/** A headline that is only a place or LinkedIn's placeholder, with no Experience field. */
const BLANK_HEADLINE = /^(?:[^|·]*,\s*)?(?:United States|Professional Profile)\s*$|\|\s*Professional Profile\s*$/i;

/** Caps every rubric has, enforced here too because the model sometimes skips them. */
function fixedCap(c: Candidate): number {
  if (STUDENT.test(c.headline) || EDU_EMAIL.test(c.snippet)) return 10;
  if (!/Experience:/.test(c.snippet) && (!c.headline.trim() || BLANK_HEADLINE.test(c.headline))) return 20;
  return 100;
}

/** The score from the model's awards and caps under the parsed rubric. */
function computeScore(raw: RawScore, rubric: ParsedRubric, c: Candidate): number {
  const profile = normalize(`${c.name} ${c.headline} ${c.snippet}`);
  const byName = new Map(rubric.criteria.map((cr) => [normalize(cr.name), cr.points]));
  const awarded = new Map<string, number>();
  for (const a of raw.awards ?? []) {
    const points = byName.get(normalize(a.criterion));
    if (points === undefined || !onProfile(a.quote, profile)) continue;
    const earned = a.level === "full" ? points : points / 2;
    awarded.set(normalize(a.criterion), Math.max(awarded.get(normalize(a.criterion)) ?? 0, earned));
  }
  let score = [...awarded.values()].reduce((sum, p) => sum + p, 0);
  for (const { cap, applies } of raw.caps ?? []) {
    const max = rubric.caps[cap - 1]?.max;
    if (applies && max !== undefined) score = Math.min(score, max);
  }
  // "Mention none of" caps are checked here too: the model sometimes credits a title as a sign.
  const padded = ` ${profile} `;
  for (const cap of rubric.caps) {
    const mentioned = cap.absent.some((t) => padded.includes(` ${t} `) || padded.includes(` ${t}s `));
    if (cap.absent.length && !mentioned) score = Math.min(score, cap.max);
  }
  return score;
}

/** One LLM call; returns scores keyed by slug, only for the given candidates. */
async function requestScores(env: Env, context: string, candidates: Candidate[]): Promise<Map<string, Score>> {
  const list = candidates
    .map((c) => `slug: ${c.slug}\nname: ${c.name}\nheadline: ${c.headline}\nsnippet: ${c.snippet}`)
    .join("\n\n");
  const { preferences, rubric, documents } = splitContext(context);
  const rubricText = rubric || DEFAULT_RUBRIC;
  const parsed = parseRubric(rubricText);
  const { scores } = await chatJSON(
    env,
    [
      {
        role: "system",
        content: `You score LinkedIn profiles as potential mentors for one user, using that user's own rubric.

<rubric>
${rubricText}
</rubric>
${parsed?.caps.length ? `\nThe caps, numbered:\n${parsed.caps.map((c, i) => `${i + 1}. ${c.text}`).join("\n")}\n` : ""}
Reading a profile:
- Where someone works now comes only from their headline, the "Experience:" field, or a first-person statement ("I joined X", "I'm a research scientist at X"). A job ad, "we're hiring", a reshared or congratulatory post, an event write-up or a list of companies they mention is NOT evidence they work there.
- A headline that is only a company name shows the employer but not the role. Award role points only if the snippet names their job.
- Words like "ex-", "previously", "former" and the "Education:" field are past history: use them for shared background, not for their current employer.
- Anyone still in school is a current student and gets the student cap: an undergraduate, a PhD student ("heading back to my PhD"), an intern, someone whose headline is their major or program at a university ("Finance & Economics @ Rice University"), or someone listing a .edu email. A graduation year in the past ("MIT '25") alone doesn't make someone a student.
- Take titles as written. A founder, director or recruiter is not a research engineer unless the profile says so. Seniority comes from the title: analyst, associate, engineer, researcher or trader without "senior", "lead", "head", "director", "VP", "partner" or "managing director" is not a senior leader.

How to score:
- Go through the criteria one by one and award full, about half, or 0 points using only that evidence. If the evidence isn't there, award 0 for that criterion; never assume.
- A criterion that asks for two things at once (e.g. "machine learning at a quant firm") earns full points only if the profile shows both. Working at a quant firm or holding a quant title doesn't show machine learning, and vice versa.
- "awards" lists only the criteria that earned points: {"criterion" (its name exactly as in the rubric), "level" ("full" or "half"), "quote"}. The quote is copied word for word from the headline or snippet and shows the evidence, e.g. "Machine Learning Researcher at Two Sigma" or "Location: Houston". No quote, no points.
- "caps" has one {"cap", "applies"} for every numbered cap above, e.g. {"cap": 1, "applies": false}. Check each cap on its own. A cap about something the profile shows ("based outside Houston", "title is not a senior leader") is true when the profile shows it; a cap about a missing quality ("mention none of: machine learning, …") is true whenever the headline and snippet don't show that quality. A quant title, a trading firm or a PhD is not a sign of machine learning.
- The "too little information" cap applies only when you can't tell their employer or their role at all.
- "score" is the total of the awarded points after any cap: a whole number from 0 to 100.
- A score of 90 or more needs full points on the criteria worth the most AND at least half on every other criterion. Being at the right company alone never reaches 90 when the rubric also rewards role or shared background.
- Score each person on the rubric alone, never relative to the others in the list.
- The reason is one sentence naming only the criteria this person actually earned points for, quoting the evidence (e.g. "Research Engineer at Google DeepMind; ex-Palantir like the user"). Don't restate the rubric's wording, mention points or arithmetic, or claim a match the profile doesn't show.
- Return each entry as {"slug", "awards", "caps", "score", "reason"}, in that order.
- Use only facts in the user's information and the profile. Never invent employers, titles or schools.
- Return exactly one entry per person, using the slug exactly as given.

What the user said they want in the interview. Where it conflicts with their documents, this wins:
<preferences>
${preferences || "No interview yet."}
</preferences>

Background from the user's documents (use it for shared schools and past employers):
<documents>
${documents || "Nothing known yet."}
</documents>`,
      },
      { role: "user", content: list },
    ],
    RawScores,
    { maxTokens: 8000 },
  );
  const bySlugIn = new Map(candidates.map((c) => [c.slug, c]));
  const bySlug = new Map<string, Score>();
  for (const s of scores) {
    const c = bySlugIn.get(s.slug);
    if (!c || bySlug.has(s.slug) || !Number.isFinite(s.score)) continue;
    const score = parsed && s.awards ? computeScore(s, parsed, c) : s.score;
    bySlug.set(s.slug, {
      slug: s.slug,
      score: Math.min(fixedCap(c), 100, Math.max(0, Math.round(score))),
      reason: s.reason.trim() || "No reason given.",
    });
  }
  return bySlug;
}
