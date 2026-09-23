// The only place the app talks to a web search API (Brave; $5 free credit per month).
import type { Env } from "../env";

export type SearchResult = { title: string; url: string; snippet: string };

/** Runs one query and returns up to `count` (max 20) normalized results. */
export async function search(env: Env, query: string, count = 20): Promise<SearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(count, 20)));
  const res = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": env.BRAVE_API_KEY },
  });
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
