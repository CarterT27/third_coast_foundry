// The only place the app talks to a web search API (Brave; $5 free credit per month).
import type { Env } from "../env";

export type SearchResult = { title: string; url: string; snippet: string };

// The free plan allows 1 request per second. Callers may fire queries in parallel, so
// every call reserves the next free slot and waits for it.
const MIN_INTERVAL_MS = 1100;
/** Per request; runSearch drops a query that times out and keeps the rest. */
const TIMEOUT_MS = 15_000;
let nextSlot = 0;

/** Runs one query and returns up to `count` (max 20) normalized results. */
export async function search(env: Env, query: string, count = 20): Promise<SearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(count, 20)));
  let res = await throttledFetch(env, url);
  // Another isolate may have used the same second; retry once (each retry is a subrequest).
  if (res.status === 429) res = await throttledFetch(env, url);
  if (!res.ok) throw new Error(`Brave ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    web?: { results?: { title: string; url: string; description?: string }[] };
  };
  return (json.web?.results ?? []).map((r) => ({
    title: stripTags(r.title),
    url: r.url,
    snippet: stripTags(r.description ?? ""),
  }));
}

async function throttledFetch(env: Env, url: URL): Promise<Response> {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL_MS;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
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

/** Brave wraps matched terms in <strong>; strip markup and common entities. */
function stripTags(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
