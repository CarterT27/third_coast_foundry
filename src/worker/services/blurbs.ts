// OWNER: Tigo
// Implement the function body. Do not change the signature.
import { z } from "zod";
import { Blurb, type Mentor } from "../../shared/schemas";
import type { Env } from "../env";
import { chatJSON } from "../lib/llm";

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
  if (mentors.length === 0) return [];
  const bySlug = await requestBlurbs(env, context, mentors);
  // The model occasionally skips someone; ask once more for just those.
  const missing = mentors.filter((m) => !bySlug.get(m.slug));
  if (missing.length > 0) {
    for (const [slug, blurb] of await requestBlurbs(env, context, missing)) bySlug.set(slug, blurb);
  }
  // Still missing: fall back to the scoring reason so every mentor gets one.
  return mentors.map((m) => ({ slug: m.slug, blurb: bySlug.get(m.slug) || m.reason }));
}

/** One LLM call; returns non-empty blurbs keyed by slug, only for the given mentors. */
async function requestBlurbs(env: Env, context: string, mentors: Mentor[]): Promise<Map<string, string>> {
  const list = mentors
    .map((m) => `slug: ${m.slug}\nname: ${m.name}\nheadline: ${m.headline}\nsnippet: ${m.snippet}\nwhy they match: ${m.reason}`)
    .join("\n\n");
  const { blurbs } = await chatJSON(
    env,
    [
      {
        role: "system",
        content: `You write short notes telling someone why a person is worth a coffee chat.

For every mentor, write one blurb of 2-3 sentences addressed to the user ("You both...", "They..."):
- Why this person is relevant to the user's goals.
- One concrete thing the user could ask them.

Rules:
- Use only facts from the user's context and the mentor's headline, snippet and "why they match". Never invent employers, titles, schools or shared history.
- If you aren't sure of a fact, leave it out.
- Refer to the mentor by first name or "they/them". Never guess pronouns like "he" or "she" from a name.
- Plain text only: no markdown, no emojis.
- Return exactly one blurb per mentor, using the slug exactly as given.

The user's context:
<context>
${context.trim() || "Nothing known yet."}
</context>`,
      },
      { role: "user", content: list },
    ],
    z.object({ blurbs: z.array(Blurb) }),
    { temperature: 0.4, maxTokens: 3000 },
  );
  const wanted = new Set(mentors.map((m) => m.slug));
  return new Map(blurbs.filter((b) => wanted.has(b.slug) && b.blurb.trim()).map((b) => [b.slug, b.blurb.trim()]));
}
