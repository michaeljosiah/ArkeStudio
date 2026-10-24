import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { arkePlayerPartChapters, arkePlayerReleaseState, chapterBlocksRead, withUnplannedChapters, type ArkePlayerRelease } from "../src/index.js";

// Releasing a production a chapter at a time (design turn 236, SPEC-058 R-43, R-44).
const A = "a".repeat(64);
const B = "b".repeat(64);
const chapter = (id: string, order: number) => ({ id, order, title: `Chapter ${order}` });
const listed = (exportedAt: string, release: ArkePlayerRelease, productionId = "ledger") => ({ productionId, exportedAt, release });

describe("where a production's releases stand (R-43)", () => {
  it("has none until an edition is made", () => {
    assert.equal(arkePlayerReleaseState([], "ledger"), null);
    // A part with no edition before it in this list follows nothing here.
    assert.equal(arkePlayerReleaseState([listed("2026-10-30T09:00:00Z", { edition: "2026-10-30", fingerprint: B, chapters: [chapter("c24", 24)], part: { follows: "2026-10-22", fingerprint: A, number: 1 } })], "ledger"), null);
  });

  it("follows the newest edition through its parts, in number order", () => {
    const edition = listed("2026-10-22T09:00:00Z", { edition: "2026-10-22", fingerprint: A, chapters: [chapter("c1", 1), chapter("c23", 23)] });
    const first = listed("2026-10-30T09:00:00Z", { edition: "2026-10-30", fingerprint: B, chapters: [chapter("c24", 24)], part: { follows: "2026-10-22", fingerprint: A, number: 1, schedule: { day: "friday" } } });
    const second = listed("2026-11-06T09:00:00Z", { edition: "2026-11-06", fingerprint: B, chapters: [chapter("c25", 25)], part: { follows: "2026-10-22", fingerprint: A, number: 2 } });
    const other = listed("2026-11-07T09:00:00Z", { edition: "2026-11-07", fingerprint: A, chapters: [chapter("x", 1)] }, "another");
    const state = arkePlayerReleaseState([second, other, edition, first], "ledger")!;
    assert.deepEqual(state.edition, { label: "2026-10-22", fingerprint: A, exportedAt: "2026-10-22T09:00:00Z" });
    assert.deepEqual(state.last, { kind: "part", exportedAt: "2026-11-06T09:00:00Z", number: 2, chapter: { order: 25, title: "Chapter 25" } });
    assert.deepEqual([...state.released].sort(), ["c1", "c23", "c24", "c25"]);
    assert.equal(state.lastOrder, 25);
    assert.equal(state.nextNumber, 3);
    // The newest schedule the author gave carries on until they change it.
    assert.deepEqual(state.schedule, { day: "friday" });
  });

  it("starts again from a new edition, which gathers the parts before it (R-55)", () => {
    const old = listed("2026-10-22T09:00:00Z", { edition: "2026-10-22", fingerprint: A, chapters: [chapter("c23", 23)] });
    const part = listed("2026-10-30T09:00:00Z", { edition: "2026-10-30", fingerprint: B, chapters: [chapter("c24", 24)], part: { follows: "2026-10-22", fingerprint: A, number: 1 } });
    const gathered = listed("2026-11-01T09:00:00Z", { edition: "2026-11-01", fingerprint: B, chapters: [chapter("c23", 23), chapter("c24", 24)] });
    const state = arkePlayerReleaseState([old, part, gathered], "ledger")!;
    assert.equal(state.edition.label, "2026-11-01");
    assert.deepEqual(state.last.kind, "edition");
    assert.equal(state.nextNumber, 1);
  });
});

describe("the chapters a part may hold (R-44)", () => {
  const plan = [
    { chapterId: "c23", order: 23, state: "read" as const },
    { chapterId: "c24", order: 24, state: "read" as const },
    { chapterId: "c25", order: 25, state: "part" as const },
    { chapterId: "c26", order: 26, state: "read" as const },
  ];

  it("runs on from the last release to the first not read whole, never skipping one", () => {
    const { ready, waiting } = arkePlayerPartChapters(plan, { released: new Set(["c23"]), lastOrder: 23 });
    assert.deepEqual(ready.map((entry) => entry.chapterId), ["c24"]);
    assert.deepEqual(waiting.map((entry) => entry.chapterId), ["c25", "c26"]);
  });

  it("never runs past a chapter the plan leaves out, an outlined one (codex on PR 2173)", () => {
    const chapter = (chapterId: string, order: number) => ({ chapterId, order, title: chapterId, state: "read" as const, seconds: 60, blocks: [], gaps: [], pictures: [], opening: null });
    const all = withUnplannedChapters([chapter("c1", 1), chapter("c3", 3)], [{ id: "c1", order: 1, title: "One" }, { id: "c2", order: 2, title: "Two" }, { id: "c3", order: 3, title: "Three" }, { id: "gone", order: 4, title: "Gone", retired: true }]);
    assert.deepEqual(all.map((entry) => [entry.chapterId, entry.state]), [["c1", "read"], ["c2", "not read"], ["c3", "read"]]);
    const { ready, waiting } = arkePlayerPartChapters(all, { released: new Set(["c1"]), lastOrder: 1 });
    assert.deepEqual(ready, []);
    assert.deepEqual(waiting.map((entry) => entry.chapterId), ["c2", "c3"]);
  });

  it("keeps a schedule the author cleared, rather than an older one (codex on PR 2173)", () => {
    const edition = listed("2026-10-22T09:00:00Z", { edition: "2026-10-22", fingerprint: A, chapters: [chapter("c1", 1)] });
    const first = listed("2026-10-30T09:00:00Z", { edition: "2026-10-30", fingerprint: B, chapters: [chapter("c2", 2)], part: { follows: "2026-10-22", fingerprint: A, number: 1, schedule: { day: "friday" } } });
    const cleared = listed("2026-11-06T09:00:00Z", { edition: "2026-11-06", fingerprint: B, chapters: [chapter("c3", 3)], part: { follows: "2026-10-22", fingerprint: A, number: 2, schedule: {} } });
    assert.deepEqual(arkePlayerReleaseState([edition, first, cleared], "ledger")!.schedule, {});
  });

  it("says how far a chapter read in part has got", () => {
    assert.deepEqual(chapterBlocksRead({ blocks: Array.from({ length: 6 }) as never, gaps: [{ at: 0, from: 7, to: 31 }] }), { read: 6, of: 31 });
  });
});
