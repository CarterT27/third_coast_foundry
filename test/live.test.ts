// Live red-team checks with real LLM and Brave calls. Skipped unless LIVE is set, so
// `npm test` and CI never run them.
//
//   LIVE=1 npx vitest run test/live.test.ts --testTimeout=600000
//     Drives a deployed site (LIVE_BASE_URL, default production; http://localhost:5173 for
//     `npm run dev`) with real Supabase. Each run makes 3 fresh anonymous users and spends 3 of
//     the site's 10 searches per day.
//   LIVE=local npx vitest run test/live.test.ts --testTimeout=600000
//     Runs the same steps as pipeline.findMentors in-process with the services in this
//     checkout: no Supabase and no site quota, only LLM calls and ~30 Brave queries.
//
// Keys and URLs come from the environment or .env. Each scenario's full run (rubric, queries,
// every score, the mentors and blurbs) is printed as JSON so a failure can be reproduced by hand.
//
// Each scenario asserts what the user should get, so a failure is a wrong answer to fix.
import { loadEnv } from "vite";
import { beforeAll, describe, expect, it } from "vitest";
import {
  MAX_SCORE_PER_RUN,
  MentorsEvent,
  SCORE_BATCH_SIZE,
  TOP_N,
  type Candidate,
  type ChatMessage,
  type Mentor,
  type UploadKind,
} from "../src/shared/schemas";
import { readSSE } from "../src/shared/sse";
import type { Env } from "../src/worker/env";
import { writeBlurbs } from "../src/worker/services/blurbs";
import { extractContext } from "../src/worker/services/documents";
import { summarize } from "../src/worker/services/interview";
import { scoreBatch } from "../src/worker/services/score";
import { generateQueries, runSearch } from "../src/worker/services/search";

const LIVE = process.env.LIVE === "1" || process.env.LIVE === "local";
const LOCAL = process.env.LIVE === "local";
const BASE_URL = process.env.LIVE_BASE_URL ?? "https://third-coast-foundry.carter-tran.workers.dev";
const RUN_TIMEOUT = 600_000;

type Persona = { docs: Partial<Record<UploadKind, string>>; interview: [question: string, answer: string][] };
type Scored = { slug: string; name: string; headline: string; snippet?: string; score: number };
type Run = { rubric: string; queries: string[]; mentors: Mentor[]; scored: Scored[] };

// ─── Personas ────────────────────────────────────────────────────────────────
const QUANT_RESUME = `Jordan Lee
University of Chicago, B.S. Mathematics and Computer Science, expected June 2027, GPA 3.8
Coursework: Stochastic Calculus, Machine Learning, Numerical Linear Algebra, Probability, Deep Learning Systems
Experience:
Research Assistant, UChicago Booth, Jan 2025-present: built LSTM models forecasting intraday volatility
Software Engineering Intern, Braintree, Summer 2025: payments fraud detection pipeline in Python
Projects: Transformer-based order book model, 2025
Skills: Python, PyTorch, C++, kdb+/q, pandas
Activities: UChicago Financial Markets Program; Quant Trading Club, VP`;

const quantInterview = (seniority: string): Persona["interview"] => [
  [
    "Hi Jordan! I see you built LSTM volatility models at Booth. What industries are you targeting?",
    "Quantitative trading. Specifically the intersection of quant and AI: I want to talk to people applying deep learning / ML to trading at quant firms. Not pure AI labs, and not traditional quant who don't do ML.",
  ],
  [
    "Got it. What roles?",
    "Quant researcher or machine learning researcher at a trading firm like Citadel, Jane Street, Two Sigma, Hudson River Trading, Jump Trading, or XTX Markets. They need to be doing ML at a quant firm, both parts matter equally.",
  ],
  ["What's your timeline?", "Looking for a summer 2026 quant research internship."],
  ["Preferred locations?", "Chicago or New York, but not a big deal."],
  ["What do you want from a mentor?", "Technical guidance on how ML research differs in finance vs tech, and recruiting advice."],
  ["Seniority?", seniority],
  ["Shared background that matters?", "UChicago alum would be a nice bonus but not required."],
  [
    "Anything to avoid?",
    "Avoid people at big tech AI labs like OpenAI, Google DeepMind, Meta AI — I specifically do not want pure AI people. Also avoid sell-side banks.",
  ],
];

const PERSONAS = {
  quantAi: { docs: { resume: QUANT_RESUME }, interview: quantInterview("A few years ahead, like 2-5 years into their career.") },
  seniorLeaders: {
    docs: { resume: QUANT_RESUME },
    interview: quantInterview(
      "Senior leaders only. I want managing directors, heads of research, or partners with 15+ years. This is the most important thing to me — junior people can't help with what I need.",
    ),
  },
  houston: {
    docs: {
      resume: `Marcus Webb
Rice University, B.A. Economics and Statistics, May 2026, GPA 3.6
Coursework: Time Series Econometrics, Energy Economics, Stochastic Processes
Experience:
Analyst Intern, Shell Energy North America, Houston, Summer 2025: power price forecasting
Research Assistant, Baker Institute for Public Policy, 2024-2025
Skills: Python, R, Excel, SQL
Location: Houston, TX`,
    },
    interview: [
      ["Hi Marcus! I see you forecasted power prices at Shell. What industry?", "Energy trading — power and natural gas."],
      ["What roles?", "Energy trader or quantitative analyst on a power or gas trading desk."],
      ["Timeline?", "First full-time job after graduating in May 2026."],
      ["Locations?", "Houston ONLY. This is non-negotiable, I will not relocate — family reasons. Anyone outside Houston is useless to me."],
      ["What do you want from a mentor?", "Recruiting advice and what the day looks like on a trading desk."],
      ["Seniority?", "A few years ahead."],
      ["Shared background?", "Rice alum would be great."],
      ["Anything to avoid?", "Avoid oil and gas upstream/exploration roles, I only want trading."],
    ],
  },
} satisfies Record<string, Persona>;

type ScenarioName = keyof typeof PERSONAS;

// ─── Evidence heuristics (headline + snippet only, like the scorer) ──────────
const text = (m: { headline: string; snippet?: string }) => `${m.headline} ${m.snippet ?? ""}`;
const QUANT_FIRM =
  /Citadel|Jane Street|Two Sigma|Hudson River|Jump Trading|XTX|D\.? ?E\.? Shaw|Susquehanna|\bSIG\b|Optiver|\bIMC\b|Tower Research|Renaissance|Millennium|\bDRW\b|Five Rings|Virtu/i;
const ML = /machine learning|\bML\b|deep learning|\bAI\b|artificial intelligence|neural|\bLLMs?\b|reinforcement learning|statistical learning/i;
const SENIOR = /managing director|\bMD\b|head of|partner|director|chief|\bVP\b|vice president|principal/i;
const ENERGY_TRADING = /trad(er|ing)|\bpower\b|natural gas|\bgas\b|energy|commodit/i;
const HOUSTON = /Houston|Sugar Land|Katy|Woodlands|Pearland|Conroe|Spring|Cypress|Humble|Tomball|Pasadena|Baytown|League City|Missouri City|Bellaire/i; // Greater Houston
const STUDENT = /\b(student|undergrad(uate)?|phd candidate|class of 20\d\d)\b/i;
const EDU_EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)*\.edu\b/i;
const GENDERED = /\b(he|she|him|her|his|hers|himself|herself)\b/i;

/** A senior title, or 15+ years of experience in the snippet (the persona asks for either). */
const isSenior = (m: { headline: string; snippet?: string }) =>
  SENIOR.test(m.headline) || /\b(1[5-9]|[2-9]\d)\+? years\b/i.test(m.snippet ?? "");
const isStudent = (m: Mentor) => STUDENT.test(m.headline) || EDU_EMAIL.test(m.snippet);
/** Nothing but a location or "Professional Profile" in the headline, and no Experience field. */
const isBlank = (m: Mentor) => !/Experience:/.test(m.snippet) && /Professional Profile|^[^|]*,\s*United States\s*$/i.test(m.headline);
const location = (m: Mentor) => /Location:\s*([^·]+)/.exec(m.snippet)?.[1].trim();

/** Points per criterion, keyed by lowercase criterion name. */
function rubricPoints(rubric: string): Map<string, number> {
  return new Map([...rubric.matchAll(/^- (.+?) \(up to (\d+)\)/gm)].map((m) => [m[1].toLowerCase(), Number(m[2])]));
}
const rubricCaps = (rubric: string) => rubric.slice(rubric.indexOf("Caps")).split("\n").slice(1);

// ─── Driving the site ────────────────────────────────────────────────────────
function envValue(name: string): string {
  const value = process.env[name] ?? loadEnv("", process.cwd(), "")[name];
  if (!value) throw new Error(`${name} missing from the environment and .env`);
  return value;
}

async function ok(res: Response): Promise<Response> {
  if (!res.ok) throw new Error(`${res.url} → ${res.status}: ${await res.text()}`);
  return res;
}

const toMessages = (persona: Persona): ChatMessage[] =>
  persona.interview.flatMap(([q, a]) => [
    { role: "assistant" as const, content: q },
    { role: "user" as const, content: a },
  ]);

/** pipeline.findMentors for a first search, without the database. */
async function runInProcess(name: ScenarioName): Promise<Run> {
  const persona: Persona = PERSONAS[name];
  const env: Env = {
    PUBLIC_SUPABASE_URL: "",
    PUBLIC_SUPABASE_PUBLISHABLE_KEY: "",
    LLM_PROVIDER: envValue("LLM_PROVIDER"),
    NVIDIA_API_KEY: envValue("NVIDIA_API_KEY"),
    NVIDIA_MODEL: envValue("NVIDIA_MODEL"),
    OPENROUTER_API_KEY: envValue("OPENROUTER_API_KEY"),
    OPENROUTER_MODEL: envValue("OPENROUTER_MODEL"),
    BRAVE_API_KEY: envValue("BRAVE_API_KEY"),
  };
  const docs = Object.entries(persona.docs) as [UploadKind, string][];
  const [notes, summary] = await Promise.all([
    Promise.all(docs.map(async ([kind, text]) => `## ${kind.toUpperCase()} (${kind}.pdf)\n${await extractContext(env, kind, text)}`)),
    summarize(env, toMessages(persona)),
  ]);
  const context = [...notes, `## INTERVIEW (interview)\n${summary}`].join("\n\n");

  const queries = await generateQueries(env, context);
  const found = await Promise.all(queries.map((q) => runSearch(env, [q]).catch(() => [] as Candidate[])));
  const bySlug = new Map<string, Candidate>();
  for (const c of found.flat()) if (!bySlug.has(c.slug)) bySlug.set(c.slug, c);
  const candidates = [...bySlug.values()].slice(0, MAX_SCORE_PER_RUN);

  const batches: Candidate[][] = [];
  for (let i = 0; i < candidates.length; i += SCORE_BATCH_SIZE) batches.push(candidates.slice(i, i + SCORE_BATCH_SIZE));
  const scores = (await Promise.all(batches.map((b) => scoreBatch(env, context, b)))).flat();
  const scored = scores
    .map((s) => ({ ...bySlug.get(s.slug)!, score: s.score, reason: s.reason }))
    .sort((a, b) => b.score - a.score);
  const pool = scored.filter((m) => m.score >= 1).slice(0, TOP_N);
  const blurbs = new Map((await writeBlurbs(env, context, pool.map((m) => ({ ...m, blurb: "" })))).map((b) => [b.slug, b.blurb]));

  const rubric = context.slice(Math.max(0, context.indexOf("SCORING RUBRIC")));
  const run: Run = { rubric, queries, mentors: pool.map((m) => ({ ...m, blurb: blurbs.get(m.slug) ?? "" })), scored };
  process.stdout.write(`── ${name} ──\n${JSON.stringify(run, null, 2)}\n`); // console.log is hidden for passing tests
  return run;
}

async function runScenario(name: ScenarioName): Promise<Run> {
  if (LOCAL) return runInProcess(name);
  const persona: Persona = PERSONAS[name];
  const supabase = envValue("PUBLIC_SUPABASE_URL");
  const apikey = envValue("PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  const signup = await ok(
    await fetch(`${supabase}/auth/v1/signup`, { method: "POST", headers: { apikey, "content-type": "application/json" }, body: "{}" }),
  );
  const { access_token: token } = (await signup.json()) as { access_token: string };
  const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };

  for (const [kind, body] of Object.entries(persona.docs)) {
    const doc = { kind, filename: `${kind}.pdf`, sizeBytes: body.length, text: body };
    await ok(await fetch(`${BASE_URL}/api/documents`, { method: "POST", headers, body: JSON.stringify(doc) }));
  }
  const messages = toMessages(persona);
  await ok(await fetch(`${BASE_URL}/api/interview/finish`, { method: "POST", headers, body: JSON.stringify({ messages }) }));

  const notes = await ok(
    await fetch(`${supabase}/rest/v1/documents?select=context&kind=eq.interview`, { headers: { apikey, Authorization: headers.Authorization } }),
  );
  const [{ context }] = (await notes.json()) as { context: string }[];
  const rubric = context.slice(Math.max(0, context.indexOf("SCORING RUBRIC")));

  const res = await ok(await fetch(`${BASE_URL}/api/mentors`, { method: "POST", headers }));
  const run: Run = { rubric, queries: [], mentors: [], scored: [] };
  const people = new Map<string, { name: string; headline: string }>();
  for await (const data of readSSE(res.body!)) {
    const event = MentorsEvent.parse(JSON.parse(data));
    if (event.type === "error") throw new Error(`${name}: ${event.message}`);
    if (event.type === "queries") run.queries = event.queries;
    if (event.type === "scoring") for (const c of event.candidates) people.set(c.slug, c);
    if (event.type === "scored") for (const s of event.scores) run.scored.push({ ...s, ...people.get(s.slug)!, slug: s.slug });
    if (event.type === "done") run.mentors = event.mentors;
  }
  run.scored.sort((a, b) => b.score - a.score);

  process.stdout.write(`── ${name} ──\n${JSON.stringify(run, null, 2)}\n`); // console.log is hidden for passing tests
  return run;
}

// ─── Checks ──────────────────────────────────────────────────────────────────
describe.skipIf(!LIVE)("live red-team scenarios", () => {
  const runs = {} as Record<ScenarioName, Run>;

  beforeAll(async () => {
    const names = Object.keys(PERSONAS) as ScenarioName[];
    const results = await Promise.all(names.map(runScenario));
    names.forEach((n, i) => (runs[n] = results[i]));
  }, RUN_TIMEOUT);

  const describePeople = (list: { name: string; headline: string; score?: number }[]) =>
    list.map((m) => `[${m.score ?? "-"}] ${m.name} | ${m.headline}`).join("\n");

  it("quant + AI: most mentors show both a quant firm and ML", () => {
    const { mentors } = runs.quantAi;
    const both = mentors.filter((m) => QUANT_FIRM.test(text(m)) && ML.test(text(m)));
    expect(both.length, `mentors with quant + ML evidence:\n${describePeople(both)}\nall:\n${describePeople(mentors)}`).toBeGreaterThanOrEqual(
      Math.ceil(mentors.length / 2),
    );
  });

  it("quant + AI: nobody without ML evidence outscores someone with it", () => {
    const { mentors } = runs.quantAi;
    const withMl = mentors.filter((m) => ML.test(text(m)));
    const withoutMl = mentors.filter((m) => !ML.test(text(m)));
    if (withMl.length === 0) return; // covered by the test above
    const lowestMl = Math.min(...withMl.map((m) => m.score));
    const above = withoutMl.filter((m) => m.score > lowestMl);
    expect(above, `no ML evidence, yet above an ML match (${lowestMl}):\n${describePeople(above)}`).toEqual([]);
  });

  it("seniority named as most important gets the most rubric points", () => {
    const points = rubricPoints(runs.seniorLeaders.rubric);
    const seniority = [...points].find(([name]) => /senior/.test(name))?.[1] ?? 0;
    expect(seniority, runs.seniorLeaders.rubric).toBe(Math.max(...points.values()));
  });

  it("seniority named as most important: no junior outscores the best senior leader", () => {
    // Stream events carry no snippet; the returned mentors do.
    const snippets = new Map(runs.seniorLeaders.mentors.map((m) => [m.slug, m.snippet]));
    const scored = runs.seniorLeaders.scored.map((s) => ({ ...s, snippet: s.snippet ?? snippets.get(s.slug) }));
    const bestSenior = scored.find(isSenior);
    expect(bestSenior, `no senior leader was scored at all:\n${describePeople(scored)}`).toBeDefined();
    const above = scored.filter((s) => !isSenior(s) && s.score > bestSenior!.score);
    expect(above, `outscore ${bestSenior!.name} (${bestSenior!.score}):\n${describePeople(above)}`).toEqual([]);
  });

  it("non-negotiable location becomes a cap in the rubric", () => {
    const caps = rubricCaps(runs.houston.rubric);
    expect(caps.some((c) => /Houston/i.test(c)), runs.houston.rubric).toBe(true);
  });

  it("Houston energy trading: most mentors work in energy trading", () => {
    const { mentors } = runs.houston;
    const relevant = mentors.filter((m) => ENERGY_TRADING.test(text(m)));
    expect(relevant.length, `all mentors:\n${describePeople(mentors)}`).toBeGreaterThanOrEqual(Math.ceil(mentors.length / 2));
  });

  it("Houston energy trading: every mentor with a known location is in Houston", () => {
    const outside = runs.houston.mentors.filter((m) => location(m) && !HOUSTON.test(location(m)!));
    expect(outside, describePeople(outside)).toEqual([]);
  });

  it("most queries return at least one person", () => {
    // Over-filtered queries (title + company + school + location) return nobody.
    for (const [name, run] of Object.entries(runs)) {
      expect(run.scored.length, `${name} found only ${run.scored.length} people:\n${run.queries.join("\n")}`).toBeGreaterThanOrEqual(20);
    }
  });

  it("current students are capped at 10", () => {
    const over = Object.values(runs)
      .flatMap((r) => r.mentors)
      .filter((m) => isStudent(m) && m.score > 10);
    expect(over, describePeople(over)).toEqual([]);
  });

  it("profiles with no employer or role are capped at 20", () => {
    const over = Object.values(runs)
      .flatMap((r) => r.mentors)
      .filter((m) => isBlank(m) && m.score > 20);
    expect(over, describePeople(over)).toEqual([]);
  });

  it("blurbs never guess gendered pronouns", () => {
    const gendered = Object.values(runs)
      .flatMap((r) => r.mentors)
      .filter((m) => GENDERED.test(m.blurb));
    expect(gendered.map((m) => `${m.name}: ${m.blurb}`)).toEqual([]);
  });
});
