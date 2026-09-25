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
// LIVE_SCENARIOS=premed,banking runs only those personas (default: all seven; in site mode each
// persona is one of the 10 daily searches). Keys and URLs come from the environment or .env. Each scenario's full run (rubric, queries,
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
  premed: {
    docs: {
      resume: `Aisha Rahman
University of Michigan, B.S. Neuroscience, expected May 2027, GPA 3.85
Experience:
EMT, Huron Valley Ambulance, 2024-present
Research Assistant, Michigan Medicine Department of Emergency Medicine, 2025
Volunteer, C.S. Mott Children's Hospital, 2023-present
Activities: American Medical Student Association (AMSA), chapter Treasurer; Michigan First-Gen Promise scholar
Location: Ann Arbor, MI`,
    },
    interview: [
      ["Hi Aisha! I see you work as an EMT. What field are you aiming for?", "Medicine. I'm premed and want to be a physician, ideally in emergency medicine."],
      [
        "What kinds of people do you want to meet?",
        "Emergency medicine physicians or residents. Current medical students are great too, honestly I most want med students since they just went through applications.",
      ],
      ["What's your timeline?", "Applying to medical school in the 2026 cycle."],
      ["Any location preference?", "Anywhere."],
      ["What do you want from a mentor?", "Advice on med school applications and the MCAT, and what EM residency is like."],
      ["What seniority?", "Medical students or residents are ideal; attendings are fine too."],
      ["Does shared background matter?", "University of Michigan alumni would be really nice."],
      [
        "Anything to avoid?",
        "Avoid pharma sales, healthcare consulting and hospital administrators. I want people on the clinical path.",
      ],
    ],
  },
  banking: {
    docs: {
      resume: `Daniel Ortiz
Indiana University, Kelley School of Business, B.S. Finance, expected May 2027, GPA 3.7
Experience:
Summer Analyst, Crowe LLP (Transaction Advisory), Summer 2025
Member, Kelley Investment Banking Workshop (IBW), 2024-present
Treasurer, Latino Business Student Association, 2024-present
Skills: Excel, financial modeling, PitchBook, Capital IQ
Location: Bloomington, IN`,
    },
    interview: [
      ["Hi Daniel! I see you're in Kelley's IBW. What industry are you targeting?", "Investment banking."],
      [
        "What roles?",
        "Investment banking analysts or associates, ideally M&A, at bulge brackets or elite boutiques like Goldman Sachs, Morgan Stanley, JPMorgan, Evercore, Centerview, PJT Partners or Lazard.",
      ],
      ["What's your timeline?", "Recruiting for a summer 2026 investment banking summer analyst internship."],
      ["Locations?", "New York City."],
      ["What do you want from a mentor?", "Recruiting and networking advice, and what superdays are like."],
      ["Seniority?", "Analysts or associates, 1-4 years in. Not managing directors."],
      [
        "Does shared background matter?",
        "Indiana University / Kelley alumni. That's the most important thing to me, the IBW network is how people from IU break in.",
      ],
      [
        "Anything to avoid?",
        "Avoid wealth management, financial advisors, and retail or commercial banking. That's not the same job.",
      ],
    ],
  },
  highSchool: {
    docs: {
      resume: `Maya Chen
Lincoln Park High School, Chicago, IL, Class of 2026, GPA 4.3 weighted, IB Diploma candidate
Coursework: IB HL Biology, IB HL Chemistry, AP Calculus BC, AP Physics C
Activities: Science Olympiad, captain; volunteer at Lurie Children's Hospital; founder of a peer tutoring club
Awards: Illinois Science Olympiad state medalist, 2025
Location: Chicago, IL`,
    },
    interview: [
      [
        "Hi Maya! I see you captain Science Olympiad. What field are you interested in?",
        "I'm in high school, so not an industry yet. I want to study biomedical engineering in college.",
      ],
      [
        "Who would you like to talk to?",
        "Current college students studying biomedical engineering at the schools I'm applying to: Johns Hopkins University, Duke University, Georgia Tech and Northwestern University. Current undergrads are exactly who I want.",
      ],
      ["What's your timeline?", "Applying to college this fall, starting in fall 2026."],
      ["Location?", "Anywhere, I'm open to moving for college."],
      ["What do you want from them?", "What the BME program is really like, and advice on applications and essays."],
      ["Seniority?", "Current undergrads or people who graduated in the last year or two. Not professors or people far along in their careers."],
      ["Shared background?", "Someone from Chicago would be amazing, but not required."],
      ["Anything to avoid?", "No paid college admissions consultants or counselors trying to sell something."],
    ],
  },
  research: {
    docs: {
      resume: `Sam Okafor
University of Chicago, B.S. Neuroscience and B.A. Linguistics, expected June 2028, GPA 3.9
Coursework: Cognitive Neuroscience, Computational Linguistics, Introduction to Machine Learning, Statistics
Experience:
Research Intern, Northwestern Summer Research Opportunity Program, Summer 2025: fMRI data preprocessing
Tutor, UChicago Neighborhood Schools Program, 2024-present
Skills: Python, MATLAB, R, PsychoPy
Location: Chicago, IL`,
    },
    interview: [
      ["Hi Sam! I see you did fMRI preprocessing at Northwestern. What are you looking for?", "Academic research. I want to join a research lab this year."],
      [
        "Who do you want to talk to?",
        "Professors who run labs, postdocs, or PhD students at the University of Chicago working on computational neuroscience or natural language processing. PhD students are great since they know which labs take undergrads.",
      ],
      ["What's your timeline?", "Join a lab this winter quarter and do research until I graduate in 2028."],
      ["Location?", "They must be at UChicago. I need to do this on campus while taking classes."],
      ["What do you want from them?", "Which labs take undergrads, how to cold-email PIs, and what research is like day to day."],
      ["Seniority?", "Anyone from PhD students to faculty."],
      ["Shared background?", "Being at UChicago is required, that's the whole point."],
      ["Anything to avoid?", "Not industry researchers at companies, and not people outside UChicago."],
    ],
  },
} satisfies Record<string, Persona>;

type ScenarioName = keyof typeof PERSONAS;

const ALL_SCENARIOS = Object.keys(PERSONAS) as ScenarioName[];
const SELECTED = process.env.LIVE_SCENARIOS
  ? ALL_SCENARIOS.filter((n) => process.env.LIVE_SCENARIOS!.split(",").includes(n))
  : ALL_SCENARIOS;
/** Personas who asked to meet current students, so the student cap mustn't hold them back. */
const WANTS_STUDENTS: ScenarioName[] = ["premed", "highSchool", "research"];

// ─── Evidence heuristics (headline + snippet only, like the scorer) ──────────
const text = (m: { headline: string; snippet?: string }) => `${m.headline} ${m.snippet ?? ""}`;
const QUANT_FIRM =
  /Citadel|Jane Street|Two Sigma|Hudson River|Jump Trading|XTX|D\.? ?E\.? Shaw|Susquehanna|\bSIG\b|Optiver|\bIMC\b|Tower Research|Renaissance|Millennium|\bDRW\b|Five Rings|Virtu|Qube|\bQRT\b|\bAQR\b|WorldQuant|Point72|Cubist|Balyasny|Radix|Man Group|Squarepoint|Hudson Bay/i;
const ML = /machine learning|\bML\b|deep learning|\bAI\b|artificial intelligence|neural|\bLLMs?\b|reinforcement learning|statistical learning/i;
const SENIOR = /managing director|\bMD\b|head of|partner|director|chief|\bCEO\b|\bCTO\b|founder|president|\bVP\b|vice president|principal/i;
const ENERGY_TRADING = /trad(er|ing)|\bpower\b|natural gas|\bgas\b|energy|commodit/i;
const HOUSTON = /Houston|Sugar Land|Katy|Woodlands|Pearland|Conroe|Spring|Cypress|Humble|Tomball|Pasadena|Baytown|League City|Missouri City|Bellaire/i; // Greater Houston
const STUDENT = /\b(student|undergrad(uate)?|phd candidate|class of 20\d\d)\b/i;
const EDU_EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)*\.edu\b/i;
const GENDERED = /\b(he|she|him|her|his|hers|himself|herself)\b/i;
const CLINICAL =
  /\bM\.?D\.?\b|\bD\.?O\.?\b|physician|doctor|resident\b|residency|medical student|med student|\bMS[1-4]\b|\bM[1-4]\b|school of medicine|medical school|college of medicine|emergency medicine|attending|\bEM\b|\bPGY/i;
const NON_CLINICAL = /pharmaceutical sales|sales rep|\bsales\b|consulting|consultant|administrator|administration/i;
const MED_STUDENT = /medical student|med student|\bMS[1-4]\b|\bM[1-4]\b|M\.?D\.? candidate|M\.?D\.? student|class of 20\d\d/i;
const BANK_FIRM =
  /Goldman|Morgan Stanley|J\.?\s?P\.?\s?Morgan|JPMorgan|Evercore|Centerview|PJT|Lazard|Moelis|Guggenheim|Houlihan|Jefferies|Citi|Bank of America|BofA|Barclays|UBS|Deutsche|Perella|Qatalyst|William Blair|Raymond James|Piper|Lincoln International|Harris Williams|RBC|Wells Fargo|Baird|KeyBanc|Stifel|Rothschild|Greenhill|Solomon/i;
const IB_ROLE = /investment bank|\bIBD?\b|M&A|mergers|capital markets|leveraged finance|coverage/i;
const JUNIOR_BANKER = /\banalyst\b|\bassociate\b/i;
const NOT_IB = /wealth|financial advisor|financial adviser|private bank|branch|retail bank|commercial bank|relationship banker|personal banker|financial planner/i;
const IU = /Indiana University|Kelley/i;
const TARGET_COLLEGE = /Johns Hopkins|Duke|Georgia (Institute of )?Tech|Georgia Tech|Northwestern/i;
const COLLEGE_STUDENT = /\bstudent\b|undergrad|\bclass of 20(2[5-9]|30)\b|'(2[5-9]|30)\b|\b20(2[6-9]|30)\b|\bB\.?S\.?E?\.? (candidate|student)|biomedical engineering (student|major)|\bBME\b|biomedical/i;
const UCHICAGO = /University of Chicago|UChicago|Pritzker School|Booth School|Crerar|Argonne/i;
const ACADEMIC =
  /professor|postdoc|post-doc|postdoctoral|ph\.?d|doctoral|graduate student|grad student|research (scientist|assistant|associate|fellow|specialist)|\blab\b|laborator|principal investigator|\bPI\b|faculty|lecturer|researcher/i;
const FOCUS = /neuroscien|neural|brain|cognitive|\bNLP\b|natural language|language model|linguistic|computational/i;
const INDUSTRY_RESEARCH = /\b(Google|Meta|Microsoft|Amazon|OpenAI|Anthropic|Apple|NVIDIA|IBM|Adobe|Salesforce)\b/i;
const ADMISSIONS_SELLER = /admissions consult|college consult|college counsel|admissions coach|college advis|admissions advis|admissions counsel|essay coach/i;

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
    const results = await Promise.all(SELECTED.map(runScenario));
    SELECTED.forEach((n, i) => (runs[n] = results[i]));
  }, RUN_TIMEOUT);

  const describePeople = (list: { name: string; headline: string; score?: number }[]) =>
    list.map((m) => `[${m.score ?? "-"}] ${m.name} | ${m.headline}`).join("\n");
  /** A check about one persona; skipped when that persona isn't selected. */
  const itFor = (name: ScenarioName, title: string, fn: () => void) => it.skipIf(!SELECTED.includes(name))(title, fn);
  const atLeastHalf = (list: Mentor[], match: (m: Mentor) => boolean, what: string) => {
    const hits = list.filter(match);
    expect(hits.length, `${what}: ${hits.length}/${list.length}\nall:\n${describePeople(list)}`).toBeGreaterThanOrEqual(
      Math.ceil(list.length / 2),
    );
  };

  itFor("quantAi", "quant + AI: most mentors show both a quant firm and ML", () => {
    const { mentors } = runs.quantAi;
    const both = mentors.filter((m) => QUANT_FIRM.test(text(m)) && ML.test(text(m)));
    expect(both.length, `mentors with quant + ML evidence:\n${describePeople(both)}\nall:\n${describePeople(mentors)}`).toBeGreaterThanOrEqual(
      Math.ceil(mentors.length / 2),
    );
  });

  itFor("quantAi", "quant + AI: nobody without ML evidence outscores someone with it", () => {
    const { mentors } = runs.quantAi;
    const withMl = mentors.filter((m) => ML.test(text(m)));
    const withoutMl = mentors.filter((m) => !ML.test(text(m)));
    if (withMl.length === 0) return; // covered by the test above
    const lowestMl = Math.min(...withMl.map((m) => m.score));
    const above = withoutMl.filter((m) => m.score > lowestMl);
    expect(above, `no ML evidence, yet above an ML match (${lowestMl}):\n${describePeople(above)}`).toEqual([]);
  });

  itFor("seniorLeaders", "seniority named as most important gets the most rubric points", () => {
    const points = rubricPoints(runs.seniorLeaders.rubric);
    const seniority = [...points].find(([name]) => /senior/.test(name))?.[1] ?? 0;
    expect(seniority, runs.seniorLeaders.rubric).toBe(Math.max(...points.values()));
  });

  itFor("seniorLeaders", "seniority named as most important: no junior outscores the best senior leader", () => {
    // Stream events carry no snippet; the returned mentors do.
    const snippets = new Map(runs.seniorLeaders.mentors.map((m) => [m.slug, m.snippet]));
    const scored = runs.seniorLeaders.scored.map((s) => ({ ...s, snippet: s.snippet ?? snippets.get(s.slug) }));
    const bestSenior = scored.find(isSenior);
    expect(bestSenior, `no senior leader was scored at all:\n${describePeople(scored)}`).toBeDefined();
    const above = scored.filter((s) => !isSenior(s) && s.score > bestSenior!.score);
    expect(above, `outscore ${bestSenior!.name} (${bestSenior!.score}):\n${describePeople(above)}`).toEqual([]);
  });

  itFor("houston", "non-negotiable location becomes a cap in the rubric", () => {
    const caps = rubricCaps(runs.houston.rubric);
    expect(caps.some((c) => /Houston/i.test(c)), runs.houston.rubric).toBe(true);
  });

  itFor("houston", "Houston energy trading: most mentors work in energy trading", () => {
    const { mentors } = runs.houston;
    const relevant = mentors.filter((m) => ENERGY_TRADING.test(text(m)));
    expect(relevant.length, `all mentors:\n${describePeople(mentors)}`).toBeGreaterThanOrEqual(Math.ceil(mentors.length / 2));
  });

  itFor("houston", "Houston energy trading: every mentor with a known location is in Houston", () => {
    const outside = runs.houston.mentors.filter((m) => location(m) && !HOUSTON.test(location(m)!));
    expect(outside, describePeople(outside)).toEqual([]);
  });

  it("most queries return at least one person", () => {
    // Over-filtered queries (title + company + school + location) return nobody.
    for (const [name, run] of Object.entries(runs)) {
      expect(run.scored.length, `${name} found only ${run.scored.length} people:\n${run.queries.join("\n")}`).toBeGreaterThanOrEqual(20);
    }
  });

  // ─── Premed ───
  itFor("premed", "premed: most mentors are on the clinical path (physicians, residents, med students)", () => {
    atLeastHalf(runs.premed.mentors, (m) => CLINICAL.test(text(m)), "clinical");
  });

  itFor("premed", "premed: pharma sales, consulting and administrators are held down", () => {
    const over = runs.premed.mentors.filter((m) => NON_CLINICAL.test(m.headline) && !CLINICAL.test(m.headline) && m.score > 10);
    expect(over, describePeople(over)).toEqual([]);
  });

  // Checked over everyone scored, by headline: a capped student never reaches the top 10.
  itFor("premed", "premed: medical students they asked for aren't held to the student cap", () => {
    // Test-prep and tutoring accounts ("Medical student and resident support") aren't students.
    const capped = runs.premed.scored.filter((s) => MED_STUDENT.test(s.headline) && !/support|prep|tutor|coach|services/i.test(s.headline) && s.score <= 10);
    expect(capped, describePeople(capped)).toEqual([]);
  });

  // ─── Investment banking ───
  itFor("banking", "banking: most mentors are investment bankers", () => {
    atLeastHalf(runs.banking.mentors, (m) => IB_ROLE.test(text(m)) || (BANK_FIRM.test(text(m)) && JUNIOR_BANKER.test(m.headline)), "IB");
  });

  itFor("banking", "banking: wealth management, advisors and retail/commercial banking are held down", () => {
    const over = runs.banking.mentors.filter((m) => NOT_IB.test(m.headline) && m.score > 10);
    expect(over, describePeople(over)).toEqual([]);
  });

  itFor("banking", "banking: shared school named as most important gets the most rubric points", () => {
    const points = rubricPoints(runs.banking.rubric);
    const shared = [...points].find(([name]) => /shared|school|alum|alma|indiana|kelley|background/.test(name))?.[1] ?? 0;
    expect(shared, runs.banking.rubric).toBe(Math.max(...points.values()));
  });

  itFor("banking", "banking: most mentors are Indiana University / Kelley alumni", () => {
    atLeastHalf(runs.banking.mentors, (m) => IU.test(text(m)), "IU alumni");
  });

  // ─── High school ───
  itFor("highSchool", "high school: most mentors are students or recent grads at the target colleges", () => {
    atLeastHalf(runs.highSchool.mentors, (m) => TARGET_COLLEGE.test(text(m)) && COLLEGE_STUDENT.test(text(m)), "target-college students");
  });

  itFor("highSchool", "high school: BME undergrads at target colleges aren't held to the student cap", () => {
    const capped = runs.highSchool.scored.filter(
      (s) => TARGET_COLLEGE.test(s.headline) && /biomedical|\bBME\b/i.test(s.headline) && /\b(student|undergrad)/i.test(s.headline) && !/ph\.?d/i.test(s.headline) && s.score <= 10,
    );
    expect(capped, describePeople(capped)).toEqual([]);
  });

  itFor("highSchool", "high school: paid admissions consultants are held down", () => {
    const over = runs.highSchool.mentors.filter((m) => ADMISSIONS_SELLER.test(text(m)) && m.score > 10);
    expect(over, describePeople(over)).toEqual([]);
  });

  // ─── Research at a school ───
  itFor("research", "research: most mentors are academic researchers at the user's school", () => {
    atLeastHalf(runs.research.mentors, (m) => UCHICAGO.test(text(m)) && ACADEMIC.test(text(m)), "UChicago researchers");
  });

  itFor("research", "research: most mentors work in the user's focus areas", () => {
    atLeastHalf(runs.research.mentors, (m) => FOCUS.test(text(m)), "focus areas");
  });

  itFor("research", "research: nobody outside the school outscores someone at it", () => {
    const at = runs.research.mentors.filter((m) => UCHICAGO.test(text(m)));
    if (at.length === 0) return; // covered by the first research check
    const lowest = Math.min(...at.map((m) => m.score));
    const above = runs.research.mentors.filter((m) => !UCHICAGO.test(text(m)) && m.score > lowest);
    expect(above, `not at UChicago, yet above a UChicago match (${lowest}):\n${describePeople(above)}`).toEqual([]);
  });

  itFor("research", "research: industry researchers are held down", () => {
    const over = runs.research.mentors.filter((m) => INDUSTRY_RESEARCH.test(m.headline) && !UCHICAGO.test(m.headline) && m.score > 25);
    expect(over, describePeople(over)).toEqual([]);
  });

  itFor("research", "research: PhD students they asked for aren't held to the student cap", () => {
    const capped = runs.research.scored.filter((s) => /ph\.?d\.? (student|candidate)|doctoral (student|candidate)/i.test(s.headline) && UCHICAGO.test(s.headline) && s.score <= 10);
    expect(capped, describePeople(capped)).toEqual([]);
  });

  // ─── Every persona ───
  it("current students are capped at 10 unless the user asked for them", () => {
    const over = Object.entries(runs)
      .filter(([name]) => !WANTS_STUDENTS.includes(name as ScenarioName))
      .flatMap(([, r]) => r.mentors)
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
