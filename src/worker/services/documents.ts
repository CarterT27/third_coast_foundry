// OWNER: Ania
// Implement the function body. Do not change the signature.
import type { UploadKind } from "../../shared/schemas";
import type { Env } from "../env";
import { chat } from "../lib/nvidia";

const FOCUS: Record<UploadKind, string> = {
  resume:
    "This is a resume. Capture education (schools, degrees, majors, graduation year), every job and internship " +
    "(company, title, dates, one line on what they did), technical and professional skills, projects, " +
    "leadership roles, clubs, awards, and location.",
  transcript:
    "This is an academic transcript. Capture the school, degree and major/minor, expected graduation, overall and " +
    "major GPA if shown, honors, and the standout courses (advanced, specialized, or with top grades). " +
    "Group courses by field rather than listing every one.",
  linkedin:
    "This is a LinkedIn profile export. Capture the headline, current location, the About summary in brief, every " +
    "role (company, title, dates), education, skills, certifications, volunteering, and groups or organizations.",
};

const SYSTEM = `You write short context notes about a student that are later used to find mentors for coffee chats.

Write a plain-text note of roughly 150-400 words about the person in the document.
- Keep the facts that matter for finding mentors: schools, majors, standout courses and grades, companies, roles, skills, clubs, affiliations, location, and stated interests.
- Use only facts that appear in the document. Never guess or invent anything. If something is unclear, leave it out.
- Write plain text only: no JSON, no markdown headings, no code fences. Short labeled lines like "Education: ..." are fine.`;

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
  const note = await chat(
    env,
    [
      { role: "system", content: `${SYSTEM}\n\n${FOCUS[kind]}` },
      { role: "user", content: `Document type: ${kind}\n\n<document>\n${text}\n</document>` },
    ],
    { temperature: 0.2, maxTokens: 800 },
  );
  return note
    .replace(/^```[a-z]*\n?|\n?```$/g, "")
    .trim();
}
