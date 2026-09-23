// OWNER: Carter
// Implement the function bodies. Do not change the signatures.
import type { ChatMessage } from "../../shared/schemas";
import type { Env } from "../env";

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
// eslint-disable-next-line require-yield -- remove this line once implemented
export async function* nextTurn(env: Env, context: string, messages: ChatMessage[]): AsyncGenerator<string> {
  throw new Error("TODO: implement nextTurn (services/interview.ts)");
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
  throw new Error("TODO: implement summarize (services/interview.ts)");
}
