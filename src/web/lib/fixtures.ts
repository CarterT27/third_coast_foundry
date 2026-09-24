// Fake data for building the UI without Supabase, LLM or search keys.
// Enabled with PUBLIC_USE_FIXTURES=true in .env (see lib/api.ts).
import type { AppState, Mentor } from "../../shared/schemas";

export const fixtureMentors: Mentor[] = Array.from({ length: 10 }, (_, i) => ({
  slug: `example-mentor-${i + 1}`,
  name: ["Jane Doe", "Sam Lee", "Priya Patel", "Marcus Chen", "Ana Ruiz"][i % 5],
  headline: ["Senior PM at Stripe", "Strategy & Ops at Ramp", "Product Lead at Plaid"][i % 3],
  snippet: "University of Chicago · Chicago, Illinois · 500+ connections",
  url: `https://www.linkedin.com/in/example-mentor-${i + 1}`,
  score: 95 - i * 4,
  reason: "Product manager in fintech and a UChicago alum.",
  blurb:
    "You're both UChicago economics grads, and they moved from consulting into fintech product — the path you described. Ask how they framed their consulting experience in PM interviews.",
}));

/** Interviewer lines for fixtures mode: [0] opens the chat, the rest cycle in order. */
export const fixtureInterviewReplies = [
  "Hi! I see you studied economics at UChicago and interned at a consulting firm. To start, which industries are you most excited about?",
  "Got it. What kinds of roles are you aiming for there?",
  "Are you looking for an internship, a first job, or a career switch?",
  "Any preferred locations, or is remote fine?",
  "What would you most want from a mentor: recruiting advice, a sense of the day-to-day, or technical guidance?",
  "Thanks, that covers everything I need. Press \"Finish interview\" whenever you're ready.",
];

export const fixtureState: AppState = {
  documents: [{ kind: "resume", filename: "example-resume.pdf", sizeBytes: 84_000, updatedAt: new Date().toISOString() }],
  interview: { messages: [], done: false },
  mentors: [],
};
