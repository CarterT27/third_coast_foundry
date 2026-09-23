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

  const refresh = useCallback(() => void load(), [load]);

  if (error && !state) return <main className="app"><p className="error">{error}</p></main>;
  if (!state) return <main className="app"><p className="muted">Loading…</p></main>;

  const stage = deriveStage(state, continued);
  const stepState = (s: Stage): StepState => {
    const diff = STAGES.indexOf(s) - STAGES.indexOf(stage);
    return diff < 0 ? "done" : diff === 0 ? "active" : "locked";
  };

  return (
    <main className="app">
      <header className="app__header">
        <h1>Find your mentors</h1>
        <p className="muted">Share your background, tell us what you're looking for, and we'll find people worth meeting.</p>
      </header>

      <Step
        number={1}
        title="Your background"
        state={stepState("upload")}
        summary={state.documents.map((d) => d.filename).join(" · ")}
      >
        <Upload documents={state.documents} onChange={refresh} onContinue={() => setContinued(true)} />
      </Step>

      <Step number={2} title="Interview" state={stepState("interview")} summary="Interview complete">
        <Interview interview={state.interview} onChange={refresh} />
      </Step>

      <Step number={3} title="Your mentors" state={stepState("mentors")}>
        <Mentors mentors={state.mentors} onChange={refresh} />
      </Step>
    </main>
  );
}
