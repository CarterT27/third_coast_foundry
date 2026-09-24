// The only way the page talks to the Worker. Components call these functions;
// they never use fetch directly. Types come straight from the Worker's routes,
// so a contract change shows up here as a type error.
import { hc } from "hono/client";
import {
  InterviewEvent,
  MentorsEvent,
  type AppState,
  type ChatMessage,
  type DocumentSummary,
  type Mentor,
  type UploadDocumentBody,
} from "../../shared/schemas";
import { readSSE } from "../../shared/sse";
import type { AppType } from "../../worker/index";
import { fixtureInterviewReplies, fixtureMentorRun, fixtureState } from "./fixtures";
import { getAccessToken } from "./supabase";

const USE_FIXTURES = import.meta.env.PUBLIC_USE_FIXTURES === "true";

const client = hc<AppType>(window.location.origin, {
  headers: async () => ({ Authorization: `Bearer ${await getAccessToken()}` }),
}).api;

async function toError(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(body?.error ?? `Request failed (${res.status})`);
}

export async function getState(): Promise<AppState> {
  if (USE_FIXTURES) return structuredClone(fixtureState);
  const res = await client.state.$get();
  if (!res.ok) throw await toError(res);
  return res.json();
}

export async function uploadDocument(body: UploadDocumentBody): Promise<DocumentSummary> {
  if (USE_FIXTURES) {
    const doc = { kind: body.kind, filename: body.filename, sizeBytes: body.sizeBytes, updatedAt: new Date().toISOString() };
    fixtureState.documents = [...fixtureState.documents.filter((d) => d.kind !== body.kind), doc];
    return doc;
  }
  const res = await client.documents.$post({ json: body });
  if (!res.ok) throw await toError(res);
  return res.json();
}

/** Sends the conversation so far; calls onToken for each chunk of the interviewer's reply. */
export async function sendInterviewMessage(messages: ChatMessage[], onToken: (text: string) => void): Promise<void> {
  if (USE_FIXTURES) {
    // Type "error" to test the failure state.
    if (messages.at(-1)?.content.toLowerCase().includes("error")) throw new Error("Fixture error: the interviewer is unavailable.");
    const turn = messages.filter((m) => m.role === "assistant").length;
    const reply = fixtureInterviewReplies[turn === 0 ? 0 : 1 + ((turn - 1) % (fixtureInterviewReplies.length - 1))];
    await new Promise((resolve) => setTimeout(resolve, 400));
    for (const word of reply.split(/(?= )/)) {
      onToken(word);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    fixtureState.interview.messages = [...messages, { role: "assistant", content: reply }];
    return;
  }
  const res = await client.interview.$post({ json: { messages } });
  if (!res.ok || !res.body) throw await toError(res);
  for await (const data of readSSE(res.body)) {
    const event = InterviewEvent.parse(JSON.parse(data));
    if (event.type === "token") onToken(event.text);
    if (event.type === "error") throw new Error(event.message);
  }
}

export async function finishInterview(messages: ChatMessage[]): Promise<void> {
  if (USE_FIXTURES) {
    fixtureState.interview = { messages, done: true };
    return;
  }
  const res = await client.interview.finish.$post({ json: { messages } });
  if (!res.ok) throw await toError(res);
}

/** Every mentor-search event except the ones that end the stream. */
export type MentorsProgress = Exclude<MentorsEvent, { type: "done" | "error" }>;

/**
 * Finds the next batch of mentors ("Find" and "Show more" are the same call).
 * `onEvent` gets every stream event before `done` so the page can animate the search.
 */
export async function findMentors(onEvent: (event: MentorsProgress) => void): Promise<Mentor[]> {
  if (USE_FIXTURES) {
    const { events, mentors } = fixtureMentorRun(fixtureState.mentors.length);
    for (const [delay, event] of events) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      onEvent(event);
    }
    fixtureState.mentors = [...fixtureState.mentors, ...mentors];
    return mentors;
  }
  const res = await client.mentors.$post();
  if (!res.ok || !res.body) throw await toError(res);
  for await (const data of readSSE(res.body)) {
    const event = MentorsEvent.parse(JSON.parse(data));
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "done") return event.mentors;
    onEvent(event);
  }
  throw new Error("Mentor search ended unexpectedly");
}
