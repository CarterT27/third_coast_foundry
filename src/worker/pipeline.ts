// Orchestration: the only code that combines services with the database.
// Services stay pure (LLM + search in, data out); this file decides what to
// reuse, what to recompute, and what to persist.
import {
  MAX_SCORE_PER_RUN,
  SCORE_BATCH_SIZE,
  TOP_N,
  type Candidate,
  type ChatMessage,
  type DocumentSummary,
  type Mentor,
  type MentorsEvent,
  type UploadDocumentBody,
  type UploadKind,
} from "../shared/schemas";
import type { Env } from "./env";
import type { Db } from "./lib/db";
import { SearchCapacityError } from "./lib/search-provider";
import { SubrequestLimitError, subrequestsLeft, withSubrequestLimit } from "./lib/subrequests";
import { writeBlurbs } from "./services/blurbs";
import { extractContext } from "./services/documents";
import { nextTurn, summarize } from "./services/interview";
import { scoreBatch } from "./services/score";
import { generateQueries, runSearch } from "./services/search";

/** Per-document cap on raw text sent with every interview turn. */
const INTERVIEW_DOC_CHARS = 20_000;

/**
 * Subrequests held back for what comes after a step, so running out mid-step still leaves
 * room to save and return. After searching: toScore, scoring (a call + a save per batch, some
 * retries), then the final steps. After scoring: unshownPool, blurbs (with retries),
 * saveBlurbs, markShown.
 */
const RESERVE_AFTER_SEARCH = 22;
const RESERVE_AFTER_SCORING = 10;

/**
 * Stores the raw text only, so uploads never wait on the LLM; fillNotes writes the
 * context note later. Re-uploading identical text is a no-op.
 */
export async function saveDocument(env: Env, db: Db, body: UploadDocumentBody): Promise<DocumentSummary> {
  if ((await db.getRawText(body.kind)) === body.text) {
    return db.getDocumentSummary(body.kind);
  }
  return db.upsertDocument({ ...body, rawText: body.text, context: "" });
}

/** Removes an uploaded document; the next search rescores everyone without it. */
export async function deleteDocument(env: Env, db: Db, kind: UploadKind): Promise<void> {
  await db.deleteDocument(kind);
}

/** Saved when the LLM finds nothing to note, so the document isn't re-sent on every search. */
const EMPTY_NOTE = "No details relevant to finding mentors.";

/** Writes context notes for documents that don't have one yet, in parallel. */
async function fillNotes(env: Env, db: Db): Promise<void> {
  const missing = await db.documentsWithoutNotes();
  await Promise.all(
    missing.map(async (d) =>
      db.saveNote(d.kind, d.updatedAt, (await extractContext(env, d.kind, d.rawText)).trim() || EMPTY_NOTE),
    ),
  );
}

/**
 * Streams the interviewer's reply, then persists the conversation including it.
 * Reads the raw document text, so the interview never waits for context notes.
 */
export async function* interviewTurn(env: Env, db: Db, messages: ChatMessage[]): AsyncGenerator<string> {
  const context = await db.loadRawText(INTERVIEW_DOC_CHARS);
  let reply = "";
  for await (const text of nextTurn(env, context, messages)) {
    reply += text;
    yield text;
  }
  await db.saveInterview([...messages, { role: "assistant", content: reply }]);
}

/** Summarizes the interview while writing any missing context notes. */
export async function finishInterview(env: Env, db: Db, messages: ChatMessage[]): Promise<void> {
  const [summary] = await Promise.all([summarize(env, messages), fillNotes(env, db)]);
  await db.saveInterview(messages, summary);
}

/**
 * Returns the next TOP_N mentors.
 * 0. Write any context notes still missing (normally already done by finishInterview).
 * 1. Reuse unshown mentors already scored for the current context version.
 * 2. If fewer than TOP_N remain, first score people an earlier run found but never
 *    scored (it was interrupted, or found more than MAX_SCORE_PER_RUN), so their
 *    searches aren't paid for twice.
 * 3. If still fewer than TOP_N: search, store new people, score stale/unscored ones.
 * 4. Write blurbs only where missing or written for an older context version.
 * 5. Mark the returned mentors as shown so "Show more" moves on. Only the ones this run
 *    claimed are returned, so a search running in another tab can't return them too.
 * Searching and scoring stop early rather than use up Cloudflare's per-request
 * subrequest limit, so a run always gets to save and return what it found.
 */
export async function findMentors(env: Env, db: Db, emit: (e: MentorsEvent) => Promise<void>): Promise<Mentor[]> {
  await fillNotes(env, db);
  const { context, version } = await db.loadContext();
  let pool = await db.unshownPool(version, TOP_N);

  if (pool.length < TOP_N) {
    const leftover = await db.unscored(MAX_SCORE_PER_RUN);
    if (leftover.length) {
      await scoreAll(env, db, context, version, leftover, emit);
      pool = await db.unshownPool(version, TOP_N);
    }
  }

  if (pool.length < TOP_N) {
    await emit({ type: "progress", stage: "searching", message: "Planning searches…" });
    const queries = await generateQueries(env, context);
    await emit({ type: "queries", queries });
    await emit({ type: "progress", stage: "searching", message: "Searching LinkedIn profiles…" });
    await searchEach(env, db, queries, emit);

    const toScore = await db.toScore(version, MAX_SCORE_PER_RUN);
    if (toScore.length) await scoreAll(env, db, context, version, toScore, emit);
    pool = await db.unshownPool(version, TOP_N);
  }

  if (pool.length) {
    await emit({ type: "selected", mentors: pool.map((m) => ({ ...preview(m), score: m.score })) });
  }

  const stale = pool.filter((m) => !m.blurb || m.blurbVersion !== version);
  if (stale.length) {
    await emit({ type: "progress", stage: "writing", message: "Writing notes on your top matches…" });
    const blurbs = new Map((await writeBlurbs(env, context, stale)).map((b) => [b.slug, b.blurb]));
    const updated = stale.map((m) => ({ ...m, blurb: blurbs.get(m.slug) ?? "" }));
    await db.saveBlurbs(version, updated);
    pool = pool.map((m) => updated.find((u) => u.slug === m.slug) ?? m);
  }

  const claimed = new Set(await db.markShown(pool.map((m) => m.slug)));
  return pool.filter((m) => claimed.has(m.slug)).map(({ blurbVersion, ...mentor }) => mentor);
}

const preview = ({ slug, name, headline }: Candidate) => ({ slug, name, headline });

/**
 * Scores in parallel batches, saving each batch as soon as it's scored so an interrupted
 * run keeps what it finished. A failed batch leaves its people unscored for the next
 * run to pick up; throws only if every batch failed for a reason other than the
 * subrequest budget.
 */
async function scoreAll(
  env: Env,
  db: Db,
  context: string,
  version: number,
  candidates: Candidate[],
  emit: (e: MentorsEvent) => Promise<void>,
): Promise<void> {
  await emit({ type: "progress", stage: "scoring", message: `Scoring ${candidates.length} profiles…` });
  await emit({ type: "scoring", candidates: candidates.map(preview) });
  const batches: Candidate[][] = [];
  for (let i = 0; i < candidates.length; i += SCORE_BATCH_SIZE) {
    batches.push(candidates.slice(i, i + SCORE_BATCH_SIZE));
  }
  // LLM calls only; each batch's save is held back from the budget too.
  const llmEnv = withSubrequestLimit(env, subrequestsLeft(env) - RESERVE_AFTER_SCORING - batches.length);
  const results = await Promise.allSettled(
    batches.map(async (b) => {
      const bySlug = new Map((await scoreBatch(llmEnv, context, b)).map((s) => [s.slug, s]));
      const scored = b.map((c) => ({ ...c, score: bySlug.get(c.slug)?.score ?? 0, reason: bySlug.get(c.slug)?.reason ?? "" }));
      await db.saveScores(version, scored);
      await emit({ type: "scored", scores: scored.map(({ slug, score }) => ({ slug, score })) });
    }),
  );
  const failures = results.filter((r) => r.status === "rejected");
  const real = failures.filter((f) => !(f.reason instanceof SubrequestLimitError));
  if (failures.length === results.length && real.length > 0) throw real[0].reason;
  for (const f of failures) console.error(f.reason);
}

/**
 * Runs each query on its own so the page can watch results arrive, emitting a `found`
 * event per query with only the people not seen earlier in this run. Stores each
 * query's people as they arrive, so an interrupted run keeps what it paid for. Like
 * runSearch, one failing query doesn't fail the run; throws only if every query failed.
 * Queries past the subrequest budget fail the same way, and the run goes on with the rest.
 */
async function searchEach(env: Env, db: Db, queries: string[], emit: (e: MentorsEvent) => Promise<void>): Promise<void> {
  const seen = new Set<string>();
  // Brave calls only; each query's insert is held back from the budget too.
  const searchEnv = withSubrequestLimit(env, subrequestsLeft(env) - RESERVE_AFTER_SEARCH - queries.length);
  const failures = await Promise.all(
    queries.map(async (query, index) => {
      let found: Candidate[];
      try {
        found = await runSearch(searchEnv, [query]);
      } catch (err) {
        await emit({ type: "found", index, candidates: [], failed: true });
        return err;
      }
      const fresh = found.filter((c) => !seen.has(c.slug));
      for (const c of fresh) seen.add(c.slug);
      await db.insertCandidates(fresh);
      await emit({ type: "found", index, candidates: fresh.map(preview), failed: false });
      return null;
    }),
  );
  const errors = failures.filter((e) => e !== null);
  const real = errors.filter((e) => !(e instanceof SubrequestLimitError));
  if (queries.length > 0 && errors.length === queries.length && real.length > 0) {
    throw real.find((e) => e instanceof SearchCapacityError) ?? real[0];
  }
}
