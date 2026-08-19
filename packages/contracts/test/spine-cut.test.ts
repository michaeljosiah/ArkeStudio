import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveSpineCut, trimCeilingSec } from "../src/spine-cut.js";
import type { ProductionBundle } from "../src/client-state.js";
import type { ProductionSpine } from "../src/spine.js";
import type { Take } from "../src/take.js";
import { TakeSchema } from "../src/take.js";

const AT = "2026-08-13T12:00:00.000Z";

const TK1 = "tk_01J8D0000000000000000000A1";
const TK2 = "tk_01J8D0000000000000000000A2";
const TKP = "tk_01J8D0000000000000000000B1";
const TKS = "tk_01J8D0000000000000000000B2";
const SH1 = "sh_1";
const SH2 = "sh_2";

/** Takes cover the shot they were generated for; a take covering nothing is not a real arrival. */
function take(id: string, over: Partial<Take> = {}): Take {
  return TakeSchema.parse({
    id,
    coversShots: [SH1],
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

describe("trimCeilingSec", () => {
  it("is the measured duration when the file has been probed", () => {
    const b = bundle({ shots: SHOTS, takes: [take(TK1, { media: "clip.mp4" })], takeMediaInfo: { [TK1]: 30 } });
    assert.deepEqual(trimCeilingSec(b, SH1, TK1), { ok: true, ceilingSec: 30 });
  });

  it("is undefined when nothing bounds the material — absent is not measured, never measured zero", () => {
    // Refusing every trim on an unprobed file would disable the control on a machine without
    // ffmpeg, which SPEC-013 R-5a keeps as a supported way to run.
    const b = bundle({ shots: SHOTS, takes: [take(TK1, { media: "clip.mp4" })] });
    assert.deepEqual(trimCeilingSec(b, SH1, TK1), { ok: true, ceilingSec: undefined });
  });

  it("a planned segment boundary bounds an unmeasured file", () => {
    const b = bundle({
      shots: SHOTS,
      takes: [
        take(TKP, { media: "pass.mp4", coversShots: [SH1, SH2] }),
        take(TKS, { segment: { passTakeId: TKP, inSec: 6, outSec: 12 } }),
      ],
    });
    assert.deepEqual(trimCeilingSec(b, SH1, TKS), { ok: true, ceilingSec: 6 });
  });

  it("the tighter of measurement and boundary wins", () => {
    // The provider returned 9s against a plan that plays this segment from 6s: 3s survive.
    const b = bundle({
      shots: SHOTS,
      takes: [
        take(TKP, { media: "pass.mp4", coversShots: [SH1, SH2] }),
        take(TKS, { segment: { passTakeId: TKP, inSec: 6, outSec: 12 } }),
      ],
      takeMediaInfo: { [TKP]: 9 },
    });
    assert.deepEqual(trimCeilingSec(b, SH1, TKS), { ok: true, ceilingSec: 3 });
  });

  it("refuses whatever the cut refuses, with the same reason", () => {
    const backing = bundle({ shots: SHOTS, takes: [take(TKP, { media: "pass.mp4", coversShots: [SH1, SH2] })] });
    assert.deepEqual(trimCeilingSec(backing, SH1, TKP), { ok: false, reason: "backing-pass" });

    const other = bundle({ shots: SHOTS, takes: [take(TK1, { media: "clip.mp4", coversShots: [SH2] })] });
    assert.deepEqual(trimCeilingSec(other, SH1, TK1), { ok: false, reason: "other-shot" });

    const still = bundle({ shots: SHOTS, takes: [take(TK1, { media: "frame.png", kind: "frame" })] });
    assert.deepEqual(trimCeilingSec(still, SH1, TK1), { ok: false, reason: "static" });

    const empty = bundle({ shots: SHOTS, takes: [take(TK1)] });
    assert.deepEqual(trimCeilingSec(empty, SH1, TK1), { ok: false, reason: "no-media" });

    const missing = bundle({ shots: SHOTS, takes: [] });
    assert.deepEqual(trimCeilingSec(missing, SH1, TK2), { ok: false, reason: "no-media" });
  });
});

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

  it("uses a segment's range against the measured pass", () => {
    const cut = deriveSpineCut(
      bundle({
        shots: SHOTS,
        takes: [take(TKP, { media: "pass.mp4" }), take(TKS, { segment: { passTakeId: TKP, inSec: 12, outSec: 18 } })],
        selections: { [SH1]: { acceptedTakeId: TKS } },
        takeMediaInfo: { [TKP]: 30 },
      }),
      spine({ [SH1]: { startSec: 0, endSec: 6, clipAudio: { mode: "mute" } } }),
      6,
    );
    assert.equal(cut.problems.length, 0);
    assert.deepEqual(cut.segments[0]!.media, { path: `productions/prod-1/takes/${TKP}/pass.mp4`, inSec: 12, outSec: 18 });
  });

  it("does not trust a segment's planned range past the end of the pass it came from", () => {
    // The range is authored before dispatch (R-4). A provider that returned a shorter pass leaves
    // an outSec pointing past the end of the file, and the arithmetic all agrees.
    const cut = deriveSpineCut(
      bundle({
        shots: SHOTS,
        takes: [take(TKP, { media: "pass.mp4" }), take(TKS, { segment: { passTakeId: TKP, inSec: 12, outSec: 18 } })],
        selections: { [SH1]: { acceptedTakeId: TKS } },
        takeMediaInfo: { [TKP]: 15 },
      }),
      spine({ [SH1]: { startSec: 0, endSec: 6, clipAudio: { mode: "mute" } } }),
      6,
    );
    assert.deepEqual(cut.segments[0]!.media, { path: `productions/prod-1/takes/${TKP}/pass.mp4`, inSec: 12, outSec: 15 });
    assert.deepEqual(cut.segments.map((s) => [s.kind, s.startSec, s.endSec]), [["clip", 0, 3], ["slate", 3, 6]]);
    assert.ok(cut.problems.some((p) => p.kind === "short"));
  });

  it("reports an unprobed pass rather than reading its length off the plan", () => {
    const cut = deriveSpineCut(
      bundle({
        shots: SHOTS,
        takes: [take(TKP, { media: "pass.mp4" }), take(TKS, { segment: { passTakeId: TKP, inSec: 12, outSec: 18 } })],
        selections: { [SH1]: { acceptedTakeId: TKS } },
      }),
      spine({ [SH1]: { startSec: 0, endSec: 6, clipAudio: { mode: "mute" } } }),
      6,
    );
    assert.ok(cut.problems.some((p) => p.kind === "unmeasured"));
  });

  it("advances the source in-point when an earlier anchor covered the head", () => {
    // [0,5) then [3,8): the second shot starts at master time 5, so its first two seconds were
    // covered. Playing from its first frame would show content the anchor did not ask for.
    const cut = deriveSpineCut(
      bundle({
        shots: SHOTS,
        takes: [take(TK1, { media: "a.mp4" }), take(TK2, { media: "b.mp4", coversShots: [SH2] })],
        selections: { [SH1]: { acceptedTakeId: TK1 }, [SH2]: { acceptedTakeId: TK2 } },
        takeMediaInfo: { [TK1]: 30, [TK2]: 30 },
      }),
      spine({
        [SH1]: { startSec: 0, endSec: 5, clipAudio: { mode: "mute" } },
        [SH2]: { startSec: 3, endSec: 8, clipAudio: { mode: "mute" } },
      }),
      8,
    );
    const second = cut.segments[1]!;
    assert.deepEqual([second.startSec, second.endSec], [5, 8]);
    assert.deepEqual(second.media, { path: `productions/prod-1/takes/${TK2}/b.mp4`, inSec: 2, outSec: 5 });
  });

  it("holds an orphaned anchor's window black instead of handing it to a later shot", () => {
    // An orphan at [2,8) and a live shot at [5,10): reporting the orphan while letting the next
    // shot move into its window reallocates time nobody agreed to give up.
    const cut = deriveSpineCut(
      bundle({
        shots: SHOTS,
        takes: [take(TK1, { media: "a.mp4" })],
        selections: { [SH1]: { acceptedTakeId: TK1 } },
        takeMediaInfo: { [TK1]: 30 },
      }),
      spine({
        "sh_9": { startSec: 2, endSec: 8, clipAudio: { mode: "mute" } },
        [SH1]: { startSec: 5, endSec: 10, clipAudio: { mode: "mute" } },
      }),
      10,
    );
    assert.deepEqual(cut.segments.map((s) => [s.kind, s.startSec, s.endSec]), [["black", 0, 8], ["clip", 8, 10]]);
    assert.ok(cut.problems.some((p) => p.kind === "orphaned"));
  });

  it("keeps an unprobed segment inside its planned boundary", () => {
    // The measurement is missing; the boundary is not. [12,18) with a 2s trim in a 6s window must
    // read [14,18) and slate the rest, never [14,20) — which is two seconds of the next shot.
    const cut = deriveSpineCut(
      bundle({
        shots: SHOTS,
        takes: [take(TKP, { media: "pass.mp4" }), take(TKS, { segment: { passTakeId: TKP, inSec: 12, outSec: 18 } })],
        selections: { [SH1]: { acceptedTakeId: TKS, trimInSec: 2 } },
      }),
      spine({ [SH1]: { startSec: 0, endSec: 6, clipAudio: { mode: "mute" } } }),
      6,
    );
    assert.deepEqual(cut.segments[0]!.media, { path: `productions/prod-1/takes/${TKP}/pass.mp4`, inSec: 14, outSec: 18 });
    assert.deepEqual(cut.segments.map((s) => [s.kind, s.startSec, s.endSec]), [["clip", 0, 4], ["slate", 4, 6]]);
    assert.ok(cut.problems.some((p) => p.kind === "unmeasured"));
  });

  it("slates rather than emitting a zero-length clip when the boundary leaves nothing", () => {
    const cut = deriveSpineCut(
      bundle({
        shots: SHOTS,
        takes: [take(TKP, { media: "pass.mp4" }), take(TKS, { segment: { passTakeId: TKP, inSec: 12, outSec: 18 } })],
        selections: { [SH1]: { acceptedTakeId: TKS, trimInSec: 6 } },
      }),
      spine({ [SH1]: { startSec: 0, endSec: 6, clipAudio: { mode: "mute" } } }),
      6,
    );
    assert.deepEqual(cut.segments.map((s) => s.kind), ["slate"]);
    assert.ok(cut.problems.some((p) => p.kind === "short"));
  });

  it("keeps the timeline gapless when a take falls a hair short of its window", () => {
    const cut = deriveSpineCut(
      bundle({
        shots: SHOTS,
        takes: [take(TK1, { media: "clip.mp4" })],
        selections: { [SH1]: { acceptedTakeId: TK1 } },
        takeMediaInfo: { [TK1]: 9.9999995 },
      }),
      spine({ [SH1]: { startSec: 0, endSec: 10, clipAudio: { mode: "mute" } } }),
      10,
    );
    // Emitted at its true size rather than rounded up: the timeline stays exactly contiguous and
    // every clip's master duration still equals the source window it reads.
    assert.equal(cut.segments[0]!.startSec, 0);
    assert.equal(cut.segments.at(-1)!.endSec, 10);
    for (let i = 1; i < cut.segments.length; i += 1) assert.equal(cut.segments[i]!.startSec, cut.segments[i - 1]!.endSec);
    // Too small to be worth telling anyone about.
    assert.equal(cut.problems.filter((p) => p.kind === "short").length, 0);
  });

  it("keeps every clip's master duration equal to the source window it reads", () => {
    // The invariant three separate epsilon convenience fixes broke, asserted directly.
    for (const [trackSec, anchors] of [
      [10, { [SH1]: { startSec: 0.0000005, endSec: 10 } }],
      [10, { [SH1]: { startSec: 0, endSec: 9.9999995 } }],
      [6.0000005, { [SH1]: { startSec: 0, endSec: 6.0000005 } }],
    ] as const) {
      const cut = deriveSpineCut(
        bundle({
          shots: SHOTS,
          takes: [take(TKP, { media: "pass.mp4" }), take(TKS, { segment: { passTakeId: TKP, inSec: 12, outSec: 18 } })],
          selections: { [SH1]: { acceptedTakeId: TKS } },
          takeMediaInfo: { [TKP]: 30 },
        }),
        spine(Object.fromEntries(Object.entries(anchors).map(([k, v]) => [k, { ...v, clipAudio: { mode: "mute" as const } }]))),
        trackSec,
      );
      for (const seg of cut.segments) {
        if (seg.kind !== "clip") continue;
        assert.equal(Number((seg.media!.outSec - seg.media!.inSec).toFixed(9)), Number((seg.endSec - seg.startSec).toFixed(9)));
        assert.ok(seg.media!.inSec >= 12, `inSec ${seg.media!.inSec} went before the segment start`);
        assert.ok(seg.media!.outSec <= 18, `outSec ${seg.media!.outSec} crossed the segment boundary`);
      }
      assert.equal(cut.segments[0]!.startSec, 0);
      assert.equal(cut.segments.at(-1)!.endSec, trackSec);
    }
  });

  it("refuses a take accepted for a different shot", () => {
    // acceptTake checks that the take exists, not that it belongs to the shot.
    const cut = deriveSpineCut(
      bundle({
        shots: SHOTS,
        takes: [take(TK1, { media: "clip.mp4", coversShots: [SH2] })],
        selections: { [SH1]: { acceptedTakeId: TK1 } },
        takeMediaInfo: { [TK1]: 30 },
      }),
      spine({ [SH1]: { startSec: 0, endSec: 6, clipAudio: { mode: "mute" } } }),
      6,
    );
    assert.deepEqual(cut.segments.map((s) => s.kind), ["slate"]);
    assert.match(cut.problems.find((p) => p.kind === "no-take")!.detail, /does not cover this shot/);
  });

  it("will not use a voice take as picture just because it has a file", () => {
    // A voice arrival covers its shot and the Generate workspace offers the same Accept action
    // for it. Counting it as covered puts an audio path where a picture renderer expects frames.
    const cut = deriveSpineCut(
      bundle({
        shots: SHOTS,
        takes: [take(TK1, { kind: "voice", media: "line.wav" })],
        selections: { [SH1]: { acceptedTakeId: TK1 } },
        takeMediaInfo: { [TK1]: 30 },
      }),
      spine({ [SH1]: { startSec: 0, endSec: 6, clipAudio: { mode: "mute" } } }),
      6,
    );
    assert.deepEqual(cut.segments.map((s) => s.kind), ["slate"]);
    assert.equal(cut.problems.find((p) => p.kind === "no-take")?.shotId, SH1);
  });

  it("will not freeze a single image into a moving-picture window", () => {
    // Image jobs produce `frame` takes and the contact sheet offers Accept for them. A still has
    // no duration, so laying it in as a clip invents an outSec and asks for a freeze nobody chose.
    const cut = deriveSpineCut(
      bundle({
        shots: SHOTS,
        takes: [take(TK1, { kind: "frame", media: "still.png" })],
        selections: { [SH1]: { acceptedTakeId: TK1 } },
      }),
      spine({ [SH1]: { startSec: 0, endSec: 6, clipAudio: { mode: "mute" } } }),
      6,
    );
    assert.deepEqual(cut.segments.map((s) => s.kind), ["slate"]);
    assert.match(cut.problems.find((p) => p.kind === "no-take")!.detail, /single image/);
  });

  it("refuses a whole-scene pass as one shot's material", () => {
    // The primary pass take covers every shot in the scene and has no range of its own. Read from
    // zero it puts the top of the scene into whichever shot accepted it — wrong picture, clean export.
    const cut = deriveSpineCut(
      bundle({
        shots: SHOTS,
        takes: [take(TKP, { media: "pass.mp4", coversShots: [SH1, SH2] })],
        selections: { [SH2]: { acceptedTakeId: TKP } },
        takeMediaInfo: { [TKP]: 60 },
      }),
      spine({ [SH2]: { startSec: 0, endSec: 6, clipAudio: { mode: "mute" } } }),
      6,
    );
    assert.deepEqual(cut.segments.map((s) => s.kind), ["slate"]);
    assert.match(cut.problems.find((p) => p.kind === "no-take")!.detail, /whole-scene pass/);
  });

  it("stays gapless when the first anchor starts a hair past zero", () => {
    const cut = deriveSpineCut(
      bundle({
        shots: SHOTS,
        takes: [take(TK1, { media: "clip.mp4" })],
        selections: { [SH1]: { acceptedTakeId: TK1 } },
        takeMediaInfo: { [TK1]: 30 },
      }),
      spine({ [SH1]: { startSec: 0.0000005, endSec: 10, clipAudio: { mode: "mute" } } }),
      10,
    );
    assert.equal(cut.segments[0]!.startSec, 0);
    assert.equal(cut.segments.at(-1)!.endSec, 10);
  });

  it("stays gapless when the last anchor ends a hair before the track does", () => {
    const cut = deriveSpineCut(
      bundle({
        shots: SHOTS,
        takes: [take(TK1, { media: "clip.mp4" })],
        selections: { [SH1]: { acceptedTakeId: TK1 } },
        takeMediaInfo: { [TK1]: 30 },
      }),
      spine({ [SH1]: { startSec: 0, endSec: 9.9999995, clipAudio: { mode: "mute" } } }),
      10,
    );
    assert.equal(cut.segments.at(-1)!.endSec, 10);
    for (let i = 1; i < cut.segments.length; i += 1) assert.equal(cut.segments[i]!.startSec, cut.segments[i - 1]!.endSec);
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
        takes: [take(TK1, { media: "a.mp4" }), take(TK2, { media: "b.mp4", coversShots: [SH2] })],
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
    const cut = deriveSpineCut(bundle({ shots: SHOTS }), spine({ "sh_9": { startSec: 2, endSec: 5, clipAudio: { mode: "mute" } } }), 10);
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
