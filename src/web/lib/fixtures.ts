// Fake data for building the UI without Supabase, NVIDIA or search keys.
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

export const fixtureState: AppState = {
  documents: [],
  interview: { messages: [], done: false },
  mentors: [],
};
