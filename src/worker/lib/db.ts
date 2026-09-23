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

const CONTEXT_ORDER: DocumentKind[] = ["resume", "linkedin", "transcript", "interview"];

function client(env: Env, token: string): SupabaseClient {
  return createClient(env.PUBLIC_SUPABASE_URL, env.PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
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
      name: c.name,
      headline: c.headline,
      snippet: c.snippet,
      url: c.url,
    };
  }

  return {
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
        messages,
        updated_at: new Date().toISOString(),
        ...(summary !== undefined && { context: summary }),
      });
      if (error) fail("saveInterview", error);
    },

    /** Adds newly found people; anyone already in the table is left untouched. */
    async insertCandidates(candidates: Candidate[]): Promise<void> {
      if (!candidates.length) return;
      const { error } = await sb
        .from("mentors")
        .upsert(candidates.map(candidateRow), { onConflict: "user_id,linkedin_slug", ignoreDuplicates: true });
      if (error) fail("insertCandidates", error);
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

    async saveScores(version: number, scored: (Candidate & { score: number; reason: string })[]): Promise<void> {
      if (!scored.length) return;
      const { error } = await sb.from("mentors").upsert(
        scored.map((c) => ({ ...candidateRow(c), score: c.score, reason: c.reason, scored_version: version })),
        { onConflict: "user_id,linkedin_slug" },
      );
      if (error) fail("saveScores", error);
    },

    /** Best unshown mentors already scored for this context version. */
    async unshownPool(version: number, limit: number): Promise<PoolMentor[]> {
      const { data, error } = await sb
        .from("mentors")
        .select("*")
        .is("shown_at", null)
        .eq("scored_version", version)
        .order("score", { ascending: false })
        .limit(limit);
      if (error) fail("unshownPool", error);
      return (data as MentorRow[]).map((r) => ({ ...toMentor(r), blurbVersion: r.blurb_version }));
    },

    async saveBlurbs(version: number, mentors: Mentor[]): Promise<void> {
      if (!mentors.length) return;
      const { error } = await sb.from("mentors").upsert(
        mentors.map((m) => ({ ...candidateRow(m), blurb: m.blurb, blurb_version: version })),
        { onConflict: "user_id,linkedin_slug" },
      );
      if (error) fail("saveBlurbs", error);
    },

    async markShown(slugs: string[]): Promise<void> {
      if (!slugs.length) return;
      const { error } = await sb
        .from("mentors")
        .update({ shown_at: new Date().toISOString() })
        .in("linkedin_slug", slugs);
      if (error) fail("markShown", error);
    },
  };
}
