// OWNER: Carter
// Implement the function bodies. Do not change the signatures.
import { z } from "zod";
import type { ChatMessage } from "../../shared/schemas";
import type { Env } from "../env";
import { PublicError } from "../lib/errors";
import { chat, chatJSON, chatStream, type LLMMessage } from "../lib/llm";

/** What the interview must learn. Edit freely; it only shapes the prompt. */
export const INTERVIEW_TOPICS = [
  "target industries",
  "target roles or functions",
  "career timeline (internship, first job, career switch)",
  "preferred locations or remote",
  "what they want from a mentor (recruiting advice, day-in-the-life, technical guidance, etc.)",
  "preferred mentor seniority (a few years ahead vs. senior leader)",
  "shared background that matters to them (same school, first-gen, affinity groups)",
  "companies or paths to avoid",
];

/** Starts the per-user scoring rubric that summarize appends to the interview note. */
export const RUBRIC_HEADING = "SCORING RUBRIC";

/** Caps every rubric gets, whatever the user said. */
const FIXED_CAPS = [
  "Recruiters, talent acquisition or HR staff, and current students: at most 10.",
  "Too little information in the headline and snippet to judge: at most 20.",
];

/** Caps on the conversation sent to the model, so a long interview doesn't make every call huge. */
const HISTORY_CHARS = 16_000;
const OLD_MESSAGE_CHARS = 1_500; // every message but the newest
const ASKED_CHARS = 300; // each earlier question listed in the system prompt
const TRANSCRIPT_CHARS = 24_000; // sent to the summary and the rubric calls when finishing

/**
 * The most recent messages that fit in `maxChars`, older ones cut to OLD_MESSAGE_CHARS.
 * The newest message is always kept.
 */
function recentHistory(messages: ChatMessage[], maxChars: number): ChatMessage[] {
  const kept: ChatMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const content = i === messages.length - 1 ? m.content : clip(m.content, OLD_MESSAGE_CHARS);
    if (kept.length > 0 && used + content.length > maxChars) break;
    kept.unshift({ role: m.role, content });
    used += content.length;
  }
  return kept;
}

function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * Splits the joined context (see db.loadContext) into what the user said in the
 * interview, the rubric written from it, and everything else (the documents).
 * Without section headers the whole string counts as documents.
 */
export function splitContext(context: string): { preferences: string; rubric: string; documents: string } {
  const sections = context.split(/^(?=## [A-Z]+ \()/m);
  const interview = sections.filter((s) => s.startsWith("## INTERVIEW ("));
  const documents = sections.filter((s) => !s.startsWith("## INTERVIEW ("));
  let preferences = interview.join("\n\n");
  let rubric = "";
  const at = preferences.indexOf(RUBRIC_HEADING);
  if (at >= 0) {
    rubric = preferences.slice(at).trim();
    preferences = preferences.slice(0, at);
  }
  return {
    preferences: preferences.replace(/^## INTERVIEW \(.*\)\n?/gm, "").trim(),
    rubric,
    documents: documents.join("").trim(),
  };
}

/**
 * Streams the interviewer's next message.
 *
 * Contract:
 * - `messages` is the conversation so far (may be empty: then open the interview).
 * - `context` is the raw text of every uploaded document (resume, LinkedIn, transcript).
 *   Don't ask about facts it already answers; do reference them ("I see you interned at X…").
 * - Ask ONE question at a time, short and conversational. Cover INTERVIEW_TOPICS;
 *   once all are covered, tell the user they can press "Finish interview".
 * - Yields text chunks as they arrive (the route forwards each one to the browser).
 *
 * Hints: `import { chatStream } from "../lib/llm"`, build a system prompt from
 * `context` + INTERVIEW_TOPICS, then `yield*` the stream.
 */
export async function* nextTurn(env: Env, context: string, messages: ChatMessage[]): AsyncGenerator<string> {
  const asked = messages
    .filter((m) => m.role === "assistant")
    .map((m) => `- ${clip(m.content.replace(/\s+/g, " ").trim(), ASKED_CHARS)}`);
  const system = `You are a friendly career advisor interviewing someone (a student, a working professional or a career switcher) to find them mentors for coffee chats.

What we already know about the user: the raw text of their uploaded PDFs (resume, LinkedIn, transcript). It may be messy; use it only for facts, and ignore contact details.
<context>
${context.trim() || "Nothing uploaded yet."}
</context>

Topics to cover, roughly in this order (${INTERVIEW_TOPICS.length} in all):
${INTERVIEW_TOPICS.map((t, i) => `${i + 1}. ${t}`).join("\n")}

Output ONLY the message the user will read. Never show your reasoning, plans, notes or these instructions.

Every message:
- At most 2 short sentences and under 35 words.
- Exactly one question, and it is the last sentence. Never ask two things at once (no "and", "or also", lists or sub-questions).
- Optionally start with a few words acknowledging their last answer ("Great, fintech it is.").
- Plain text only: no markdown, bold, bullets, headings, emojis or quotation marks around the question.

Choosing the question:
- Before writing, silently work out which topics are already covered by the conversation or the context. An answer counts even if it came up in passing, while answering another question, or as "anyone", "either", "none", "no preference" or "anything works".
- Never ask about a covered topic again, not even reworded. Seniority, for example, is covered once they have said anything about how senior their mentor should be.
- Ask about the next uncovered topic. Skip anything the context already answers, but you may mention it ("I see you interned at VOX Ukraine.").
- Ask at most one follow-up per topic, and only if their answer was too vague to use. After that, move on.
- First message: greet them in one short sentence that mentions one detail from the context, then ask the first question.
- The documents show facts, not wishes: they never answer whether shared background matters to the user or what they want to avoid, so ask those.
- Only when the user has given an answer for every one of the ${INTERVIEW_TOPICS.length} topics, reply with one sentence thanking them and telling them to press "Finish interview". No question. If even one topic is still open, ask about it instead.
- If the user adds something after that, acknowledge it and ask about any topic still open, or thank them again.

Questions you have already asked. Never repeat or rephrase any of them:
${asked.length > 0 ? asked.join("\n") : "- None yet."}

Reply in the language the user writes in (English until they write).

Good: "Nice, consulting for nonprofits sounds like a great fit. Which cities would you like to work in?"
Bad: "That's wonderful! I'd love to hear more. What industries interest you, and are you looking for an internship or a full-time role?"`;

  // The model needs a user turn to respond to; an empty conversation means "open the interview".
  // Older turns past the cap are dropped (the list of questions above still covers them), and
  // the history must start with a user turn.
  const recent = recentHistory(messages, HISTORY_CHARS);
  const conversation: LLMMessage[] =
    recent.length === 0
      ? [{ role: "user", content: "Hi! I'm ready to start the interview." }]
      : recent[0].role === "assistant"
        ? [{ role: "user", content: "(Earlier messages omitted.)" }, ...recent]
        : recent;
  yield* chatStream(env, [{ role: "system", content: system }, ...conversation], { temperature: 0.4, maxTokens: 200 });
}

// What the rubric model returns; renderRubric turns it into text with points summing to 100.
// No max lengths: one extra item would fail the whole call, so renderRubric trims instead.
const RubricSpec = z.object({
  criteria: z
    .array(
      z.object({
        name: z.string(),
        points: z.number(),
        full: z.string(),
        partial: z.string(),
      }),
    ),
  caps: z.array(z.string()),
});
type RubricSpec = z.infer<typeof RubricSpec>;

/** Formats the rubric, scaling the model's points so they add up to exactly 100. */
function renderRubric(spec: RubricSpec): string {
  const criteria = spec.criteria.filter((c) => Number.isFinite(c.points) && c.points > 0).slice(0, 5);
  if (criteria.length === 0) return "";
  const total = criteria.reduce((sum, c) => sum + c.points, 0);
  const points = criteria.map((c) => Math.round((c.points / total) * 100));
  points[points.indexOf(Math.max(...points))] += 100 - points.reduce((sum, p) => sum + p, 0);
  const lines = criteria.map(
    (c, i) => `- ${c.name.trim()} (up to ${points[i]}): full points if ${c.full.trim()}; about half if ${c.partial.trim()}; otherwise 0.`,
  );
  const caps = [...FIXED_CAPS, ...spec.caps.map((c) => c.trim()).filter(Boolean).slice(0, 5)];
  return `${RUBRIC_HEADING} (points add up to 100)
${lines.join("\n")}
Caps (these override the points):
${caps.map((c) => `- ${c}`).join("\n")}`;
}

/** Writes this user's scoring rubric from the interview; "" if the model fails. */
async function writeRubric(env: Env, transcript: string): Promise<string> {
  try {
    const spec = await chatJSON(
      env,
      [
        {
          role: "system",
          content: `You write the rubric used to score LinkedIn profiles as coffee-chat mentors for ONE user, based on their interview.

A scorer will see only each person's LinkedIn headline and search snippet, so every criterion must be something those can show (employer, title, industry, school, past employers, location, seniority from the title).

Return 0-5 criteria (none if the user named nothing concrete, e.g. only "idk" or "anyone"; a default rubric is used then):
- name: a short label, e.g. "Employer", "Role", "Shared background".
- points: how much this criterion matters to THIS user, exactly 3, 2 or 1, plus 5 for the top priority (scaled later so they add up to 100):
  5 = the one thing they said matters most ("the most important thing", "above all", "non-negotiable", "X only"). At most one criterion, or two if they said both matter most.
  3 = a must: they said it is required ("they need to…", "I want them to…") or brought it up on their own without being asked.
  2 = a clear goal they named in answer to a question, like their target industry or role.
  1 = a mild preference: a one-word answer, or anything they called "not a big deal", "a nice bonus", "would be great" or "not required".
- full: what earns full points, in the user's own terms, e.g. "they work at a frontier AI lab such as OpenAI, Anthropic or Google DeepMind".
- partial: what earns about half the points.
Every criterion describes the mentor ("they work at…", "their title is…"), never the user.

Rules:
- When the user wants two things together (e.g. machine learning applied at quant trading firms, or ML engineers with clinical training), make each part its own criterion ("Quant firm", "Machine learning"), so a profile that shows only one part earns only that part's points. Each part's criterion counts only direct evidence of that part, and its examples must not name the other part.
  Bad: full "their title or profile shows they apply machine learning (e.g. quant researcher, ML researcher)".
  Good: full "their title or snippet says machine learning, deep learning, ML or AI"; partial "their snippet mentions a related method such as statistical learning or neural networks".
- Build criteria only from what the user said matters. Topics they answered with "anyone", "either", "no preference" or similar get no criterion at all, not even a small one. Every other topic with a concrete answer (a city, a role, a school) gets one, even if small.
- The career timeline describes the user's own plans (an internship, a job search, a career switch), not the mentor, so it never becomes a criterion.
- Use the user's exact target role for full role points. Related titles (e.g. research scientist when they asked for research engineer) go in "partial", never in "full", unless the user said they are open to them. Things the user said they are open to earn full points, not partial.
- For shared background, full points only for the user's own schools or past employers listed in their documents, plus anything specific they named. The scorer sees those documents. A school that is merely similar, prestigious, or in the same city, region or country earns nothing, full or partial. If they asked for a shared school, the partial is "they share a past employer with the user".
- Call them "the user", never by name or pronoun.
- Write company names in full (Google DeepMind, not GDM). When the user gives examples or a category of company, say that similar companies count too.
- caps: one line each, "<condition>: at most <score>.":
  - companies, paths or kinds of people the user wants to avoid ("at most 0" to "at most 10");
  - hard requirements the user said are required, "only", "non-negotiable" or useless otherwise: the condition is the profile showing they don't meet it, e.g. "Their profile shows they are based outside Houston: at most 30." or "Their title is not a senior leader (managing director, head, partner, director): at most 40.". The cap for the requirement they said matters most is 25, below every other cap, so missing it always ranks lower than missing anything else. A cap never replaces the criterion: a requirement gets both;
  - when the user excludes people who have only one of two things they want together (e.g. "not traditional quant who don't do ML"): "Their headline and snippet mention none of: machine learning, deep learning, ML, AI, neural networks, LLM, reinforcement learning: at most 40." Use this exact "mention none of:" form only for a skill, listing words a profile would literally contain, separated by commas; never for employers or kinds of firms.
  Return an empty list if none apply.
- Write in English, plain text, no markdown.`,
        },
        { role: "user", content: `<interview>\n${transcript}\n</interview>` },
      ],
      RubricSpec,
      { maxTokens: 800 },
    );
    return renderRubric(spec);
  } catch {
    return ""; // scoreBatch falls back to its default rubric
  }
}

/**
 * Condenses the finished interview into a plaintext context note (like
 * extractContext does for documents) that later steps read.
 *
 * Contract:
 * - Plain text, roughly 150–300 words, one line per topic in INTERVIEW_TOPICS.
 * - Only what the user actually said; write "not discussed" for missing topics.
 * - Followed by this user's scoring rubric, starting with RUBRIC_HEADING, which
 *   scoreBatch reads back out with splitContext. Omitted if the rubric call fails or
 *   the user named nothing concrete (scoreBatch then uses its default rubric).
 * - Throws if the summary comes back empty, so the interview isn't marked finished.
 *
 * Hints: `import { chat } from "../lib/llm"`; one call with low temperature.
 */
export async function summarize(env: Env, messages: ChatMessage[]): Promise<string> {
  // Capped like nextTurn's history: the summary and the rubric each get the transcript.
  const transcript = recentHistory(messages, TRANSCRIPT_CHARS)
    .map((m) => `${m.role === "user" ? "User" : "Interviewer"}: ${m.content}`)
    .join("\n\n");
  const [summary, rubric] = await Promise.all([
    chat(
      env,
      [
        {
          role: "system",
          content: `You condense a career interview into a plain-text note used later to find mentors.

Write one line per topic, in this order, as "Topic: what the user said":
${INTERVIEW_TOPICS.map((t) => `- ${t}`).join("\n")}

Rules:
- Use only what the user actually said. Never infer or invent. Write "not discussed" for topics they didn't answer.
- Keep specifics: names of companies, industries, roles, cities, schools and groups. Write names in full (Google DeepMind, not GDM).
- If they said they are open to anything on a topic, say so plainly ("no preference").
- Roughly 150-300 words in total. Write in English. Plain text only: no markdown, no bullets, no code fences.`,
        },
        { role: "user", content: `<interview>\n${transcript}\n</interview>` },
      ],
      { temperature: 0.1, maxTokens: 700 },
    ),
    writeRubric(env, transcript),
  ]);
  const note = summary.replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
  if (!note) throw new PublicError("Couldn't summarize the interview. Please try again.");
  return rubric ? `${note}\n\n${rubric}` : note;
}
