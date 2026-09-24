// OWNER: Carter
// Implement the function body. Do not change the signature.
import { z } from "zod";
import type { Candidate, Score } from "../../shared/schemas";
import type { Env } from "../env";
import { chatJSON } from "../lib/llm";

/**
 * Scores one batch (≤ SCORE_BATCH_SIZE) of candidates against the user's context
 * with a fixed rubric. pipeline.ts calls this once per batch, in parallel, and ranks
 * everything by score — so scores from different batches must mean the same thing.
 *
 * Contract:
 * - Returns exactly one Score per input candidate, matched by `slug`.
 *   Drop any slug the model invents; give missing candidates score 0.
 * - `score` is an integer 0–100 on an ABSOLUTE scale (not relative to the batch).
 * - `reason` is one sentence citing evidence from the candidate's headline/snippet.
 *
 * Hints:
 * - `import { chatJSON } from "../lib/llm"` with `z.object({ scores: z.array(Score) })`.
 * - Keep batches consistent with a rubric that anchors each band with examples, e.g.
 *   90+ = target role AND industry AND shared school; 70 = target role, adjacent
 *   industry; 40 = related field only; <20 = recruiter/student/unrelated.
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
const RawScores = z.object({
  scores: z.array(z.object({ slug: z.string(), score: z.number(), reason: z.string() })),
});

/** One LLM call; returns scores keyed by slug, only for the given candidates. */
async function requestScores(env: Env, context: string, candidates: Candidate[]): Promise<Map<string, Score>> {
  const list = candidates
    .map((c) => `slug: ${c.slug}\nname: ${c.name}\nheadline: ${c.headline}\nsnippet: ${c.snippet}`)
    .join("\n\n");
  const { scores } = await chatJSON(
    env,
    [
      {
        role: "system",
        content: `You score LinkedIn profiles as potential mentors for a student, using a fixed rubric.

Rubric (absolute, the same for every list you see):
- 90-100: works in the student's target role AND target industry, AND shares a school or background with them.
- 70-89: target role in an adjacent industry, or target industry in a closely related role.
- 40-69: related field only, e.g. a similar function in an unrelated industry, or a different function (like engineering) in the target industry.
- 20-39: weak connection to the student's goals.
- 0-19: recruiter, current student, unrelated field, or too little information to judge.

Rules:
- Score each person on the rubric alone, never relative to the others in the list.
- The score is a whole number from 0 to 100.
- The reason is one sentence citing evidence from that person's headline or snippet.
- Use only facts in the student's context and the profile. Never invent employers, titles or schools.
- Return exactly one entry per person, using the slug exactly as given.

The student's context:
<context>
${context.trim() || "Nothing known yet."}
</context>`,
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
