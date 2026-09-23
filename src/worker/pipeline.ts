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

/** Re-uploading identical text is a no-op: no LLM call, no context version bump. */
export async function saveDocument(env: Env, db: Db, body: UploadDocumentBody): Promise<DocumentSummary> {
  if ((await db.getRawText(body.kind)) === body.text) {
    return db.getDocumentSummary(body.kind);
  }
  const context = await extractContext(env, body.kind, body.text);
  return db.upsertDocument({ ...body, rawText: body.text, context });
}

/** Streams the interviewer's reply, then persists the conversation including it. */
export async function* interviewTurn(env: Env, db: Db, messages: ChatMessage[]): AsyncGenerator<string> {
  const { context } = await db.loadContext();
  let reply = "";
  for await (const text of nextTurn(env, context, messages)) {
    reply += text;
    yield text;
  }
  await db.saveInterview([...messages, { role: "assistant", content: reply }]);
}

export async function finishInterview(env: Env, db: Db, messages: ChatMessage[]): Promise<void> {
  const summary = await summarize(env, messages);
  await db.saveInterview(messages, summary);
}

/**
 * Returns the next TOP_N mentors.
 * 1. Reuse unshown mentors already scored for the current context version.
 * 2. If fewer than TOP_N remain: search, store new people, score stale/unscored ones.
 * 3. Write blurbs only where missing or written for an older context version.
 * 4. Mark the returned mentors as shown so "Show more" moves on.
 */
export async function findMentors(env: Env, db: Db, emit: (e: MentorsEvent) => Promise<void>): Promise<Mentor[]> {
  const { context, version } = await db.loadContext();
  let pool = await db.unshownPool(version, TOP_N);

  if (pool.length < TOP_N) {
    await emit({ type: "progress", stage: "searching", message: "Searching LinkedIn profiles…" });
    const queries = await generateQueries(env, context);
    await db.insertCandidates(await runSearch(env, queries));

    const toScore = await db.toScore(version, MAX_SCORE_PER_RUN);
    if (toScore.length) {
      await emit({ type: "progress", stage: "scoring", message: `Scoring ${toScore.length} profiles…` });
      const batches: Candidate[][] = [];
      for (let i = 0; i < toScore.length; i += SCORE_BATCH_SIZE) {
        batches.push(toScore.slice(i, i + SCORE_BATCH_SIZE));
      }
      const scores = (await Promise.all(batches.map((b) => scoreBatch(env, context, b)))).flat();
      const bySlug = new Map(scores.map((s) => [s.slug, s]));
      await db.saveScores(
        version,
        toScore.map((c) => ({ ...c, score: bySlug.get(c.slug)?.score ?? 0, reason: bySlug.get(c.slug)?.reason ?? "" })),
      );
    }
    pool = await db.unshownPool(version, TOP_N);
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
