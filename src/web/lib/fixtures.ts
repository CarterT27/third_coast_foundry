// Fake data for building the UI without Supabase, LLM or search keys.
// Enabled with PUBLIC_USE_FIXTURES=true in .env (see lib/api.ts).
import type { AppState, Mentor, MentorPreview, MentorsEvent } from "../../shared/schemas";

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

const FIRST = ["Alex", "Jordan", "Taylor", "Morgan", "Riley", "Casey", "Jamie", "Avery", "Quinn", "Drew", "Rohan", "Mei", "Luis", "Fatima", "Noah", "Hana"];
const LAST = ["Kim", "Nguyen", "Garcia", "Singh", "Okafor", "Rossi", "Cohen", "Park", "Silva", "Ali", "Brown", "Ito"];
const TITLES = ["Product Manager at Brex", "Analyst at Goldman Sachs", "Engineer at Plaid", "PM at Robinhood", "Associate at McKinsey"];
const QUERIES = [
  'site:linkedin.com/in ("product manager" OR "PM") fintech ("University of Chicago")',
  'site:linkedin.com/in ("product manager") ("Stripe" OR "Ramp" OR "Plaid")',
  'site:linkedin.com/in ("strategy and operations") fintech',
  'site:linkedin.com/in ("product manager") ("McKinsey & Company" OR "Bain & Company")',
  'site:linkedin.com/in ("associate product manager") "Chicago"',
  'site:linkedin.com/in ("product lead" OR "group product manager") payments',
];

/** [delay ms, event]: one step of a scripted mentor search. */
type Scripted = [number, Exclude<MentorsEvent, { type: "done" | "error" }>];

/**
 * A scripted mentor search for fixtures mode: [delay ms, event] pairs ending just before
 * `done`, plus the mentors it returns. `round` (any number unique to this call) keeps slugs unique across "Show more".
 */
export function fixtureMentorRun(round: number): { events: Scripted[]; mentors: Mentor[] } {
  const mentors = fixtureMentors.map((m) => ({ ...m, slug: `${m.slug}-r${round}` }));
  const others: MentorPreview[] = Array.from({ length: 50 }, (_, i) => ({
    slug: `example-person-${i}-r${round}`,
    name: `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`,
    headline: TITLES[i % TITLES.length],
  }));
  const people: MentorPreview[] = [...others, ...mentors].map(({ slug, name, headline }) => ({ slug, name, headline }));
  // Deterministic shuffle so the top mentors are spread across queries.
  const shuffled = [...people].sort((a, b) => hash(a.slug) - hash(b.slug));
  const scoreOf = new Map<string, number>([
    ...others.map((p, i): [string, number] => [p.slug, 20 + ((i * 37) % 38)]),
    ...mentors.map((m): [string, number] => [m.slug, m.score]),
  ]);

  const perQuery = Math.ceil(shuffled.length / QUERIES.length);
  const batches = [shuffled.slice(0, 20), shuffled.slice(20, 40), shuffled.slice(40)];
  const events: Scripted[] = [
    [300, { type: "progress", stage: "searching", message: "Planning searches…" }],
    [900, { type: "queries", queries: QUERIES }],
    [0, { type: "progress", stage: "searching", message: "Searching LinkedIn profiles…" }],
    ...QUERIES.map((_, index): Scripted => [
      700,
      index === 3
        ? { type: "found", index, candidates: [], failed: true }
        : { type: "found", index, candidates: shuffled.slice(index * perQuery, (index + 1) * perQuery), failed: false },
    ]),
    [400, { type: "progress", stage: "scoring", message: `Scoring ${shuffled.length} profiles…` }],
    [0, { type: "scoring", candidates: shuffled }],
    ...batches.map((b, i): Scripted => [
      900 + i * 300,
      { type: "scored", scores: b.map((p) => ({ slug: p.slug, score: scoreOf.get(p.slug) ?? 0 })) },
    ]),
    [700, { type: "selected", mentors: mentors.map((m) => ({ slug: m.slug, name: m.name, headline: m.headline, score: m.score })) }],
    [0, { type: "progress", stage: "writing", message: "Writing notes on your top matches…" }],
    [1500, { type: "progress", stage: "writing", message: "Writing notes on your top matches…" }],
  ];
  return { events, mentors };
}

function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}
