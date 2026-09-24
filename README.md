# Third Coast Foundry

Upload your resume, transcript and LinkedIn profile, answer a short interview about
what you're looking for, and get the 10 people most worth a coffee chat — each with a
note on why.

Everything runs on free tiers: Cloudflare Workers, Supabase, the NVIDIA API, and Brave
Search.

## Setup

```bash
npm install
cp .env.example .env   # fill in values (see below)
npm run dev            # page + API on http://localhost:5173
```

- **Supabase:** create a project, enable **Authentication → Anonymous sign-ins**, then
  `supabase link --project-ref <ref>` and `supabase db push`. Copy the project URL and
  publishable key into `.env`.
- **NVIDIA:** API key from [build.nvidia.com](https://build.nvidia.com). `NVIDIA_MODEL` can
  be any chat model from the catalog that supports `response_format` JSON schemas
  (default `nvidia/nemotron-3.5-lightning-30b-a3b`). Thinking is turned off in every
  request (`chat_template_kwargs.enable_thinking: false`) so reasoning models reply
  directly instead of writing their reasoning into the answer.
- **Search:** Brave Search API key ($5 free credit/month ≈ 1,000 queries).
- **No keys yet?** Set `PUBLIC_USE_FIXTURES=true` to build the UI with fake data.

All config lives in `.env`. Only `PUBLIC_*` values reach the browser. Don't create a
`.dev.vars` file — Wrangler would read it instead of `.env`.

**Deploy:** automatic. Every push to `main` that passes CI runs `npm run deploy` in GitHub
Actions, using the production `.env` stored in the `ENV_FILE` repo secret (plus
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`). To deploy by hand: `npx wrangler login`
once, then `npm run deploy`. Either way it builds the page with the `PUBLIC_*` values from
`.env` and uploads every `.env` value as a Worker secret in the same step. After changing
`.env`, update `ENV_FILE` too (`gh secret set ENV_FILE < .env`). Removing a key from `.env` doesn't delete it from Cloudflare; use
`npx wrangler secret delete <NAME>` for that.

## How it works

```
Browser                                   Worker (/api/*)                     Services
───────                                   ───────────────                     ────────
pdf.js extracts text ──POST /documents──▶ same text as before? skip ──────▶ extractContext
chat UI ─────────────POST /interview────▶ stream reply, save messages ────▶ nextTurn
"Finish" ─────POST /interview/finish────▶ save summary as a document ─────▶ summarize
"Find mentors" ─────────POST /mentors───▶ pipeline.findMentors:
                                           1. reuse unshown mentors scored for this context
                                           2. else: queries → search → store ─▶ generateQueries, runSearch
                                              score new/stale in batches of 20 ▶ scoreBatch
                                           3. write missing/stale blurbs ────▶ writeBlurbs
                                           4. mark the 10 as shown
```

- **Context, not structured data.** Each document (and the finished interview) is stored
  as its raw text plus an LLM-written plaintext note. Later steps read the notes, so
  prompts can change without migrations.
- **`context_version`.** A database trigger bumps it whenever a note changes. Scores and
  blurbs remember the version they were made for, so only stale ones are recomputed.
  "Show 10 more" usually costs zero LLM calls.
- **Security.** Visitors get an anonymous Supabase account. The Worker queries Postgres
  with the user's own token, so row-level security applies to every query.

## Layout

```
src/shared/     contract: zod schemas + types for every request/response/event, SSE parser
src/worker/     Hono API
  index.ts        routes (thin)          pipeline.ts   orchestration (services + db)
  lib/            the only code that talks to NVIDIA, search APIs, Postgres
  services/       pure logic — LLM/search in, data out (no db, no HTTP)
src/web/        React single page
  App.tsx         derives the active step from server state
  components/     Step (layout), MentorCard, Upload, Interview, Mentors
  lib/            api.ts (only way to call the API), supabase.ts, pdf.ts, fixtures.ts
test/           one spec per service (+ pipeline and SSE)
supabase/       migrations
```

Lint rules enforce the boundaries (e.g. services can't import the database or call
`fetch`; components can't call `fetch`). See `AGENTS.md` for the full rules.

## Ownership

| Who | Files | Notes |
|---|---|---|
| Ania | `components/Upload.tsx`, `components/Mentors.tsx`, `services/documents.ts` | UI against ready-made API functions; fixtures mode for the results UI |
| Tigo | `services/search.ts`, `services/blurbs.ts` | start with `buildXray` / `parseResult` (pure functions, tests ready) |
| Carter | `components/Interview.tsx`, `services/interview.ts`, `services/score.ts`, plus the architecture files (the "must not edit" list in `AGENTS.md`) | streaming both ends, cross-batch score calibration; contracts, infra |

## Workflow

Everyone pushes straight to `main`.

1. `git pull` before you start.
2. Remove `.skip` from the tests for what you're implementing; make them pass.
3. Run `npm run check` (typecheck + lint + tests) before every push.
4. Push. CI runs the same checks on every push; if it goes red, fix it right away since
   everyone is working off `main`.
5. Changes to architecture files (the "must not edit" list in `AGENTS.md`): tell Carter first.
