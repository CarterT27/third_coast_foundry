// OWNER: Ania
// Implement the function body. Do not change the signature.
import type { UploadKind } from "../../shared/schemas";
import type { Env } from "../env";

/**
 * Turns the raw text of one uploaded PDF into a plaintext "context note" that every
 * later LLM step reads (query generation, scoring, blurbs).
 *
 * Contract:
 * - Returns plain text (no JSON, no markdown code fences), roughly 150–400 words.
 * - Keeps facts that matter for finding mentors: schools, majors, standout courses and
 *   grades, companies, roles, skills, clubs, location, interests.
 * - Never invents facts that aren't in `text`.
 *
 * Hints:
 * - `import { chat } from "../lib/nvidia"` and make ONE call: a system message
 *   describing the note you want, and a user message containing `kind` and `text`.
 * - Tailor the instructions per `kind` (a transcript needs courses and GPA; a
 *   LinkedIn export needs headline, roles and groups).
 */
export async function extractContext(env: Env, kind: UploadKind, text: string): Promise<string> {
  throw new Error("TODO: implement extractContext (services/documents.ts)");
}
