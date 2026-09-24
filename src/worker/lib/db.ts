// The only place the app talks to Postgres. Every query runs with the signed-in
// user's own token, so row-level security applies even if a query here is wrong.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  AppState,
  Candidate,
  ChatMessage,
  DocumentKind,
  DocumentSummary,
  Mentor,
  UploadKind,
} from "../../shared/schemas";
import type { Env } from "../env";
import { spendSubrequest } from "./subrequests";

type MentorRow = {
  user_id: string;
  linkedin_slug: string;
  name: string;
  headline: string;
  snippet: string;
  url: string;
  score: number | null;
  reason: string | null;
  scored_version: number | null;
  blurb: string | null;
  blurb_version: number | null;
};

/** A scored, not-yet-shown mentor plus the version its blurb was written for. */
export type PoolMentor = Mentor & { blurbVersion: number | null };

/** Actions with a daily limit (see use_quota in the migrations). */
export type QuotaKind = "search" | "mentors" | "interview" | "finish" | "document";

/** 'ok', or which limit is used up. */
export type QuotaResult = "ok" | "user" | "site";

/** The last search run for this user: its context version, Brave page, and whether it found nobody new. */
export type LastSearch = { version: number | null; page: number; exhausted: boolean };

/** Column size limits (CHECK constraints in the migrations); longer values are cut to fit. */
const MAX_NOTE_CHARS = 30_000;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_SLUG_CHARS = 200;
const FIELD_CHARS = { name: 300, headline: 500, snippet: 1000, reason: 2000, blurb: 4000 };

const CONTEXT_ORDER: DocumentKind[] = ["resume", "linkedin", "transcript", "interview"];

/** Per query, so a stalled connection fails the route instead of hanging it. */
const TIMEOUT_MS = 15_000;

/** Lowest score worth showing; 0 means the person matched nothing in the rubric. */
const MIN_SCORE = 1;

/** Counts toward the request's subrequest budget, with a timeout per query. */
function budgetedFetch(env: Env): typeof fetch {
  return (input, init) => {
    spendSubrequest(env);
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  };
}

function client(env: Env, token: string): SupabaseClient {
  return createClient(env.PUBLIC_SUPABASE_URL, env.PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` }, fetch: budgetedFetch(env) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Verifies a Supabase access token and returns the user id, or null if invalid. */
export async function verifyUser(env: Env, token: string): Promise<string | null> {
  const { data, error } = await client(env, token).auth.getClaims(token);
  if (error || !data) return null;
  return data.claims.sub;
}

export type Db = ReturnType<typeof createDb>;

export function createDb(env: Env, token: string, userId: string) {
  const sb = client(env, token);

  function fail(what: string, error: { message: string } | null): never {
    throw new Error(`db.${what}: ${error?.message ?? "unknown error"}`);
  }

  function toMentor(r: MentorRow): Mentor {
    return {
      slug: r.linkedin_slug,
      name: r.name,
      headline: r.headline,
      snippet: r.snippet,
      url: r.url,
      score: r.score ?? 0,
      reason: r.reason ?? "",
      blurb: r.blurb ?? "",
    };
  }

  function candidateRow(c: Candidate) {
    return {
      user_id: userId,
      linkedin_slug: c.slug,
      name: c.name.slice(0, FIELD_CHARS.name),
      headline: c.headline.slice(0, FIELD_CHARS.headline),
      snippet: c.snippet.slice(0, FIELD_CHARS.snippet),
      url: c.url,
    };
  }

  return {
    /** Counts one use of `kind` unless a limit is already used up. */
    async useQuota(kind: QuotaKind): Promise<QuotaResult> {
      const { data, error } = await sb.rpc("use_quota", { p_kind: kind });
      if (error) fail("useQuota", error);
      return data as QuotaResult;
    },

    async lastSearch(): Promise<LastSearch> {
      const { data, error } = await sb
        .from("profiles")
        .select("search_version, search_page, search_exhausted")
        .maybeSingle();
      if (error) fail("lastSearch", error);
      return {
        version: data?.search_version ?? null,
        page: data?.search_page ?? 0,
        exhausted: data?.search_exhausted ?? false,
      };
    },

    async recordSearch(search: LastSearch & { version: number }): Promise<void> {
      const { error } = await sb.rpc("record_search", {
        p_version: search.version,
        p_page: search.page,
        p_exhausted: search.exhausted,
      });
      if (error) fail("recordSearch", error);
    },

    async getState(): Promise<AppState> {
      const [docs, mentors] = await Promise.all([
        sb.from("documents").select("kind, filename, size_bytes, context, messages, updated_at"),
        sb
          .from("mentors")
          .select("*")
          .not("shown_at", "is", null)
          .order("shown_at", { ascending: true })
          .order("score", { ascending: false }),
      ]);
      if (docs.error) fail("getState", docs.error);
      if (mentors.error) fail("getState", mentors.error);

      const interview = docs.data.find((d) => d.kind === "interview");
      return {
        documents: docs.data
          .filter((d) => d.kind !== "interview")
          .map(
            (d): DocumentSummary => ({
              kind: d.kind as UploadKind,
              filename: d.filename,
              sizeBytes: d.size_bytes,
              updatedAt: d.updated_at,
            }),
          ),
        interview: {
          messages: (interview?.messages as ChatMessage[] | null) ?? [],
          done: Boolean(interview?.context),
        },
        mentors: (mentors.data as MentorRow[]).map(toMentor),
      };
    },

    /** All document context notes joined into one string, plus the current context version. */
    async loadContext(): Promise<{ context: string; version: number }> {
      const [docs, profile] = await Promise.all([
        sb.from("documents").select("kind, filename, context").neq("context", ""),
        sb.from("profiles").select("context_version").maybeSingle(),
      ]);
      if (docs.error) fail("loadContext", docs.error);
      if (profile.error) fail("loadContext", profile.error);

      const context = docs.data
        .sort((a, b) => CONTEXT_ORDER.indexOf(a.kind) - CONTEXT_ORDER.indexOf(b.kind))
        .map((d) => `## ${d.kind.toUpperCase()} (${d.filename})\n${d.context}`)
        .join("\n\n");
      return { context, version: profile.data?.context_version ?? 0 };
    },

    /** Every uploaded document's raw text, joined like loadContext (each capped at `maxChars`). */
    async loadRawText(maxChars: number): Promise<string> {
      const { data, error } = await sb.from("documents").select("kind, filename, raw_text").neq("raw_text", "");
      if (error) fail("loadRawText", error);
      return data
        .sort((a, b) => CONTEXT_ORDER.indexOf(a.kind) - CONTEXT_ORDER.indexOf(b.kind))
        .map((d) => `## ${d.kind.toUpperCase()} (${d.filename})\n${d.raw_text.slice(0, maxChars)}`)
        .join("\n\n");
    },

    /** Uploaded documents that don't have a context note yet. */
    async documentsWithoutNotes(): Promise<{ kind: UploadKind; rawText: string; updatedAt: string }[]> {
      const { data, error } = await sb
        .from("documents")
        .select("kind, raw_text, updated_at")
        .neq("kind", "interview")
        .eq("context", "")
        .neq("raw_text", "");
      if (error) fail("documentsWithoutNotes", error);
      return data.map((d) => ({ kind: d.kind as UploadKind, rawText: d.raw_text, updatedAt: d.updated_at }));
    },

    /** Saves a note unless the document was re-uploaded since `updatedAt` (its note is then stale). */
    async saveNote(kind: UploadKind, updatedAt: string, context: string): Promise<void> {
      const { error } = await sb.from("documents").update({ context: context.slice(0, MAX_NOTE_CHARS) }).eq("kind", kind).eq("updated_at", updatedAt);
      if (error) fail("saveNote", error);
    },

    async getRawText(kind: UploadKind): Promise<string | null> {
      const { data, error } = await sb.from("documents").select("raw_text").eq("kind", kind).maybeSingle();
      if (error) fail("getRawText", error);
      return data?.raw_text ?? null;
    },

    async getDocumentSummary(kind: UploadKind): Promise<DocumentSummary> {
      const { data, error } = await sb
        .from("documents")
        .select("kind, filename, size_bytes, updated_at")
        .eq("kind", kind)
        .single();
      if (error) fail("getDocumentSummary", error);
      return { kind, filename: data.filename, sizeBytes: data.size_bytes, updatedAt: data.updated_at };
    },

    async upsertDocument(doc: {
      kind: UploadKind;
      filename: string;
      sizeBytes: number;
      rawText: string;
      context: string;
    }): Promise<DocumentSummary> {
      const { data, error } = await sb
        .from("documents")
        .upsert({
          user_id: userId,
          kind: doc.kind,
          filename: doc.filename,
          size_bytes: doc.sizeBytes,
          raw_text: doc.rawText,
          context: doc.context,
          updated_at: new Date().toISOString(),
        })
        .select("kind, filename, size_bytes, updated_at")
        .single();
      if (error) fail("upsertDocument", error);
      return { kind: doc.kind, filename: data.filename, sizeBytes: data.size_bytes, updatedAt: data.updated_at };
    },

    /** Saves the transcript. Pass `summary` only when the interview is finished. */
    async saveInterview(messages: ChatMessage[], summary?: string): Promise<void> {
      const { error } = await sb.from("documents").upsert({
        user_id: userId,
        kind: "interview",
        filename: "interview",
        messages: messages.map((m) => ({ ...m, content: m.content.slice(0, MAX_MESSAGE_CHARS) })),
        updated_at: new Date().toISOString(),
        ...(summary !== undefined && { context: summary.slice(0, MAX_NOTE_CHARS) }),
      });
      if (error) fail("saveInterview", error);
    },

    /**
     * Adds newly found people and returns how many were new. Anyone already in the table is
     * left untouched, and people past the per-user cap are skipped by a trigger.
     */
    async insertCandidates(candidates: Candidate[]): Promise<number> {
      if (!candidates.length) return 0;
      const { data, error } = await sb
        .from("mentors")
        .upsert(
          candidates.filter((c) => c.slug.length <= MAX_SLUG_CHARS).map(candidateRow),
          { onConflict: "user_id,linkedin_slug", ignoreDuplicates: true },
        )
        .select("linkedin_slug");
      if (error) fail("insertCandidates", error);
      return data.length;
    },

    /** Unshown people not yet scored against the current context version. */
    async toScore(version: number, limit: number): Promise<Candidate[]> {
      const { data, error } = await sb
        .from("mentors")
        .select("linkedin_slug, name, headline, snippet, url")
        .is("shown_at", null)
        .or(`scored_version.is.null,scored_version.neq.${version}`)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) fail("toScore", error);
      return data.map((r) => ({
        slug: r.linkedin_slug,
        name: r.name,
        headline: r.headline,
        snippet: r.snippet,
        url: r.url,
      }));
    },

    /** Unshown people never scored at all (found by a run that didn't get to them). */
    async unscored(limit: number): Promise<Candidate[]> {
      const { data, error } = await sb
        .from("mentors")
        .select("linkedin_slug, name, headline, snippet, url")
        .is("shown_at", null)
        .is("scored_version", null)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) fail("unscored", error);
      return data.map((r) => ({
        slug: r.linkedin_slug,
        name: r.name,
        headline: r.headline,
        snippet: r.snippet,
        url: r.url,
      }));
    },

    async saveScores(version: number, scored: (Candidate & { score: number; reason: string })[]): Promise<void> {
      if (!scored.length) return;
      const { error } = await sb.from("mentors").upsert(
        scored.map((c) => ({ ...candidateRow(c), score: c.score, reason: c.reason.slice(0, FIELD_CHARS.reason), scored_version: version })),
        { onConflict: "user_id,linkedin_slug" },
      );
      if (error) fail("saveScores", error);
    },

    /** Best unshown mentors already scored for this context version, skipping anyone who matched nothing. */
    async unshownPool(version: number, limit: number): Promise<PoolMentor[]> {
      const { data, error } = await sb
        .from("mentors")
        .select("*")
        .is("shown_at", null)
        .eq("scored_version", version)
        .gte("score", MIN_SCORE)
        .neq("name", "")
        .order("score", { ascending: false })
        .limit(limit);
      if (error) fail("unshownPool", error);
      return (data as MentorRow[]).map((r) => ({ ...toMentor(r), blurbVersion: r.blurb_version }));
    },

    async saveBlurbs(version: number, mentors: Mentor[]): Promise<void> {
      if (!mentors.length) return;
      const { error } = await sb.from("mentors").upsert(
        mentors.map((m) => ({ ...candidateRow(m), blurb: m.blurb.slice(0, FIELD_CHARS.blurb), blurb_version: version })),
        { onConflict: "user_id,linkedin_slug" },
      );
      if (error) fail("saveBlurbs", error);
    },

    /**
     * Marks people as shown and returns the slugs this call claimed. Anyone another tab's
     * search already showed is left out, so two searches at once never return the same person.
     */
    async markShown(slugs: string[]): Promise<string[]> {
      if (!slugs.length) return [];
      const { data, error } = await sb
        .from("mentors")
        .update({ shown_at: new Date().toISOString() })
        .in("linkedin_slug", slugs)
        .is("shown_at", null)
        .select("linkedin_slug");
      if (error) fail("markShown", error);
      return data.map((r) => r.linkedin_slug as string);
    },

    /** Removes an uploaded document. Its context no longer counts, so scores are redone (trigger). */
    async deleteDocument(kind: UploadKind): Promise<void> {
      const { error } = await sb.from("documents").delete().eq("kind", kind);
      if (error) fail("deleteDocument", error);
    },
  };
}
