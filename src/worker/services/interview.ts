// OWNER: Carter
// Implement the function bodies. Do not change the signatures.
import type { ChatMessage } from "../../shared/schemas";
import type { Env } from "../env";
import { chat, chatStream, type LLMMessage } from "../lib/nvidia";

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

/**
 * Streams the interviewer's next message.
 *
 * Contract:
 * - `messages` is the conversation so far (may be empty: then open the interview).
 * - `context` is every uploaded document's context note. Don't ask about facts it
 *   already answers; do reference them ("I see you interned at X…").
 * - Ask ONE question at a time, short and conversational. Cover INTERVIEW_TOPICS;
 *   once all are covered, tell the user they can press "Finish interview".
 * - Yields text chunks as they arrive (the route forwards each one to the browser).
 *
 * Hints: `import { chatStream } from "../lib/nvidia"`, build a system prompt from
 * `context` + INTERVIEW_TOPICS, then `yield*` the stream.
 */
export async function* nextTurn(env: Env, context: string, messages: ChatMessage[]): AsyncGenerator<string> {
  const system = `You are a warm, concise career advisor interviewing a student so we can find them mentors for coffee chats.

What we already know about them (from their uploaded documents):
<context>
${context.trim() || "Nothing uploaded yet."}
</context>

Topics to cover:
${INTERVIEW_TOPICS.map((t) => `- ${t}`).join("\n")}

How to interview:
- Ask exactly ONE question per message, in 1-3 short sentences. Be conversational, not a form.
- Don't ask about anything the context already answers; reference it instead ("I see you interned at X...").
- Briefly acknowledge the user's last answer before the next question. Ask a quick follow-up only if an answer is vague.
- Skip topics the user has already covered, even in passing.
- Once every topic is covered, thank them briefly and tell them they can press "Finish interview".
- Reply in the language the user writes in (English if they haven't written yet). Plain text, no markdown.`;

  // The model needs a user turn to respond to; an empty conversation means "open the interview".
  const conversation: LLMMessage[] =
    messages.length > 0 ? messages : [{ role: "user", content: "Hi! I'm ready to start the interview." }];
  yield* chatStream(env, [{ role: "system", content: system }, ...conversation], { temperature: 0.6, maxTokens: 300 });
}

/**
 * Condenses the finished interview into a plaintext context note (like
 * extractContext does for documents) that later steps read.
 *
 * Contract:
 * - Plain text, roughly 150–300 words, one line per topic in INTERVIEW_TOPICS.
 * - Only what the user actually said; write "not discussed" for missing topics.
 *
 * Hints: `import { chat } from "../lib/nvidia"`; one call with low temperature.
 */
export async function summarize(env: Env, messages: ChatMessage[]): Promise<string> {
  const transcript = messages.map((m) => `${m.role === "user" ? "Student" : "Interviewer"}: ${m.content}`).join("\n\n");
  const summary = await chat(
    env,
    [
      {
        role: "system",
        content: `You condense a career interview into a plain-text note used later to find mentors.

Write one line per topic, in this order, as "Topic: what the student said":
${INTERVIEW_TOPICS.map((t) => `- ${t}`).join("\n")}

Rules:
- Use only what the student actually said. Never infer or invent. Write "not discussed" for topics they didn't answer.
- Keep specifics: names of companies, industries, roles, cities, schools and groups.
- Roughly 150-300 words in total. Write in English. Plain text only: no markdown, no bullets, no code fences.`,
      },
      { role: "user", content: `<interview>\n${transcript}\n</interview>` },
    ],
    { temperature: 0.1, maxTokens: 700 },
  );
  return summary.replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
}
