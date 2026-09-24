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
} from "../shared/schemas";
import type { Env } from "./env";
import type { Db } from "./lib/db";
import { writeBlurbs } from "./services/blurbs";
import { extractContext } from "./services/documents";
import { nextTurn, summarize } from "./services/interview";
import { scoreBatch } from "./services/score";
import { generateQueries, runSearch } from "./services/search";

/** Per-document cap on raw text sent with every interview turn. */
const INTERVIEW_DOC_CHARS = 20_000;

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

/** Writes context notes for documents that don't have one yet, in parallel. */
async function fillNotes(env: Env, db: Db): Promise<void> {
  const missing = await db.documentsWithoutNotes();
  await Promise.all(
    missing.map(async (d) => db.saveNote(d.kind, d.updatedAt, await extractContext(env, d.kind, d.rawText))),
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
 * 2. If fewer than TOP_N remain: search, store new people, score stale/unscored ones.
 * 3. Write blurbs only where missing or written for an older context version.
 * 4. Mark the returned mentors as shown so "Show more" moves on.
 */
export async function findMentors(env: Env, db: Db, emit: (e: MentorsEvent) => Promise<void>): Promise<Mentor[]> {
  await fillNotes(env, db);
  const { context, version } = await db.loadContext();
  let pool = await db.unshownPool(version, TOP_N);

  if (pool.length < TOP_N) {
    await emit({ type: "progress", stage: "searching", message: "Planning searches…" });
    const queries = await generateQueries(env, context);
    await emit({ type: "queries", queries });
    await emit({ type: "progress", stage: "searching", message: "Searching LinkedIn profiles…" });
    await db.insertCandidates(await searchEach(env, queries, emit));

    const toScore = await db.toScore(version, MAX_SCORE_PER_RUN);
    if (toScore.length) {
      await emit({ type: "progress", stage: "scoring", message: `Scoring ${toScore.length} profiles…` });
      await emit({ type: "scoring", candidates: toScore.map(preview) });
      const batches: Candidate[][] = [];
      for (let i = 0; i < toScore.length; i += SCORE_BATCH_SIZE) {
        batches.push(toScore.slice(i, i + SCORE_BATCH_SIZE));
      }
      const scores = (
        await Promise.all(
          batches.map(async (b) => {
            const batch = await scoreBatch(env, context, b);
            await emit({ type: "scored", scores: batch.map(({ slug, score }) => ({ slug, score })) });
            return batch;
          }),
        )
      ).flat();
      const bySlug = new Map(scores.map((s) => [s.slug, s]));
      await db.saveScores(
        version,
        toScore.map((c) => ({ ...c, score: bySlug.get(c.slug)?.score ?? 0, reason: bySlug.get(c.slug)?.reason ?? "" })),
      );
    }
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

  await db.markShown(pool.map((m) => m.slug));
  return pool.map(({ blurbVersion, ...mentor }) => mentor);
}

const preview = ({ slug, name, headline }: Candidate) => ({ slug, name, headline });

/**
 * Runs each query on its own so the page can watch results arrive, emitting a `found`
 * event per query with only the people not seen earlier in this run. Like runSearch,
 * one failing query doesn't fail the run; throws only if every query failed.
 */
async function searchEach(env: Env, queries: string[], emit: (e: MentorsEvent) => Promise<void>): Promise<Candidate[]> {
  const bySlug = new Map<string, Candidate>();
  const failures = await Promise.all(
    queries.map(async (query, index) => {
      let found: Candidate[];
      try {
        found = await runSearch(env, [query]);
      } catch (err) {
        await emit({ type: "found", index, candidates: [], failed: true });
        return err;
      }
      const fresh = found.filter((c) => !bySlug.has(c.slug));
      for (const c of fresh) bySlug.set(c.slug, c);
      await emit({ type: "found", index, candidates: fresh.map(preview), failed: false });
      return null;
    }),
  );
  const errors = failures.filter((e) => e !== null);
  if (queries.length > 0 && errors.length === queries.length) throw errors[0];
  return [...bySlug.values()];
}
