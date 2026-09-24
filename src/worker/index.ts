// Worker entry: auth + routes. Routes stay thin — validate, call pipeline.ts, respond.
// Static assets (the React page) are served by Cloudflare before this runs; only
// /api/* reaches the Worker (see wrangler.jsonc).
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { streamSSE } from "hono/streaming";
import type { z } from "zod";
import { InterviewBody, UploadDocumentBody, UploadKind, type InterviewEvent, type MentorsEvent } from "../shared/schemas";
import type { Env } from "./env";
import { createDb, verifyUser, type Db } from "./lib/db";
import { PublicError } from "./lib/errors";
import { MAX_SUBREQUESTS, withSubrequestLimit } from "./lib/subrequests";
import { deleteDocument, finishInterview, findMentors, interviewTurn, saveDocument } from "./pipeline";

type AppEnv = { Bindings: Env; Variables: { db: Db } };

const auth = createMiddleware<AppEnv>(async (c, next) => {
  // Every fetch this request makes counts toward Cloudflare's per-request subrequest limit.
  c.env = withSubrequestLimit(c.env, MAX_SUBREQUESTS);
  const token = c.req.header("Authorization")?.replace(/^Bearer /, "");
  const userId = token ? await verifyUser(c.env, token) : null;
  if (!token || !userId) return c.json({ error: "Unauthorized" }, 401);
  c.set("db", createDb(c.env, token, userId));
  await next();
});

/** Validates a JSON body against a shared schema; invalid bodies get a 400 with a readable message. */
const validJSON = <T extends z.ZodType>(schema: T) =>
  zValidator("json", schema, (result, c) => {
    if (!result.success) return c.json({ error: result.error.issues.map((i) => i.message).join("; ") }, 400);
  });

const app = new Hono<AppEnv>()
  .basePath("/api")
  .use(auth)
  .get("/state", async (c) => c.json(await c.var.db.getState()))

  .post("/documents", validJSON(UploadDocumentBody), async (c) =>
    c.json(await saveDocument(c.env, c.var.db, c.req.valid("json"))),
  )

  .delete("/documents/:kind", async (c) => {
    const kind = UploadKind.safeParse(c.req.param("kind"));
    if (!kind.success) return c.json({ error: "Unknown document type" }, 400);
    await deleteDocument(c.env, c.var.db, kind.data);
    return c.json({ ok: true });
  })

  .post("/interview", validJSON(InterviewBody), (c) => {
    const { messages } = c.req.valid("json");
    return streamSSE(c, async (stream) => {
      const send = (e: InterviewEvent) => stream.writeSSE({ data: JSON.stringify(e) });
      try {
        for await (const text of interviewTurn(c.env, c.var.db, messages)) await send({ type: "token", text });
        await send({ type: "done" });
      } catch (err) {
        console.error(err);
        await send({ type: "error", message: errorMessage(err, "The interviewer couldn't reply. Please try again.") });
      }
    });
  })

  .post("/interview/finish", validJSON(InterviewBody), async (c) => {
    // Keep going if the user refreshes mid-finish, so the summary and rubric still get saved.
    const finished = finishInterview(c.env, c.var.db, c.req.valid("json").messages);
    c.executionCtx.waitUntil(finished);
    await finished;
    return c.json({ ok: true });
  })

  .post("/mentors", (c) =>
    streamSSE(c, async (stream) => {
      const send = (e: MentorsEvent) => stream.writeSSE({ data: JSON.stringify(e) });
      // Keep going if the user refreshes mid-search, so the queries already paid for still
      // get scored and saved. Writes to a closed stream are dropped by Hono.
      const run = findMentors(c.env, c.var.db, send);
      c.executionCtx.waitUntil(run.catch(() => {}));
      try {
        await send({ type: "done", mentors: await run });
      } catch (err) {
        console.error(err);
        await send({ type: "error", message: errorMessage(err, "Something went wrong while finding mentors. Please try again.") });
      }
    }),
  );

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: errorMessage(err) }, 500);
});

/** Messages written for the user pass through; anything else (provider bodies, db errors) is logged only. */
function errorMessage(err: unknown, fallback = "Something went wrong. Please try again."): string {
  return err instanceof PublicError ? err.message : fallback;
}

export type AppType = typeof app;
export default app;
