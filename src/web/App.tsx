// One page, three steps. The active step is derived from server state (not stored),
// so a refresh or a return visit lands on the right step automatically.
import { useCallback, useEffect, useState } from "react";
import type { AppState } from "../shared/schemas";
import { Interview } from "./components/Interview";
import { Mentors } from "./components/Mentors";
import { Step, type StepState } from "./components/Step";
import { Upload } from "./components/Upload";
import { getState } from "./lib/api";

const STAGES = ["upload", "interview", "mentors"] as const;
type Stage = (typeof STAGES)[number];

function deriveStage(state: AppState, continued: boolean): Stage {
  const uploadDone = state.documents.length > 0 && (continued || state.interview.messages.length > 0);
  if (!uploadDone) return "upload";
  if (!state.interview.done) return "interview";
  return "mentors";
}

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Local only: lets the user upload several files before moving on.
  const [continued, setContinued] = useState(false);
  // Which done step (if any) has its panel expanded for editing.
  const [editing, setEditing] = useState<Stage | null>(null);
  // Bumped to scroll to the interview step after "Continue", even when the stage
  // itself doesn't change (e.g. the user came back to step 1 to add a file).
  const [jumpToInterview, setJumpToInterview] = useState(0);

  const load = useCallback(
    () =>
      getState().then(
        (next) => {
          setState(next);
          setError(null);
        },
        (err: unknown) => setError(err instanceof Error ? err.message : "Could not load your data"),
      ),
    [],
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (jumpToInterview > 0) document.getElementById("step-2")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [jumpToInterview]);

  const refresh = useCallback(() => void load(), [load]);

  if (error && !state) return <main className="app"><p className="error">{error}</p></main>;
  if (!state) return <main className="app"><p className="muted">Loading…</p></main>;

  const stage = deriveStage(state, continued);
  const stepState = (s: Stage): StepState => {
    const diff = STAGES.indexOf(s) - STAGES.indexOf(stage);
    return diff < 0 ? "done" : diff === 0 ? "active" : "locked";
  };
  const editProps = (s: Stage) => ({
    open: editing === s,
    onOpenChange: (open: boolean) => setEditing(open ? s : null),
  });
  const continueToInterview = () => {
    setContinued(true);
    // Collapse step 1; if the interview is already finished, reopen it so there's something to land on.
    setEditing(state.interview.done ? "interview" : null);
    setJumpToInterview((n) => n + 1);
  };

  return (
    <main className="app">
      <header className="app__header">
        <h1>Find your mentors</h1>
        <p className="muted">Share your background, tell us what you're looking for, and we'll find people worth meeting.</p>
      </header>

      {error && (
        <div className="notice notice--error app__toast" role="alert">
          <p className="error">Couldn't refresh: {error}</p>
          <button className="button button--secondary" onClick={refresh}>
            Retry
          </button>
          <button className="button button--secondary" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <Step
        number={1}
        title="Your background"
        state={stepState("upload")}
        summary={state.documents.map((d) => d.filename).join(" · ")}
        {...editProps("upload")}
      >
        <Upload documents={state.documents} onChange={refresh} onContinue={continueToInterview} />
      </Step>

      <Step number={2} title="Interview" state={stepState("interview")} summary="Interview complete" {...editProps("interview")}>
        <Interview interview={state.interview} onChange={refresh} />
      </Step>

      <Step number={3} title="Your mentors" state={stepState("mentors")}>
        <Mentors mentors={state.mentors} onChange={refresh} />
      </Step>

      <footer className="app__footer">
        <a href="https://github.com/CarterT27/third_coast_foundry" target="_blank" rel="noopener noreferrer">
          <svg className="app__github" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
            <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2.17c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.05.78 2.12v3.14c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
          </svg>
          View on GitHub
        </a>
      </footer>
    </main>
  );
}
