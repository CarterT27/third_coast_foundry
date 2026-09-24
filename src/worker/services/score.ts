// OWNER: Carter
// Implement the function body. Do not change the signature.
import { z } from "zod";
import type { Candidate, Score } from "../../shared/schemas";
import type { Env } from "../env";
import { chatJSON } from "../lib/llm";
import { splitContext } from "./interview";

/** Used until the student finishes the interview, which writes their own rubric. */
const DEFAULT_RUBRIC = `- Role (up to 35): full points if they work in the student's target role; about half if in a closely related role; otherwise 0.
- Industry and employer (up to 35): full points if they work in the student's target industry or at a target company; about half if in an adjacent industry; otherwise 0.
- Shared background (up to 20): full points if they share a school or past employer with the student; about half if they share a city or affinity group; otherwise 0.
- Stage (up to 10): full points if they are a few years ahead on the path the student wants; about half if they are much more senior; otherwise 0.
Caps (these override the points):
- Recruiters, talent acquisition or HR staff, and current students: at most 10.
- Too little information in the headline and snippet to judge: at most 20.`;

/**
 * Scores one batch (≤ SCORE_BATCH_SIZE) of candidates against the user's context
 * with the student's own rubric (written once by summarize and stored in the interview
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
 *   anything the student wants to avoid), so a score means the same in every batch.
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
// `points` is the model's working (points per criterion, then caps), written before the
// score so the total follows from it; it isn't stored.
const RawScores = z.object({
  scores: z.array(
    z.object({ slug: z.string(), points: z.string().optional(), score: z.number(), reason: z.string() }),
  ),
});

/** One LLM call; returns scores keyed by slug, only for the given candidates. */
async function requestScores(env: Env, context: string, candidates: Candidate[]): Promise<Map<string, Score>> {
  const list = candidates
    .map((c) => `slug: ${c.slug}\nname: ${c.name}\nheadline: ${c.headline}\nsnippet: ${c.snippet}`)
    .join("\n\n");
  const { preferences, rubric, documents } = splitContext(context);
  const { scores } = await chatJSON(
    env,
    [
      {
        role: "system",
        content: `You score LinkedIn profiles as potential mentors for one student, using that student's own rubric.

<rubric>
${rubric || DEFAULT_RUBRIC}
</rubric>

Reading a profile:
- Where someone works now comes only from their headline, the "Experience:" field, or a first-person statement ("I joined X", "I'm a research scientist at X"). A job ad, "we're hiring", a reshared or congratulatory post, an event write-up or a list of companies they mention is NOT evidence they work there.
- A headline that is only a company name shows the employer but not the role. Award role points only if the snippet names their job.
- Words like "ex-", "previously", "former" and the "Education:" field are past history: use them for shared background, not for their current employer.
- Anyone still in school is a current student and gets the student cap: an undergraduate, a PhD student ("heading back to my PhD"), or an intern. A graduation year in the past ("MIT '25") alone doesn't make someone a student.
- Take titles as written. A founder, director or recruiter is not a research engineer unless the profile says so.

How to score:
- Go through the criteria one by one and award full, about half, or 0 points using only that evidence. If the evidence isn't there, award 0 for that criterion; never assume.
- Write that working in "points" first, e.g. "Employer 40 + Role 12 + Shared background 0 + Location 10 = 62; no cap". Then "score" is exactly that total after any cap: a whole number from 0 to 100.
- The "too little information" cap applies only when you can't tell their employer or their role at all.
- A score of 90 or more needs full points on the criteria worth the most AND at least half on every other criterion. Being at the right company alone never reaches 90 when the rubric also rewards role or shared background.
- Score each person on the rubric alone, never relative to the others in the list.
- The reason is one sentence naming only the criteria this person actually earned points for, quoting the evidence (e.g. "Research Engineer at Google DeepMind; ex-Palantir like the student"). Don't restate the rubric's wording, mention points or arithmetic, or claim a match the profile doesn't show.
- Return each entry as {"slug", "points", "score", "reason"}, in that order.
- Use only facts in the student's information and the profile. Never invent employers, titles or schools.
- Return exactly one entry per person, using the slug exactly as given.

What the student said they want in the interview. Where it conflicts with their documents, this wins:
<preferences>
${preferences || "No interview yet."}
</preferences>

Background from the student's documents (use it for shared schools and past employers):
<documents>
${documents || "Nothing known yet."}
</documents>`,
      },
      { role: "user", content: list },
    ],
    RawScores,
    { maxTokens: 2000 },
  );
  const wanted = new Set(candidates.map((c) => c.slug));
  const bySlug = new Map<string, Score>();
  for (const s of scores) {
    if (!wanted.has(s.slug) || bySlug.has(s.slug) || !Number.isFinite(s.score)) continue;
    bySlug.set(s.slug, {
      slug: s.slug,
      score: Math.min(100, Math.max(0, Math.round(s.score))),
      reason: s.reason.trim() || "No reason given.",
    });
  }
  return bySlug;
}
