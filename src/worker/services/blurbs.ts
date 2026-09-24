// OWNER: Tigo
// Implement the function body. Do not change the signature.
import type { Blurb, Mentor } from "../../shared/schemas";
import type { Env } from "../env";

/**
 * Writes a short "why you should meet this person" note for each chosen mentor.
 * Blurbs are cached in the database and only rewritten when the user's context changes.
 *
 * Contract:
 * - Returns exactly one Blurb per input mentor, matched by `slug`.
 * - Each blurb is 2–3 sentences addressed to the user ("You both…"): why this person
 *   is relevant to the user's goals, plus one concrete thing to ask them.
 * - Only uses facts from `context` and the mentor's headline/snippet/reason — never
 *   invent employers, titles or shared history.
 *
 * Hints: `import { chatJSON } from "../lib/llm"` with
 * `z.object({ blurbs: z.array(Blurb) })`; one call for the whole list (≤ TOP_N).
 */
export async function writeBlurbs(env: Env, context: string, mentors: Mentor[]): Promise<Blurb[]> {
  throw new Error("TODO: implement writeBlurbs (services/blurbs.ts)");
}
