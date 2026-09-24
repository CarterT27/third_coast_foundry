# Rules for AI coding assistants (and humans)

This repo has a fixed architecture. Your job is to implement function bodies and UI
inside it, not to change it. Read README.md for how the pieces fit.

## You may edit
- `src/worker/services/*.ts` — function **bodies** only
- `src/web/components/Upload.tsx`, `Interview.tsx`, `Mentors.tsx` (and new presentational
  components in `src/web/components/`)
- `src/web/styles.css`
- `test/*.test.ts` — remove `.skip` and add cases; don't weaken existing assertions

## You must not
- Change any exported function signature in `src/worker/services/`, or any `Props` type
  in a component.
- Edit `src/shared/`, `src/worker/index.ts`, `src/worker/pipeline.ts`, `src/worker/lib/`,
  `src/web/lib/`, `src/web/App.tsx`, `src/web/components/Step.tsx`, migrations, or any
  config file (`package.json`, `wrangler.jsonc`, `vite.config.ts`, `eslint.config.js`,
  `tsconfig*.json`, `.github/`).
- Add dependencies. Everything needed is installed.
- Disable lint rules or use `any` / `@ts-ignore` to get past an error.
- Add embeddings, vector search, queues, caches, headless browsers, or scraping of linkedin.com.
- Use anything that isn't free tier (NVIDIA API, Brave search, Supabase free, Cloudflare Workers free).
  The one exception is the OpenRouter LLM provider, which is already wired into `src/worker/lib/llm.ts`.

## How to do things
- LLM calls: `chat`, `chatJSON`, `chatStream` from `src/worker/lib/llm.ts` (NVIDIA or OpenRouter, picked by `LLM_PROVIDER`). Never call `fetch`.
- Web search: `search` from `src/worker/lib/search-provider.ts`.
- Page → API: functions in `src/web/lib/api.ts`. Never call `fetch` from components.
- Database: services never touch it; `pipeline.ts` does.
- UI without keys: set `PUBLIC_USE_FIXTURES=true` in `.env`.

## If the contract seems wrong
Stop and tell the user to ask the tech lead (@CarterT27). Do not work around it.

## Before finishing
Run `npm run check` (typecheck + lint + tests). It must pass.
