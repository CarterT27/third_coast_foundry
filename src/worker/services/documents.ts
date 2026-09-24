// OWNER: Ania
// Implement the function body. Do not change the signature.
import type { UploadKind } from "../../shared/schemas";
import type { Env } from "../env";
import { chat } from "../lib/llm";

type Section = [label: string, what: string];

const SECTIONS: Record<UploadKind, { intro: string; sections: Section[] }> = {
  resume: {
    intro: "This is a resume.",
    sections: [
      ["Education", "each school: degree, majors and minors, GPA, graduation date as written, scholarships"],
      ["Advanced coursework", "relevant or advanced courses the resume lists, by name"],
      [
        "Experience",
        "every job, internship, research and teaching role: organization, title, dates, one short line on what they did",
      ],
      ["Projects", "each project or venture: name, their role, dates, one short line on the main result"],
      ["Awards", "awards, competitions and honors, with placement"],
      ["Leadership & activities", "clubs, boards, volunteering and programs, with their role"],
      ["Skills", "technical and professional skills and tools"],
      ["Languages", "spoken languages (not programming languages)"],
      ["Location", "the city or region where they live, only if written"],
      ["Interests", "interests the resume states outright"],
    ],
  },
  transcript: {
    intro:
      "This is an academic transcript. It may contain several schools' transcripts in one file, each " +
      "starting with its own header; include every school's record, however much text separates them.",
    sections: [
      ["Education", "each school on its own: school, college, degree, majors and minors, graduation date if printed"],
      ["GPA", "the cumulative GPA for each school, named with the school; a major GPA only if printed"],
      ["Honors", "honors printed on this person's record (for example dean's list), with the school and terms"],
      [
        "Advanced coursework",
        "every upper-division, graduate-level or honors course, judged by the school's course numbering, " +
          "with school, course code, title and grade. Not introductory, calculus, writing or general-education courses",
      ],
      ["Other coursework", "the remaining courses, summarized in a few words per subject area, without grades"],
    ],
  },
  linkedin: {
    intro: "This is a LinkedIn profile export.",
    sections: [
      ["Headline", "their LinkedIn headline"],
      ["Location", "current location as written"],
      ["About", "the About summary in one or two sentences"],
      ["Experience", "every role: company, title, dates"],
      ["Education", "schools, degrees, fields, years"],
      ["Advanced coursework", "advanced courses, if the profile lists any"],
      ["Skills & certifications", "listed skills and certifications"],
      ["Volunteering & groups", "volunteering, groups and organizations"],
    ],
  },
};

const SYSTEM = `You write short context notes about a person that are later used to find mentors for coffee chats.

Rules:
- Use only facts printed in the document about this user. Never guess, infer or invent anything, such as an expected graduation date, a GPA or an honor that isn't printed. If something is unclear, leave it out.
- A document may cover more than one school, or be several documents combined. Keep each school separate and attribute every degree, course, GPA and honor to the school it belongs to.
- Ignore boilerplate: watermarks, page headers and footers, grading legends, registrar and policy text, and the institution's own address. Use it only to interpret the record, never as facts about the user.
- Leave out phone numbers, email addresses, street addresses, profile URLs, and ID or social security numbers.
- Aim for 150-400 words. Keep each fact short instead of copying sentences.
- Write plain text only: no JSON, no markdown, no bullet symbols, no code fences.`;

/** Watermarks show up as one phrase repeated across a line; they drown out the real record. */
const WATERMARK = /(.{20,}?).*\1/;

/** Matches "none" / "not printed" style filler the model writes despite being told not to. */
const FILLER = /\b(?:none|n\/a|not (?:printed|listed|specified|shown|stated|provided|mentioned|available))\b/i;

/** Keeps only the kind's labeled lines and strips filler, falling back to the raw note. */
function tidy(kind: UploadKind, note: string): string {
  const labels = SECTIONS[kind].sections.map(([label]) => `${label}:`);
  const lines = note
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => labels.some((label) => line.startsWith(label)))
    .map((line) =>
      line
        .split(/(?<=[;,])\s+/)
        .filter((part, i) => i === 0 || !FILLER.test(part))
        .join(" ")
        .replace(/[;,]$/, ""),
    )
    .filter((line) => !FILLER.test(line.slice(line.indexOf(":") + 1, line.indexOf(":") + 20)));
  return lines.length ? lines.join("\n") : note;
}

function instructions(kind: UploadKind): string {
  const { intro, sections } = SECTIONS[kind];
  const lines = sections.map(([label, what]) => `${label}: ${what}`).join("\n");
  return (
    `${intro} Write the note as exactly these labeled lines, in this order, one line per label ` +
    `("Label: facts"). Use no other labels and no title or name line. If the document has nothing ` +
    `for a label, leave that line out completely: never write "none", "not listed" or "not specified", ` +
    `and add no commentary.\n\n${lines}`
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
 * - `import { chat } from "../lib/llm"` and make ONE call: a system message
 *   describing the note you want, and a user message containing `kind` and `text`.
 * - Tailor the instructions per `kind` (a transcript needs courses and GPA; a
 *   LinkedIn export needs headline, roles and groups).
 */
export async function extractContext(env: Env, kind: UploadKind, text: string): Promise<string> {
  const cleaned = text
    .split("\n")
    .filter((line) => !WATERMARK.test(line))
    .join("\n");
  const note = await chat(
    env,
    [
      { role: "system", content: `${SYSTEM}\n\n${instructions(kind)}` },
      { role: "user", content: `Document type: ${kind}\n\n<document>\n${cleaned}\n</document>` },
    ],
    { temperature: 0.2, maxTokens: 1000 },
  );
  return tidy(kind, note.replace(/^```[a-z]*\n?|\n?```$/g, "").trim());
}
