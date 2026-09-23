// Worker entry: auth + routes. Routes stay thin — validate, call pipeline.ts, respond.
// Static assets (the React page) are served by Cloudflare before this runs; only
// /api/* reaches the Worker (see wrangler.jsonc).
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { streamSSE } from "hono/streaming";
import type { z } from "zod";
import { InterviewBody, UploadDocumentBody, type InterviewEvent, type MentorsEvent } from "../shared/schemas";
import type { Env } from "./env";
import { createDb, verifyUser, type Db } from "./lib/db";
import { finishInterview, findMentors, interviewTurn, saveDocument } from "./pipeline";

type AppEnv = { Bindings: Env; Variables: { db: Db } };

const auth = createMiddleware<AppEnv>(async (c, next) => {
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

  .post("/interview", validJSON(InterviewBody), (c) => {
    const { messages } = c.req.valid("json");
    return streamSSE(c, async (stream) => {
      const send = (e: InterviewEvent) => stream.writeSSE({ data: JSON.stringify(e) });
      try {
        for await (const text of interviewTurn(c.env, c.var.db, messages)) await send({ type: "token", text });
        await send({ type: "done" });
      } catch (err) {
        console.error(err);
        await send({ type: "error", message: errorMessage(err) });
      }
    });
  })

  .post("/interview/finish", validJSON(InterviewBody), async (c) => {
    await finishInterview(c.env, c.var.db, c.req.valid("json").messages);
    return c.json({ ok: true });
  })

  .post("/mentors", (c) =>
    streamSSE(c, async (stream) => {
      const send = (e: MentorsEvent) => stream.writeSSE({ data: JSON.stringify(e) });
      try {
        await send({ type: "done", mentors: await findMentors(c.env, c.var.db, send) });
      } catch (err) {
        console.error(err);
        await send({ type: "error", message: errorMessage(err) });
      }
    }),
  );

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: errorMessage(err) }, 500);
});

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

export type AppType = typeof app;
export default app;
