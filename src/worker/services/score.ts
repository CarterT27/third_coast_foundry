// OWNER: Carter
// Implement the function body. Do not change the signature.
import type { Candidate, Score } from "../../shared/schemas";
import type { Env } from "../env";

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
  throw new Error("TODO: implement scoreBatch (services/score.ts)");
}
