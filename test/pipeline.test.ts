// Tests the locked orchestration in pipeline.ts with services mocked and an in-memory database.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOP_N, type Candidate, type Mentor } from "../src/shared/schemas";
import type { Db, PoolMentor } from "../src/worker/lib/db";
import { findMentors, saveDocument } from "../src/worker/pipeline";
import { writeBlurbs } from "../src/worker/services/blurbs";
import { extractContext } from "../src/worker/services/documents";
import { scoreBatch } from "../src/worker/services/score";
import { generateQueries, runSearch } from "../src/worker/services/search";
import { candidate, env } from "./helpers";

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
  const docs = new Map<string, string>();
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
    getRawText: async (kind: string) => docs.get(kind) ?? null,
    getDocumentSummary: async (kind: string) => ({ kind, filename: "cached.pdf", sizeBytes: 1, updatedAt: "" }),
    upsertDocument: async (d: { kind: string; filename: string; sizeBytes: number; rawText: string }) => {
      docs.set(d.kind, d.rawText);
      return { kind: d.kind, filename: d.filename, sizeBytes: d.sizeBytes, updatedAt: "" };
    },
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

  it("extracts context for new text and skips identical re-uploads", async () => {
    const db = fakeDb();
    vi.mocked(extractContext).mockResolvedValue("note");

    await saveDocument(env, asDb(db), body);
    const second = await saveDocument(env, asDb(db), body);

    expect(extractContext).toHaveBeenCalledTimes(1);
    expect(second.filename).toBe("cached.pdf");
  });
});
