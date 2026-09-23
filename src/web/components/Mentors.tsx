// OWNER: Ania
// Build the results step. Do not change the Props type.
import { useState } from "react";
import type { Mentor } from "../../shared/schemas";
import { findMentors } from "../lib/api";
import { MentorCard } from "./MentorCard";

type Props = {
  mentors: Mentor[]; // already shown, best first
  onChange: () => void; // call after a search finishes to reload page state
};

export function Mentors({ mentors, onChange }: Props) {
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const busy = progress !== null;

  async function search() {
    setError(null);
    setExhausted(false);
    setProgress("Starting search…");
    try {
      const found = await findMentors(setProgress);
      if (found.length === 0) setExhausted(true);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong while finding mentors.");
    } finally {
      setProgress(null);
    }
  }

  const label = mentors.length === 0 ? "Find mentors" : "Show 10 more";

  return (
    <div className="stack">
      {mentors.length === 0 && !busy && !error && (
        <p className="muted">We'll search for people who match your background and goals, then explain why each is worth a chat.</p>
      )}

      {mentors.length > 0 && (
        <div className="grid">
          {mentors.map((m) => (
            <MentorCard key={m.slug} mentor={m} />
          ))}
        </div>
      )}

      {busy && (
        <p className="progress" role="status">
          <span className="spinner" aria-hidden="true" /> {progress}
        </p>
      )}

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
