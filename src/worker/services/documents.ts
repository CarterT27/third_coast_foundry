// OWNER: Ania
// Implement the function body. Do not change the signature.
import type { UploadKind } from "../../shared/schemas";
import type { Env } from "../env";
import { chat } from "../lib/nvidia";

type Section = [label: string, what: string];

const SECTIONS: Record<UploadKind, { intro: string; sections: Section[] }> = {
  resume: {
    intro: "This is a resume.",
    sections: [
      ["Education", "schools, degrees, majors and minors, GPA, graduation year, scholarships and academic honors"],
      ["Advanced coursework", "relevant or advanced courses the resume lists, by name"],
      ["Experience", "every job, internship and research role: organization, title, dates, one line on what they did"],
      ["Leadership & activities", "clubs, boards, volunteering, programs and awards, with their role"],
      ["Skills", "technical and professional skills and tools"],
      ["Languages", "spoken languages"],
      ["Location", "where they live or study"],
      ["Interests", "fields and topics their work and activities point to, stated or clearly shown"],
    ],
  },
  transcript: {
    intro: "This is an academic transcript.",
    sections: [
      ["Education", "school, degree, major and minor, expected graduation"],
      ["GPA", "overall and major GPA if shown"],
      ["Honors", "dean's list, honors, awards"],
      [
        "Advanced coursework",
        "every advanced class by its title (upper-level, graduate-level, honors, accelerated, or specialized), " +
          "with the grade when shown",
      ],
      ["Other coursework", "the remaining introductory and general-education courses, summarized briefly by field"],
    ],
  },
  linkedin: {
    intro: "This is a LinkedIn profile export.",
    sections: [
      ["Headline", "their LinkedIn headline"],
      ["Location", "current location"],
      ["About", "the About summary in one or two sentences"],
      ["Experience", "every role: company, title, dates"],
      ["Education", "schools, degrees, fields, years"],
      ["Advanced coursework", "advanced courses, if the profile lists any"],
      ["Skills & certifications", "listed skills and certifications"],
      ["Volunteering & groups", "volunteering, groups and organizations"],
    ],
  },
};

const SYSTEM = `You write short context notes about a student that are later used to find mentors for coffee chats.

Write a plain-text note of roughly 150-400 words about the person in the document.
- Keep the facts that matter for finding mentors: schools, majors, standout courses and grades, companies, roles, skills, clubs, affiliations, location, and stated interests.
- Use only facts that appear in the document. Never guess or invent anything. If something is unclear, leave it out.
- Leave out phone numbers, email addresses, street addresses and profile URLs.
- Write plain text only: no JSON, no markdown, no bullet symbols, no code fences.`;

function instructions(kind: UploadKind): string {
  const { intro, sections } = SECTIONS[kind];
  const lines = sections.map(([label, what]) => `${label}: ${what}`).join("\n");
  return (
    `${intro} Write the note as the labeled lines below, in this order, one line per label ` +
    `("Label: facts"). Skip a line entirely if the document has nothing for it.\n\n${lines}`
  );
}

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
      { role: "system", content: `${SYSTEM}\n\n${instructions(kind)}` },
      { role: "user", content: `Document type: ${kind}\n\n<document>\n${text}\n</document>` },
    ],
    { temperature: 0.2, maxTokens: 800 },
  );
  return note
    .replace(/^```[a-z]*\n?|\n?```$/g, "")
    .trim();
}
