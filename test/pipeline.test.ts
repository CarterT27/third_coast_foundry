// Tests the locked orchestration in pipeline.ts with services mocked and an in-memory database.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOP_N, type Candidate, type Mentor, type MentorsEvent } from "../src/shared/schemas";
import type { Db, PoolMentor } from "../src/worker/lib/db";
import { SearchCapacityError } from "../src/worker/lib/search-provider";
import { SubrequestLimitError, subrequestsLeft, withSubrequestLimit } from "../src/worker/lib/subrequests";
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
    unscored: async (limit: number) => [...rows.values()].filter((r) => !r.shown && r.scoredVersion === null).slice(0, limit),
    saveScores: async (v: number, scored: (Candidate & { score: number; reason: string })[]) => {
      for (const s of scored) Object.assign(rows.get(s.slug)!, { score: s.score, reason: s.reason, scoredVersion: v });
    },
    saveBlurbs: async (v: number, ms: Mentor[]) => {
      for (const m of ms) Object.assign(rows.get(m.slug)!, { blurb: m.blurb, blurbVersion: v });
    },
    markShown: async (slugs: string[]) => {
      const claimed = slugs.filter((s) => !rows.get(s)!.shown);
      for (const s of claimed) rows.get(s)!.shown = true;
      return claimed;
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

describe("findMentors failures", () => {
  it("keeps the batches that scored when one fails, and scores the rest next run without searching", async () => {
    const db = fakeDb();
    vi.mocked(runSearch).mockResolvedValue(Array.from({ length: 25 }, (_, i) => candidate(`c${i}`)));
    const scoreOk = vi.mocked(scoreBatch).getMockImplementation()!;
    vi.mocked(scoreBatch).mockImplementationOnce(async () => {
      throw new Error("LLM down");
    });

    await expect(findMentors(env, asDb(db), emit)).resolves.toHaveLength(5);
    const unscored = [...db.rows.values()].filter((r) => r.scoredVersion === null);
    expect(unscored).toHaveLength(20);

    vi.mocked(scoreBatch).mockImplementation(scoreOk);
    vi.mocked(generateQueries).mockClear();
    await expect(findMentors(env, asDb(db), emit)).resolves.toHaveLength(TOP_N);
    expect(generateQueries).not.toHaveBeenCalled();
    expect([...db.rows.values()].every((r) => r.scoredVersion === 1)).toBe(true);
  });

  it("throws if every batch fails, but keeps the people found for the retry", async () => {
    const db = fakeDb();
    vi.mocked(runSearch).mockResolvedValue(Array.from({ length: 25 }, (_, i) => candidate(`c${i}`)));
    const scoreOk = vi.mocked(scoreBatch).getMockImplementation()!;
    vi.mocked(scoreBatch).mockRejectedValue(new Error("LLM down"));

    await expect(findMentors(env, asDb(db), emit)).rejects.toThrow("LLM down");
    expect(db.rows.size).toBe(25);

    vi.mocked(scoreBatch).mockImplementation(scoreOk);
    vi.mocked(generateQueries).mockClear();
    vi.mocked(runSearch).mockClear();
    await expect(findMentors(env, asDb(db), emit)).resolves.toHaveLength(TOP_N);
    expect(runSearch).not.toHaveBeenCalled();
  });

  it("saves each batch's scores as soon as it's scored", async () => {
    const db = fakeDb();
    vi.mocked(runSearch).mockResolvedValue(Array.from({ length: 25 }, (_, i) => candidate(`c${i}`)));
    let release!: () => void;
    const stuck = new Promise<void>((resolve) => (release = resolve));
    const scoreOk = vi.mocked(scoreBatch).getMockImplementation()!;
    vi.mocked(scoreBatch).mockImplementation(async (e, ctx, cs) => {
      if (cs.length < 20) await stuck;
      return scoreOk(e, ctx, cs);
    });

    const run = findMentors(env, asDb(db), emit);
    await vi.waitFor(() => expect([...db.rows.values()].filter((r) => r.scoredVersion === 1)).toHaveLength(20));
    release();
    await run;
  });
});

describe("findMentors events", () => {
  const types = () => (emit.mock.calls as unknown as [MentorsEvent][]).map(([e]) => e.type);
  const events = <T extends MentorsEvent["type"]>(type: T) =>
    (emit.mock.calls as unknown as [MentorsEvent][]).map(([e]) => e).filter((e): e is Extract<MentorsEvent, { type: T }> => e.type === type);

  it("emits queries, one found per query with only new people, scoring, scored per batch, then selected", async () => {
    const db = fakeDb();
    vi.mocked(generateQueries).mockResolvedValue(["q1", "q2"]);
    vi.mocked(runSearch).mockImplementation(async (_env, [q]) =>
      q === "q1" ? Array.from({ length: 25 }, (_, i) => candidate(`c${i}`)) : [candidate("c0"), candidate("c99")],
    );

    await findMentors(env, asDb(db), emit);

    expect(events("queries")).toEqual([{ type: "queries", queries: ["q1", "q2"] }]);
    const found = events("found").sort((a, b) => a.index - b.index);
    expect(found.map((f) => f.candidates.length)).toEqual([25, 1]);
    expect(found[1].candidates[0]).toEqual({ slug: "c99", name: "Person c99", headline: "Product Manager at Stripe" });
    expect(events("scoring")[0].candidates).toHaveLength(26);
    expect(events("scored")).toHaveLength(2); // 26 candidates / 20 per batch
    const [selected] = events("selected");
    expect(selected.mentors).toHaveLength(TOP_N);
    expect(selected.mentors[0]).toMatchObject({ slug: "c99", score: 99 });
    expect(types().indexOf("selected")).toBeLessThan(types().lastIndexOf("progress"));
  });

  it("marks a failed query and keeps going; throws only if every query fails", async () => {
    const db = fakeDb();
    vi.mocked(generateQueries).mockResolvedValue(["bad", "good"]);
    vi.mocked(runSearch).mockImplementation(async (_env, [q]) => {
      if (q === "bad") throw new Error("Brave 500");
      return Array.from({ length: 12 }, (_, i) => candidate(`c${i}`));
    });

    await expect(findMentors(env, asDb(db), emit)).resolves.toHaveLength(TOP_N);
    expect(events("found").find((f) => f.index === 0)).toMatchObject({ failed: true, candidates: [] });

    vi.mocked(runSearch).mockRejectedValue(new Error("Brave 500"));
    await expect(findMentors(env, asDb(fakeDb()), emit)).rejects.toThrow("Brave 500");
  });

  it("reports a friendly message when every query hits the Brave cap", async () => {
    vi.mocked(generateQueries).mockResolvedValue(["q1", "q2"]);
    vi.mocked(runSearch).mockImplementation(async (_env, [q]) => {
      throw q === "q1" ? new Error("Brave 500") : new SearchCapacityError();
    });
    await expect(findMentors(env, asDb(fakeDb()), emit)).rejects.toThrow("Search is at capacity this month");
  });

  it("goes on without queries that ran past the subrequest budget", async () => {
    vi.mocked(generateQueries).mockResolvedValue(["q1", "q2"]);
    vi.mocked(runSearch).mockRejectedValue(new SubrequestLimitError("out"));
    await expect(findMentors(env, asDb(fakeDb()), emit)).resolves.toEqual([]);
    expect(events("found").every((f) => f.failed)).toBe(true);
  });

  it("holds back part of the budget for scoring and saving while searching", async () => {
    const left: number[] = [];
    vi.mocked(runSearch).mockImplementation(async (e) => {
      left.push(subrequestsLeft(e));
      return [];
    });
    await findMentors(withSubrequestLimit(env, 50), asDb(fakeDb()), emit);
    expect(left[0]).toBeGreaterThan(0);
    expect(left[0]).toBeLessThan(35);
  });

  it("returns only the mentors this run claimed when another tab showed them first", async () => {
    const db = fakeDb();
    vi.mocked(runSearch).mockResolvedValue(Array.from({ length: 12 }, (_, i) => candidate(`c${i + 1}`)));
    const markShown = db.markShown;
    db.markShown = async (slugs: string[]) => {
      await markShown(slugs.slice(0, 4)); // the other tab got these
      return markShown(slugs);
    };
    const mentors = await findMentors(env, asDb(db), emit);
    expect(mentors).toHaveLength(TOP_N - 4);
  });

  it("emits only selected for 'show more' from the scored pool", async () => {
    const db = fakeDb();
    vi.mocked(runSearch).mockResolvedValue(Array.from({ length: 30 }, (_, i) => candidate(`c${i}`)));
    await findMentors(env, asDb(db), emit);
    emit.mockClear();

    await findMentors(env, asDb(db), emit);

    expect(types()).not.toContain("queries");
    expect(types()).not.toContain("scoring");
    expect(events("selected")[0].mentors.map((m) => m.slug)).toEqual(Array.from({ length: 10 }, (_, i) => `c${19 - i}`));
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

  it("saves a placeholder for an empty note so it isn't regenerated on every search", async () => {
    const db = fakeDb();
    await upload(db, "resume", "R");
    vi.mocked(extractContext).mockResolvedValue("  ");
    vi.mocked(runSearch).mockResolvedValue([]);

    await findMentors(env, asDb(db), emit);
    await findMentors(env, asDb(db), emit);

    expect(extractContext).toHaveBeenCalledTimes(1);
    expect(db.docs.get("resume")?.context).not.toBe("");
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
