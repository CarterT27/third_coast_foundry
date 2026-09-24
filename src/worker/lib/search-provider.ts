// The only place the app talks to a web search API (Brave; $5 free credit per month).
import type { Env } from "../env";
import { PublicError } from "./errors";
import { spendSubrequest } from "./subrequests";

export type SearchResult = { title: string; url: string; snippet: string };

// The plan allows 50 requests per second. Callers fire queries in parallel, so every call
// reserves the next slot and waits for it; a small gap keeps bursts from several isolates
// under the limit without slowing a search down.
const MIN_INTERVAL_MS = 200;
/** Per request; runSearch drops a query that times out and keeps the rest. */
const TIMEOUT_MS = 15_000;
let nextSlot = 0;

/** Brave serves at most 10 pages per query (`offset` 0-9). */
export const MAX_PAGE = 9;

/** Brave refused because the monthly quota or spending cap is used up. */
export class SearchCapacityError extends PublicError {
  override name = "SearchCapacityError";
  constructor() {
    super("Search is at capacity this month. Please try again later.");
  }
}

/**
 * Runs one query and returns up to `count` (max 20) normalized results. `page` skips that
 * many pages of `count` results, for more people from a query that already ran.
 */
export async function search(env: Env, query: string, count = 20, page = 0): Promise<SearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(count, 20)));
  if (page > 0) url.searchParams.set("offset", String(Math.min(page, MAX_PAGE)));
  let res = await throttledFetch(env, url);
  // Another isolate may have used the same slot; retry once (each retry is a subrequest).
  if (res.status === 429 && !(await overQuota(res))) res = await throttledFetch(env, url);
  // 402 = payment needed; a 429 that persists at this pace means the monthly quota is gone.
  if (res.status === 402 || res.status === 429) throw new SearchCapacityError();
  if (!res.ok) throw new Error(`Brave ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as {
    web?: { results?: { title: string; url: string; description?: string }[] };
  };
  return (json.web?.results ?? []).map((r) => ({
    title: stripTags(r.title ?? ""),
    url: r.url,
    snippet: stripTags(r.description ?? ""),
  }));
}

/** True when a 429 is the monthly quota (the second X-RateLimit-Remaining value is 0), not the per-second limit. */
async function overQuota(res: Response): Promise<boolean> {
  const remaining = res.headers.get("X-RateLimit-Remaining")?.split(",").map((s) => s.trim());
  if (remaining?.[1] === "0") return true;
  const body = await res.clone().text().catch(() => "");
  return /quota/i.test(body);
}

async function throttledFetch(env: Env, url: URL): Promise<Response> {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL_MS;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  spendSubrequest(env);
  try {
    return await fetch(url, {
      headers: { Accept: "application/json", "X-Subscription-Token": env.BRAVE_API_KEY },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`Brave timed out after ${TIMEOUT_MS / 1000}s`, { cause: err });
    }
    throw err;
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
};

/** Brave wraps matched terms in <strong>; strip markup and decode HTML entities. */
export function stripTags(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
      if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? entity;
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : entity;
    })
    .replace(/\s+/g, " ")
    .trim();
}
