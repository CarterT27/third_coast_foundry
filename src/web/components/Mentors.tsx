// OWNER: Ania
// Build the results step. Do not change the Props type.
import { useEffect, useReducer, useRef, useState } from "react";
import type { Mentor } from "../../shared/schemas";
import { findMentors } from "../lib/api";
import { MentorCard } from "./MentorCard";
import { SearchBoard, searchReducer } from "./SearchBoard";
import { useFlip } from "./useFlip";

type Props = {
  mentors: Mentor[]; // already shown, best first
  onChange: () => void; // call after a search finishes to reload page state
};

/** How long fading chips stay before they're removed and the picks line up. */
const FADE_MS = 650;
/** Minimum time the ranked picks stay up, so the animation finishes before the cards arrive. */
const PICKS_MIN_MS = 1200;

export function Mentors({ mentors, onChange }: Props) {
  const [run, dispatch] = useReducer(searchReducer, null);
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const pickedAt = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  useFlip(root);

  const busy = run !== null && run.stage !== "done";
  // Keep the board up after "done" until the page state includes the new mentors.
  const arrived = run?.picks?.some((p) => mentors.some((m) => m.slug === p.slug)) ?? false;
  const showBoard = run !== null && !(run.stage === "done" && arrived);

  // Editing the interview or documents clears the shown mentors while this step stays
  // mounted; drop the last run so its board doesn't come back in place of the cards.
  const shownBefore = useRef(mentors.length);
  useEffect(() => {
    if (shownBefore.current > 0 && mentors.length === 0) {
      dispatch({ type: "reset" });
      setExhausted(false);
      setError(null);
    }
    shownBefore.current = mentors.length;
  }, [mentors.length]);

  const leaving = run?.people.some((p) => p.leaving) ?? false;
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => dispatch({ type: "prune" }), FADE_MS);
    return () => clearTimeout(timer);
  }, [leaving]);

  async function search() {
    setError(null);
    setExhausted(false);
    pickedAt.current = 0;
    dispatch({ type: "start" });
    try {
      const found = await findMentors((event) => {
        if (event.type === "selected") pickedAt.current = Date.now();
        dispatch(event);
      });
      if (found.length === 0) {
        setExhausted(true);
        dispatch({ type: "reset" });
        onChange();
        return;
      }
      const wait = pickedAt.current + FADE_MS + PICKS_MIN_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      dispatch({ type: "finish" });
      onChange();
    } catch (err) {
      dispatch({ type: "reset" });
      setError(err instanceof Error ? err.message : "Something went wrong while finding mentors.");
    }
  }

  const label = mentors.length === 0 ? "Find mentors" : "Show 10 more";

  return (
    <div className="stack mentors" ref={root}>
      {mentors.length === 0 && !run && !error && (
        <p className="muted">We'll search for people who match your background and goals, then explain why each is worth a chat.</p>
      )}

      {mentors.length > 0 && (
        <div className="grid">
          {mentors.map((m) => (
            <div key={m.slug} data-flip={m.slug}>
              <MentorCard mentor={m} />
            </div>
          ))}
        </div>
      )}

      {run && showBoard && <SearchBoard run={run} />}

      {error && (
        <div className="notice notice--error" role="alert">
          <p className="error">{error}</p>
          <button className="button button--secondary" onClick={search}>
            Try again
          </button>
        </div>
      )}

      {exhausted && !busy && <p className="muted">No new mentors this time. Try editing your interview to broaden the search.</p>}

      {!error && (
        <button className="button" disabled={busy} onClick={search}>
          {label}
        </button>
      )}
    </div>
  );
}
