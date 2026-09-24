// Tests the locked orchestration in pipeline.ts with services mocked and an in-memory database.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOP_N, type Candidate, type Mentor } from "../src/shared/schemas";
import type { Db, PoolMentor } from "../src/worker/lib/db";
import { finishInterview, findMentors, interviewTurn, saveDocument } from "../src/worker/pipeline";
import { writeBlurbs } from "../src/worker/services/blurbs";
import { extractContext } from "../src/worker/services/documents";
import { nextTurn, summarize } from "../src/worker/services/interview";
import { scoreBatch } from "../src/worker/services/score";
import { generateQueries, runSearch } from "../src/worker/services/search";
import { candidate, collect, env } from "./helpers";

vi.mock("../src/worker/services/search", () => ({ generateQueries: vi.fn(), runSearch: vi.fn() }));
vi.mock("../src/worker/services/score", () => ({ scoreBatch: vi.fn() }));
vi.mock("../src/worker/services/blurbs", () => ({ writeBlurbs: vi.fn() }));
vi.mock("../src/worker/services/documents", () => ({ extractContext: vi.fn() }));
vi.mock("../src/worker/services/interview", () => ({ nextTurn: vi.fn(), summarize: vi.fn() }));

type Row = Candidate & {
  score: number | null;
  reason: string;
  scoredVersion: number | null;
  blurb: string;
  blurbVersion: number | null;
  shown: boolean;
};

function fakeDb(version = 1) {
  const rows = new Map<string, Row>();
  const docs = new Map<string, { rawText: string; context: string; updatedAt: string }>();
  const db = {
    rows,
    version,
    loadContext: async () => ({ context: "CTX", version: db.version }),
    unshownPool: async (v: number, limit: number): Promise<PoolMentor[]> =>
      [...rows.values()]
        .filter((r) => !r.shown && r.scoredVersion === v)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, limit)
        .map((r) => ({ ...r, score: r.score ?? 0 })),
    insertCandidates: async (cs: Candidate[]) => {
      for (const c of cs) {
        if (!rows.has(c.slug)) {
          rows.set(c.slug, { ...c, score: null, reason: "", scoredVersion: null, blurb: "", blurbVersion: null, shown: false });
        }
      }
    },
    toScore: async (v: number, limit: number) =>
      [...rows.values()].filter((r) => !r.shown && r.scoredVersion !== v).slice(0, limit),
    saveScores: async (v: number, scored: (Candidate & { score: number; reason: string })[]) => {
      for (const s of scored) Object.assign(rows.get(s.slug)!, { score: s.score, reason: s.reason, scoredVersion: v });
    },
    saveBlurbs: async (v: number, ms: Mentor[]) => {
      for (const m of ms) Object.assign(rows.get(m.slug)!, { blurb: m.blurb, blurbVersion: v });
    },
    markShown: async (slugs: string[]) => {
      for (const s of slugs) rows.get(s)!.shown = true;
    },
    docs,
    getRawText: async (kind: string) => docs.get(kind)?.rawText ?? null,
    getDocumentSummary: async (kind: string) => ({ kind, filename: "cached.pdf", sizeBytes: 1, updatedAt: "" }),
    upsertDocument: async (d: { kind: string; filename: string; sizeBytes: number; rawText: string; context: string }) => {
      const updatedAt = String(docs.size + 1);
      docs.set(d.kind, { rawText: d.rawText, context: d.context, updatedAt });
      return { kind: d.kind, filename: d.filename, sizeBytes: d.sizeBytes, updatedAt };
    },
    loadRawText: async () => [...docs.values()].map((d) => d.rawText).join("\n\n"),
    documentsWithoutNotes: async () =>
      [...docs.entries()].filter(([, d]) => !d.context).map(([kind, d]) => ({ kind, rawText: d.rawText, updatedAt: d.updatedAt })),
    saveNote: async (kind: string, updatedAt: string, context: string) => {
      const d = docs.get(kind);
      if (d?.updatedAt === updatedAt) d.context = context;
    },
    saveInterview: vi.fn(async () => {}),
  };
  return db;
}

const asDb = (db: ReturnType<typeof fakeDb>) => db as unknown as Db;
const emit = vi.fn(async () => {});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(generateQueries).mockResolvedValue(["q1"]);
  vi.mocked(scoreBatch).mockImplementation(async (_env, _ctx, cs) =>
    cs.map((c) => ({ slug: c.slug, score: Number(c.slug.slice(1)), reason: "r" })),
  );
  vi.mocked(writeBlurbs).mockImplementation(async (_env, _ctx, ms) => ms.map((m) => ({ slug: m.slug, blurb: `blurb ${m.slug}` })));
});

describe("findMentors", () => {
  it("searches, scores in batches, returns the top N with blurbs and marks them shown", async () => {
    const db = fakeDb();
    vi.mocked(runSearch).mockResolvedValue(Array.from({ length: 45 }, (_, i) => candidate(`c${i}`)));

    const mentors = await findMentors(env, asDb(db), emit);

    expect(scoreBatch).toHaveBeenCalledTimes(3); // 45 candidates / 20 per batch
    expect(mentors).toHaveLength(TOP_N);
    expect(mentors[0].slug).toBe("c44");
    expect(mentors.every((m) => m.blurb === `blurb ${m.slug}`)).toBe(true);
    expect(mentors.every((m) => db.rows.get(m.slug)!.shown)).toBe(true);
    expect(mentors[0]).not.toHaveProperty("blurbVersion");
  });

  it("reuses the scored pool for 'show more' without searching again", async () => {
    const db = fakeDb();
    vi.mocked(runSearch).mockResolvedValue(Array.from({ length: 30 }, (_, i) => candidate(`c${i}`)));
    await findMentors(env, asDb(db), emit);
    vi.mocked(generateQueries).mockClear();
    vi.mocked(scoreBatch).mockClear();

    const more = await findMentors(env, asDb(db), emit);

    expect(generateQueries).not.toHaveBeenCalled();
    expect(scoreBatch).not.toHaveBeenCalled();
    expect(more.map((m) => m.slug)).toEqual(Array.from({ length: 10 }, (_, i) => `c${19 - i}`));
  });

  it("only rewrites blurbs that are stale for the current context version", async () => {
    const db = fakeDb();
    vi.mocked(runSearch).mockResolvedValue(Array.from({ length: 12 }, (_, i) => candidate(`c${i}`)));
    await db.insertCandidates(await runSearch(env, []));
    await db.saveScores(1, [...db.rows.values()].map((r) => ({ ...r, score: 50, reason: "" })));
    await db.saveBlurbs(1, [...db.rows.values()].map((r) => ({ ...r, score: 50, blurb: "cached" })));
    vi.mocked(runSearch).mockResolvedValue([]);

    const mentors = await findMentors(env, asDb(db), emit);

    expect(writeBlurbs).not.toHaveBeenCalled();
    expect(mentors.every((m) => m.blurb === "cached")).toBe(true);
  });

  it("rescores unshown candidates after the context version changes", async () => {
    const db = fakeDb();
    vi.mocked(runSearch).mockResolvedValue(Array.from({ length: 25 }, (_, i) => candidate(`c${i}`)));
    await findMentors(env, asDb(db), emit);
    db.version = 2;
    vi.mocked(runSearch).mockResolvedValue([]);
    vi.mocked(scoreBatch).mockClear();

    const mentors = await findMentors(env, asDb(db), emit);

    expect(scoreBatch).toHaveBeenCalled();
    expect(mentors).toHaveLength(TOP_N);
    expect(mentors.every((m) => db.rows.get(m.slug)!.scoredVersion === 2)).toBe(true);
  });
});

describe("saveDocument", () => {
  const body = { kind: "resume" as const, filename: "resume.pdf", sizeBytes: 100, text: "RESUME" };

  it("stores raw text without an LLM call and skips identical re-uploads", async () => {
    const db = fakeDb();

    await saveDocument(env, asDb(db), body);
    const second = await saveDocument(env, asDb(db), body);

    expect(extractContext).not.toHaveBeenCalled();
    expect(db.docs.get("resume")).toMatchObject({ rawText: "RESUME", context: "" });
    expect(second.filename).toBe("cached.pdf");
  });
});

describe("context notes", () => {
  const upload = (db: ReturnType<typeof fakeDb>, kind: "resume" | "transcript", text: string) =>
    saveDocument(env, asDb(db), { kind, filename: `${kind}.pdf`, sizeBytes: 1, text });

  it("gives the interview the raw text, with no note calls", async () => {
    const db = fakeDb();
    await upload(db, "resume", "RAW_RESUME");
    vi.mocked(nextTurn).mockImplementation(async function* () {
      yield "Hi";
    });

    await collect(interviewTurn(env, asDb(db), []));

    expect(vi.mocked(nextTurn).mock.calls[0][1]).toContain("RAW_RESUME");
    expect(extractContext).not.toHaveBeenCalled();
  });

  it("writes every missing note when the interview finishes, and only once", async () => {
    const db = fakeDb();
    await upload(db, "resume", "R");
    await upload(db, "transcript", "T");
    vi.mocked(summarize).mockResolvedValue("summary");
    vi.mocked(extractContext).mockImplementation(async (_env, kind) => `note ${kind}`);

    await finishInterview(env, asDb(db), []);
    vi.mocked(runSearch).mockResolvedValue([]);
    await findMentors(env, asDb(db), emit);

    expect(extractContext).toHaveBeenCalledTimes(2);
    expect(db.docs.get("resume")?.context).toBe("note resume");
    expect(db.docs.get("transcript")?.context).toBe("note transcript");
    expect(db.saveInterview).toHaveBeenCalledWith([], "summary");
  });

  it("drops a note whose document was re-uploaded while it was being written", async () => {
    const db = fakeDb();
    await upload(db, "resume", "OLD");
    vi.mocked(summarize).mockResolvedValue("summary");
    vi.mocked(extractContext).mockImplementation(async () => {
      await upload(db, "resume", "NEW");
      return "note for OLD";
    });

    await finishInterview(env, asDb(db), []);

    expect(db.docs.get("resume")).toMatchObject({ rawText: "NEW", context: "" });
  });
});
