// The contract between the page and the Worker. Every request body, response
// and stream event is defined here. Changing this file changes the architecture —
// ask the tech lead first.
import { z } from "zod";

// ─── Tunables ────────────────────────────────────────────────────────────────
export const TOP_N = 10; // mentors returned per "Find" / "Show more"
export const SCORE_BATCH_SIZE = 20; // candidates per scoring LLM call
export const MAX_SCORE_PER_RUN = 100; // cap on candidates scored in one run
export const MAX_QUERIES = 10; // X-ray queries per search run
export const MAX_DOCUMENT_CHARS = 100_000;

// ─── Documents ───────────────────────────────────────────────────────────────
export const UploadKind = z.enum(["resume", "transcript", "linkedin"]);
export type UploadKind = z.infer<typeof UploadKind>;

export const DocumentKind = z.enum([...UploadKind.options, "interview"]);
export type DocumentKind = z.infer<typeof DocumentKind>;

export const UploadDocumentBody = z.object({
  kind: UploadKind,
  filename: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
  text: z.string().trim().min(1).max(MAX_DOCUMENT_CHARS),
});
export type UploadDocumentBody = z.infer<typeof UploadDocumentBody>;

export const DocumentSummary = z.object({
  kind: UploadKind,
  filename: z.string(),
  sizeBytes: z.number(),
  updatedAt: z.string(),
});
export type DocumentSummary = z.infer<typeof DocumentSummary>;

// ─── Interview ───────────────────────────────────────────────────────────────
export const ChatMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(4000),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const InterviewBody = z.object({
  messages: z.array(ChatMessage).max(60),
});
export type InterviewBody = z.infer<typeof InterviewBody>;

export const InterviewEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("token"), text: z.string() }),
  z.object({ type: z.literal("done") }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type InterviewEvent = z.infer<typeof InterviewEvent>;

// ─── Search & mentors ────────────────────────────────────────────────────────
/** What the LLM returns for each search angle; buildXray() turns it into a query string. */
export const XraySpec = z.object({
  titles: z.array(z.string()).min(1).max(5), // OR'd together
  keywords: z.array(z.string()).max(5), // each AND'd
  companies: z.array(z.string()).max(5).default([]), // OR'd together
  schools: z.array(z.string()).max(3).default([]), // OR'd together
  location: z.string().optional(),
});
export type XraySpec = z.infer<typeof XraySpec>;

/** A LinkedIn profile as seen in a search result. `slug` is the id after linkedin.com/in/. */
export const Candidate = z.object({
  slug: z.string(),
  name: z.string(),
  headline: z.string(),
  snippet: z.string(),
  url: z.string().url(),
});
export type Candidate = z.infer<typeof Candidate>;

export const Score = z.object({
  slug: z.string(),
  score: z.number().int().min(0).max(100),
  reason: z.string(),
});
export type Score = z.infer<typeof Score>;

export const Blurb = z.object({
  slug: z.string(),
  blurb: z.string(),
});
export type Blurb = z.infer<typeof Blurb>;

export const Mentor = Candidate.extend({
  score: z.number(),
  reason: z.string(),
  blurb: z.string(),
});
export type Mentor = z.infer<typeof Mentor>;

export const MentorsEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    stage: z.enum(["searching", "scoring", "writing"]),
    message: z.string(),
  }),
  z.object({ type: z.literal("done"), mentors: z.array(Mentor) }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type MentorsEvent = z.infer<typeof MentorsEvent>;

// ─── Page state ──────────────────────────────────────────────────────────────
export const AppState = z.object({
  documents: z.array(DocumentSummary),
  interview: z.object({
    messages: z.array(ChatMessage),
    done: z.boolean(),
  }),
  mentors: z.array(Mentor), // already shown, best first
});
export type AppState = z.infer<typeof AppState>;
