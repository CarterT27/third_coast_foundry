// Reference component: shows the house style for presentational components —
// typed props, no data fetching, classes from styles.css.
import type { Mentor } from "../../shared/schemas";

export function MentorCard({ mentor }: { mentor: Mentor }) {
  return (
    <article className="card">
      <div className="card__header">
        <div>
          <a className="card__name" href={mentor.url} target="_blank" rel="noopener noreferrer">
            {mentor.name}
          </a>
          <p className="card__headline">{mentor.headline}</p>
        </div>
        <span className="badge" title={mentor.reason}>
          {mentor.score}
        </span>
      </div>
      {mentor.blurb && <p className="card__blurb">{mentor.blurb}</p>}
    </article>
  );
}
