// Live view of a mentor search: each query's results arrive as name chips, chips get
// scores and re-sort as scoring batches land, then everyone but the top picks fades
// out and the picks line up in rank order while their notes are written.
// `searchReducer` turns stream events into the state this component draws.
import { useState, type CSSProperties } from "react";
import { TOP_N, type MentorPreview } from "../../shared/schemas";
import type { MentorsProgress } from "../lib/api";

/** Most chips drawn at once; the rest are counted. */
const MAX_CHIPS = 120;

type Stage = "planning" | "searching" | "scoring" | "picking" | "done";
type Query = { text: string; status: "running" | "done" | "failed"; found: number };
type Person = MentorPreview & { query?: number; score?: number; leaving?: boolean };
type Pick = MentorPreview & { score: number };

export type SearchRun = {
  stage: Stage;
  message: string;
  queries: Query[];
  people: Person[]; // display order
  scoring: { done: number; total: number };
  picks: Pick[] | null;
};

export type SearchAction =
  | MentorsProgress
  | { type: "start" }
  | { type: "prune" } // drop chips that finished fading out
  | { type: "finish" }
  | { type: "reset" };

export function searchReducer(run: SearchRun | null, action: SearchAction): SearchRun | null {
  if (action.type === "start") {
    return { stage: "planning", message: "Starting search…", queries: [], people: [], scoring: { done: 0, total: 0 }, picks: null };
  }
  if (action.type === "reset" || !run) return null;

  switch (action.type) {
    case "progress":
      return { ...run, message: action.message };
    case "queries":
      return { ...run, stage: "searching", queries: action.queries.map((text) => ({ text, status: "running", found: 0 })) };
    case "found": {
      const known = new Set(run.people.map((p) => p.slug));
      const fresh = action.candidates.filter((c) => !known.has(c.slug)).map((c) => ({ ...c, query: action.index }));
      return {
        ...run,
        queries: run.queries.map((q, i) =>
          i === action.index ? { ...q, status: action.failed ? "failed" : "done", found: fresh.length } : q,
        ),
        people: [...run.people, ...fresh],
      };
    }
    case "scoring": {
      const bySlug = new Map(run.people.map((p) => [p.slug, p]));
      const scoring = new Set(action.candidates.map((c) => c.slug));
      return {
        ...run,
        stage: "scoring",
        scoring: { done: 0, total: action.candidates.length },
        // People skipped for scoring (already seen in an earlier run) fade out.
        people: [
          ...action.candidates.map((c) => ({ ...c, ...bySlug.get(c.slug) })),
          ...run.people.filter((p) => !scoring.has(p.slug)).map((p) => ({ ...p, leaving: true })),
        ],
      };
    }
    case "scored": {
      const scores = new Map(action.scores.map((s) => [s.slug, s.score]));
      const people = run.people.map((p) => (scores.has(p.slug) ? { ...p, score: scores.get(p.slug) } : p));
      return {
        ...run,
        scoring: { ...run.scoring, done: Math.min(run.scoring.total, run.scoring.done + action.scores.length) },
        people: sortByScore(people),
      };
    }
    case "selected": {
      const picked = new Set(action.mentors.map((m) => m.slug));
      return {
        ...run,
        stage: "picking",
        picks: action.mentors,
        people: run.people.map((p) => (picked.has(p.slug) ? p : { ...p, leaving: true })),
      };
    }
    case "prune":
      return { ...run, people: run.people.filter((p) => !p.leaving) };
    case "finish":
      return { ...run, stage: "done", message: "Loading your mentors…" };
  }
}

/** Scored people first, best first; unscored keep their order at the end. */
function sortByScore(people: Person[]): Person[] {
  return people
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (b.p.score ?? -1) - (a.p.score ?? -1) || a.i - b.i)
    .map(({ p }) => p);
}

const STAGES: { key: Stage[]; label: string }[] = [
  { key: ["planning", "searching"], label: "Search" },
  { key: ["scoring"], label: "Score" },
  { key: ["picking", "done"], label: "Pick" },
];

function percent(run: SearchRun): number {
  const done = run.queries.filter((q) => q.status !== "running").length;
  switch (run.stage) {
    case "planning":
      return 4;
    case "searching":
      return 5 + (40 * done) / Math.max(1, run.queries.length);
    case "scoring":
      return 45 + (40 * run.scoring.done) / Math.max(1, run.scoring.total);
    case "picking":
      return 92;
    case "done":
      return 100;
  }
}

function tier(score: number | undefined): string {
  if (score === undefined) return "";
  return score >= 70 ? " chip--high" : score >= 40 ? " chip--mid" : " chip--low";
}

/** The query minus the part every query shares. */
const shortQuery = (q: string) => q.replace(/^site:linkedin\.com\/in\s*/, "");

export function SearchBoard({ run }: { run: SearchRun }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const stageIndex = STAGES.findIndex((s) => s.key.includes(run.stage));
  const value = Math.round(percent(run));
  const found = run.people.filter((p) => !p.leaving).length;
  const showRows = run.picks !== null && !run.people.some((p) => p.leaving);
  const chips = run.people.slice(0, MAX_CHIPS);
  const hidden = run.people.length - chips.length;
  const queriesDone = run.queries.filter((q) => q.status !== "running").length;

  let counter = "";
  if (run.stage === "searching") counter = `${queriesDone} of ${run.queries.length} searches · ${found} people`;
  if (run.stage === "scoring") counter = `${run.scoring.done} of ${run.scoring.total} scored`;
  if (run.picks && run.scoring.total) counter = `Top ${run.picks.length} of ${run.scoring.total}`;

  return (
    <section className="board" aria-busy={run.stage !== "done"}>
      <div className="board__header">
        <ol className="board__stages">
          {STAGES.map((s, i) => (
            <li
              key={s.label}
              className={`board__stage${i === stageIndex ? " board__stage--active" : ""}${i < stageIndex ? " board__stage--done" : ""}`}
            >
              {s.label}
            </li>
          ))}
        </ol>
        {counter && <span className="board__counter">{counter}</span>}
      </div>

      <div
        className={`meter${run.stage === "done" ? " meter--done" : ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-label="Search progress"
      >
        <div className="meter__fill" style={{ width: `${value}%` }} />
      </div>

      <p className="progress" role="status">
        {run.stage !== "done" && <span className="spinner" aria-hidden="true" />} {run.message}
      </p>

      {run.stage === "searching" && (
        <ul className="queries">
          {run.queries.map((q, i) => (
            <li
              key={i}
              className={`query query--${q.status}${hovered === i ? " query--hovered" : ""}`}
              style={{ "--q": i } as CSSProperties}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
            >
              <span className="query__dot" aria-hidden="true" />
              <code className="query__text" title={q.text}>
                {shortQuery(q.text)}
              </code>
              <span className="query__count">
                {q.status === "running" ? <span className="spinner spinner--small" aria-label="Searching" /> : null}
                {q.status === "done" && `+${q.found}`}
                {q.status === "failed" && "failed"}
              </span>
            </li>
          ))}
        </ul>
      )}

      {showRows ? (
        <ol className="picks">
          {run.picks?.map((m, i) => (
            <li key={m.slug} data-flip={m.slug} className="pick">
              <span className="pick__rank">{i + 1}</span>
              <div className="pick__body">
                <span className="pick__name">{m.name}</span>
                <span className="pick__headline">{m.headline}</span>
                <span className="shimmer" aria-hidden="true" />
              </div>
              <span className="badge">{m.score}</span>
            </li>
          ))}
        </ol>
      ) : (
        chips.length > 0 && (
          <ul className="chips" aria-label={`${found} people found`}>
            {chips.map((p) => (
              <li
                key={p.slug}
                data-flip={p.slug}
                title={p.headline}
                style={p.query === undefined ? undefined : ({ "--q": p.query } as CSSProperties)}
                className={`chip${tier(p.score)}${p.leaving ? " chip--leaving" : ""}${
                  hovered !== null && p.query !== hovered ? " chip--dim" : ""
                }`}
              >
                {p.score === undefined && p.query !== undefined && <span className="chip__dot" aria-hidden="true" />}
                {p.name}
                {p.score !== undefined && <span className="chip__score">{p.score}</span>}
              </li>
            ))}
            {hidden > 0 && <li className="chip chip--more">+{hidden} more</li>}
          </ul>
        )
      )}

      {run.stage === "scoring" && found > TOP_N && (
        <p className="muted board__hint">Keeping the {TOP_N} best matches.</p>
      )}
    </section>
  );
}
