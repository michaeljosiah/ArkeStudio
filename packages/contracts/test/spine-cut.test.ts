import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveSpineCut } from "../src/spine-cut.js";
import type { ProductionBundle } from "../src/client-state.js";
import type { ProductionSpine } from "../src/spine.js";
import type { Take } from "../src/take.js";
import { TakeSchema } from "../src/take.js";

const AT = "2026-08-13T12:00:00.000Z";

const TK1 = "tk_01J8D0000000000000000000A1";
const TK2 = "tk_01J8D0000000000000000000A2";
const TKP = "tk_01J8D0000000000000000000B1";
const TKS = "tk_01J8D0000000000000000000B2";
const SH1 = "sh_01J8D0000000000000000000C1";
const SH2 = "sh_01J8D0000000000000000000C2";

function take(id: string, over: Partial<Take> = {}): Take {
  return TakeSchema.parse({
    id,
    coversShots: [],
    kind: "clip",
    provider: "test",
    model: "test-model",
    provenance: { canonRevision: 1, sheets: {} },
    cost: { estimatedMicroUsd: 0, actualMicroUsd: 0 },
    dispatchedAt: AT,
    ...over,
  });
}

/**
 * The derivation reads five things off a bundle. Building the whole of one would bury what each
 * test is actually varying, so the fixture supplies exactly those and is cast once, here.
 */
function bundle(over: {
  shots: Array<{ id: string; number: number; title: string }>;
  takes?: Take[];
  selections?: Record<string, { acceptedTakeId?: string | null; trimInSec?: number }>;
  takeMediaInfo?: Record<string, number>;
}): ProductionBundle {
  return {
    meta: { id: "prod-1" },
    scenes: [{ number: 1, shots: over.shots }],
    takes: over.takes ?? [],
    selections: over.selections ?? {},
    takeMediaInfo: Object.fromEntries(
      Object.entries(over.takeMediaInfo ?? {}).map(([id, durationSec]) => [
        id,
        { sourceHash: `sha256:${"0".repeat(64)}`, mediaInfo: { durationSec, hasAudio: true }, probedAt: AT },
      ]),
    ),
  } as unknown as ProductionBundle;
}

function spine(anchors: ProductionSpine["anchors"]): ProductionSpine {
  return { schemaVersion: 1, revision: 1, trackArtifactId: "art_01J8D0000000000000000000E1", markers: [], anchors, updatedAt: AT };
}

const SHOTS = [
  { id: SH1, number: 1, title: "Wide" },
  { id: SH2, number: 2, title: "Close" },
];

describe("deriveSpineCut", () => {
  it("covers the whole track with contiguous segments and nothing else", () => {
    const cut = deriveSpineCut(
      bundle({
        shots: SHOTS,
        takes: [take(TK1, { media: "clip.mp4" })],
        selections: { [SH1]: { acceptedTakeId: TK1 } },
        takeMediaInfo: { [TK1]: 30 },
      }),
      spine({ [SH1]: { startSec: 10, endSec: 20, clipAudio: { mode: "mute" } } }),
      60,
    );
    // The song is the clock: black before the first anchor, black after the last, and the
    // segments meeting exactly so no moment is described twice or not at all.
    assert.deepEqual(
      cut.segments.map((s) => [s.kind, s.startSec, s.endSec]),
      [
        ["black", 0, 10],
        ["clip", 10, 20],
        ["black", 20, 60],
      ],
    );
    assert.equal(cut.segments[0]!.startSec, 0);
    assert.equal(cut.segments.at(-1)!.endSec, 60);
    for (let i = 1; i < cut.segments.length; i += 1) {
      assert.equal(cut.segments[i]!.startSec, cut.segments[i - 1]!.endSec);
    }
    assert.deepEqual([cut.clipSec, cut.blackSec, cut.slateSec], [10, 50, 0]);
  });

  it("takes the window from the anchor, not from the shot's authored duration", () => {
    const cut = deriveSpineCut(
      bundle({
        shots: [{ id: SH1, number: 1, title: "Wide", durationSec: 4 } as never],
        takes: [take(TK1, { media: "clip.mp4" })],
        selections: { [SH1]: { acceptedTakeId: TK1 } },
        takeMediaInfo: { [TK1]: 30 },
      }),
      spine({ [SH1]: { startSec: 0, endSec: 12, clipAudio: { mode: "mute" } } }),
      12,
    );
    const clip = cut.segments.find((s) => s.kind === "clip")!;
    assert.equal(clip.endSec - clip.startSec, 12);
    assert.deepEqual(clip.media, { path: `productions/prod-1/takes/${TK1}/clip.mp4`, inSec: 0, outSec: 12 });
  });

  it("applies trim to the in-point without moving the shot in the song", () => {
    const cut = deriveSpineCut(
      bundle({
        shots: SHOTS,
        takes: [take(TK1, { media: "clip.mp4" })],
        selections: { [SH1]: { acceptedTakeId: TK1, trimInSec: 2 } },
        takeMediaInfo: { [TK1]: 30 },
      }),
      spine({ [SH1]: { startSec: 5, endSec: 11, clipAudio: { mode: "mute" } } }),
      20,
    );
    const clip = cut.segments.find((s) => s.kind === "clip")!;
    assert.equal(clip.startSec, 5);
    assert.deepEqual(clip.media, { path: `productions/prod-1/takes/${TK1}/clip.mp4`, inSec: 2, outSec: 8 });
  });

  it("slates the shortfall when a take is shorter than its window", () => {
    const cut = deriveSpineCut(
      bundle({
        shots: SHOTS,
        takes: [take(TK1, { media: "clip.mp4" })],
        selections: { [SH1]: { acceptedTakeId: TK1 } },
        takeMediaInfo: { [TK1]: 4 },
      }),
      spine({ [SH1]: { startSec: 0, endSec: 10, clipAudio: { mode: "mute" } } }),
      10,
    );
    assert.deepEqual(
      cut.segments.map((s) => [s.kind, s.startSec, s.endSec]),
      [
        ["clip", 0, 4],
        ["slate", 4, 10],
      ],
    );
    assert.match(cut.segments[1]!.label, /SHORT/);
    assert.equal(cut.problems.filter((p) => p.kind === "short").length, 1);
  });

  it("slates an anchored shot with no accepted take rather than dropping its window", () => {
    const cut = deriveSpineCut(bundle({ shots: SHOTS }), spine({ [SH1]: { startSec: 0, endSec: 8, clipAudio: { mode: "mute" } } }), 8);
    assert.deepEqual(cut.segments.map((s) => s.kind), ["slate"]);
    assert.equal(cut.slateSec, 8);
    assert.equal(cut.problems.find((p) => p.kind === "no-take")?.shotId, SH1);
  });

  it("treats a cleared selection the same as no selection at all", () => {
    // acceptedTakeId is nullable: a row survives the take being cleared, and a null read as an
    // id is a lookup on nothing that silently produces no clip and no diagnostic.
    const cut = deriveSpineCut(
      bundle({
        shots: SHOTS,
        takes: [take(TK1, { media: "clip.mp4" })],
        selections: { [SH1]: { acceptedTakeId: null, trimInSec: 0 } },
        takeMediaInfo: { [TK1]: 30 },
      }),
      spine({ [SH1]: { startSec: 0, endSec: 7, clipAudio: { mode: "mute" } } }),
      7,
    );
    assert.deepEqual(cut.segments.map((s) => s.kind), ["slate"]);
    assert.equal(cut.problems.find((p) => p.kind === "no-take")?.shotId, SH1);
  });

  it("reports an unmeasured take instead of quietly assuming it covers", () => {
    const cut = deriveSpineCut(
      bundle({
        shots: SHOTS,
        takes: [take(TK1, { media: "clip.mp4" })],
        selections: { [SH1]: { acceptedTakeId: TK1 } },
      }),
      spine({ [SH1]: { startSec: 0, endSec: 9, clipAudio: { mode: "mute" } } }),
      9,
    );
    assert.equal(cut.problems.filter((p) => p.kind === "unmeasured").length, 1);
    // Still laid in for the whole window — the guess is the only watchable one, and it is stated.
    assert.deepEqual(cut.segments.map((s) => [s.kind, s.endSec]), [["clip", 9]]);
  });

  it("uses a segment take's own range, which needs no probe", () => {
    const cut = deriveSpineCut(
      bundle({
        shots: SHOTS,
        takes: [take(TKP, { media: "pass.mp4" }), take(TKS, { segment: { passTakeId: TKP, inSec: 12, outSec: 18 } })],
        selections: { [SH1]: { acceptedTakeId: TKS } },
      }),
      spine({ [SH1]: { startSec: 0, endSec: 6, clipAudio: { mode: "mute" } } }),
      6,
    );
    assert.equal(cut.problems.length, 0);
    assert.deepEqual(cut.segments[0]!.media, { path: `productions/prod-1/takes/${TKP}/pass.mp4`, inSec: 12, outSec: 18 });
  });

  it("truncates at the end of the track and names the anchor that ran past it", () => {
    const cut = deriveSpineCut(
      bundle({
        shots: SHOTS,
        takes: [take(TK1, { media: "clip.mp4" })],
        selections: { [SH1]: { acceptedTakeId: TK1 } },
        takeMediaInfo: { [TK1]: 60 },
      }),
      spine({ [SH1]: { startSec: 5, endSec: 40, clipAudio: { mode: "mute" } } }),
      10,
    );
    assert.equal(cut.segments.at(-1)!.endSec, 10);
    assert.ok(cut.problems.some((p) => p.kind === "out-of-bounds"));
  });

  it("does not let an occluded anchor rewind the timeline", () => {
    // [0,100) then [1,2): the second is entirely inside the first. Emitting it would produce a
    // segment starting before the previous one ended, which is not a timeline.
    const cut = deriveSpineCut(
      bundle({
        shots: SHOTS,
        takes: [take(TK1, { media: "a.mp4" }), take(TK2, { media: "b.mp4" })],
        selections: { [SH1]: { acceptedTakeId: TK1 }, [SH2]: { acceptedTakeId: TK2 } },
        takeMediaInfo: { [TK1]: 100, [TK2]: 100 },
      }),
      spine({
        [SH1]: { startSec: 0, endSec: 100, clipAudio: { mode: "mute" } },
        [SH2]: { startSec: 1, endSec: 2, clipAudio: { mode: "mute" } },
      }),
      100,
    );
    assert.deepEqual(cut.segments.map((s) => [s.kind, s.startSec, s.endSec]), [["clip", 0, 100]]);
    assert.ok(cut.problems.some((p) => p.shotId === SH2 && p.kind === "occluded"));
    assert.ok(cut.problems.some((p) => p.shotId === SH2 && p.kind === "overlaps"));
  });

  it("leaves an orphaned anchor's window black rather than giving it to a deleted shot", () => {
    const cut = deriveSpineCut(bundle({ shots: SHOTS }), spine({ "sh_01J8D0000000000000000000C9": { startSec: 2, endSec: 5, clipAudio: { mode: "mute" } } }), 10);
    assert.deepEqual(cut.segments.map((s) => [s.kind, s.startSec, s.endSec]), [["black", 0, 10]]);
    assert.ok(cut.problems.some((p) => p.kind === "orphaned"));
  });

  it("names shots that are in the production but nowhere in the song", () => {
    const cut = deriveSpineCut(
      bundle({ shots: SHOTS }),
      spine({ [SH1]: { startSec: 0, endSec: 10, clipAudio: { mode: "mute" } } }),
      10,
    );
    assert.deepEqual(cut.unanchoredShotIds, [SH2]);
  });

  it("carries the anchor's clip-audio policy onto the clip", () => {
    const cut = deriveSpineCut(
      bundle({
        shots: SHOTS,
        takes: [take(TK1, { media: "clip.mp4" })],
        selections: { [SH1]: { acceptedTakeId: TK1 } },
        takeMediaInfo: { [TK1]: 30 },
      }),
      spine({ [SH1]: { startSec: 0, endSec: 5, clipAudio: { mode: "keep-diegetic", gainDb: -9 } } }),
      5,
    );
    assert.deepEqual(cut.segments[0]!.clipAudio, { mode: "keep-diegetic", gainDb: -9 });
  });

  it("slates the window when trim consumes the whole take", () => {
    const cut = deriveSpineCut(
      bundle({
        shots: SHOTS,
        takes: [take(TK1, { media: "clip.mp4" })],
        selections: { [SH1]: { acceptedTakeId: TK1, trimInSec: 6 } },
        takeMediaInfo: { [TK1]: 6 },
      }),
      spine({ [SH1]: { startSec: 0, endSec: 5, clipAudio: { mode: "mute" } } }),
      5,
    );
    assert.deepEqual(cut.segments.map((s) => s.kind), ["slate"]);
    assert.ok(cut.problems.some((p) => p.kind === "short"));
  });
});
