// OWNER: Ania
// Build the results step. Do not change the Props type.
import type { Mentor } from "../../shared/schemas";
import { MentorCard } from "./MentorCard";

type Props = {
  mentors: Mentor[]; // already shown, best first
  onChange: () => void; // call after a search finishes to reload page state
};

/**
 * TODO:
 * - "Find mentors" button when `mentors` is empty; "Show 10 more" below the list otherwise.
 * - On click: `findMentors(onProgress)` from lib/api, showing the progress message
 *   (Searching… → Scoring… → Writing…) while it runs, then `onChange()`.
 * - Show errors with a retry button.
 * - Tip: set PUBLIC_USE_FIXTURES=true in .env to build this with fake data.
 */
export function Mentors({ mentors }: Props) {
  return (
    <div className="stack">
      <p className="muted">TODO: find / show more buttons and progress.</p>
      <div className="grid">
        {mentors.map((m) => (
          <MentorCard key={m.slug} mentor={m} />
        ))}
      </div>
    </div>
  );
}
