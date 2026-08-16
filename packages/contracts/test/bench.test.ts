import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  admitReference,
  BenchRecipeSchema,
  BenchRequestSnapshotSchema,
  BenchSessionSchema,
  benchSessionSummary,
  benchSourceKey,
  benchTokenFor,
  foldBenchSession,
  formatSeconds,
  frameTaskModes,
  keyframeCapacity,
  keyframePlan,
  multimediaCapacity,
  parseBenchToken,
  recipeFault,
  validateReferences,
  type BenchEventEnvelope,
  type BenchReferenceToken,
  type BenchSession,
  type BenchSessionMeta,
  type ManifestModel,
} from "../src/index.js";

// A minimal manifest row the admission tests can bend one field at a time.
const MODEL: ManifestModel = {
  id: "test-image",
  provider: "fal",
  capability: "image",
  displayName: "Test Image",
  accepts: { referenceImages: 3, startFrame: false, endFrame: false },
  limits: { maxReferenceAudioSec: 60 },
  pricing: { kind: "perImage", microUsdPerImage: 60000 },
};

const META: BenchSessionMeta = {
  schemaVersion: 1,
  id: "sess_01JMMMMMMMMMMMMMMMMMMMMMMM",
  createdAt: "2026-08-16T10:00:00.000Z",
};

const TK = "tk_01JTTTTTTTTTTTTTTTTTTTTTT0";
const TK2 = "tk_01JTTTTTTTTTTTTTTTTTTTTTT1";
const JB = "jb_01JBBBBBBBBBBBBBBBBBBBBBB0";
const AR = "ar_01JAAAAAAAAAAAAAAAAAAAAAA0";

const ref = (token: string, artifactId: string): BenchReferenceToken => ({
  token,
  kind: parseBenchToken(token)!.kind,
  source: { source: "artifact", artifactId: artifactId as never, hash: "sha256:deadbeef" as never },
});

function env(seq: number, event: BenchEventEnvelope["event"]): BenchEventEnvelope {
  return { seq, at: `2026-08-16T10:00:${String(seq).padStart(2, "0")}.000Z`, event };
}

const SNAPSHOT = {
  mode: "image" as const,
  brief: "a rusted tide-clock face",
  references: [],
          keyframes: [],
  provider: "fal",
  model: "test-image",
  params: { kind: "image" as const, count: 1 },
};

describe("bench tokens", () => {
  it("spells kind and number both ways", () => {
    assert.equal(benchTokenFor("image", 3), "Image 3");
    assert.deepEqual(parseBenchToken("Audio 12"), { kind: "audio", n: 12 });
    assert.equal(parseBenchToken("Image 0"), null);
    assert.equal(parseBenchToken("image 1"), null);
  });

  it("one identity per source, whatever carries it", () => {
    assert.equal(
      benchSourceKey({ source: "artifact", artifactId: AR as never, hash: "sha256:aa" as never }),
      `artifact:${AR}`,
    );
  });
});

describe("the fold", () => {
  it("replays a session: reserve, job, completion, keep — and the counters clear the allocations", () => {
    const session = foldBenchSession(META, [
      env(1, { type: "composer-set", mode: "image", provider: "fal", model: "test-image", params: { kind: "image", count: 1 }, brief: "x" }),
      env(2, { type: "reference-added", entry: ref("Image 1", AR) }),
      env(3, { type: "takes-reserved", takes: [{ id: TK as never, n: 1, requestId: "r1", request: SNAPSHOT, createdAt: "2026-08-16T10:00:03.000Z" }] }),
      env(4, { type: "take-job", takeId: TK as never, jobId: JB as never }),
      env(5, { type: "take-status", takeId: TK as never, status: "running" }),
      env(6, {
        type: "take-completed",
        takeId: TK as never,
        media: { file: "take.png", hash: "sha256:beefbeef" as never },
        completedAt: "2026-08-16T10:00:06.000Z",
      }),
      env(7, { type: "take-filed", takeId: TK as never, artifactId: AR as never }),
    ]);
    // The folded record parses under the strict schema, refinements included.
    const parsed = BenchSessionSchema.parse(session);
    assert.equal(parsed.takes.length, 1);
    assert.equal(parsed.takes[0]!.status, "succeeded");
    assert.equal(parsed.takes[0]!.disposition, "filed");
    assert.equal(parsed.takes[0]!.keptArtifactId, AR);
    assert.equal(parsed.nextTake, 2);
    assert.deepEqual(parsed.nextToken, { image: 2 });
    assert.deepEqual(parsed.composer.activeTokens, ["Image 1"]);
    assert.equal(parsed.selectedTakeId, TK);
  });

  it("removing a token deactivates it and restoring brings the same name back", () => {
    const session = foldBenchSession(META, [
      env(1, { type: "reference-added", entry: ref("Image 1", AR) }),
      env(2, { type: "reference-removed", token: "Image 1" }),
      env(3, { type: "reference-added", entry: ref("Image 2", "ar_01JAAAAAAAAAAAAAAAAAAAAAA1") }),
      env(4, { type: "reference-restored", token: "Image 1" }),
    ]);
    // Image 1 came back under its own name; Image 2 was never renumbered.
    assert.deepEqual(session.composer.activeTokens, ["Image 2", "Image 1"]);
    assert.equal(session.nextToken["image"], 3);
    assert.equal(session.tokenRegistry.length, 2);
  });

  it("a reserved take with no job stays 'allocating' — the recovery saga's first window", () => {
    const session = foldBenchSession(META, [
      env(1, { type: "takes-reserved", takes: [{ id: TK as never, n: 1, requestId: "r1", request: SNAPSHOT, createdAt: "2026-08-16T10:00:01.000Z" }] }),
    ]);
    assert.equal(session.takes[0]!.status, "allocating");
  });

  it("count N reserves consecutive numbers and a failure renumbers nothing", () => {
    const session = foldBenchSession(META, [
      env(1, {
        type: "takes-reserved",
        takes: [
          { id: TK as never, n: 1, requestId: "r1/0", request: SNAPSHOT, createdAt: "2026-08-16T10:00:01.000Z" },
          { id: TK2 as never, n: 2, requestId: "r1/1", request: SNAPSHOT, createdAt: "2026-08-16T10:00:01.000Z" },
        ],
      }),
      env(2, { type: "take-status", takeId: TK as never, status: "failed", error: "boom" }),
    ]);
    assert.deepEqual(session.takes.map((t) => t.n), [1, 2]);
    assert.equal(session.takes[0]!.status, "failed");
    assert.equal(session.takes[1]!.n, 2);
    assert.equal(session.nextTake, 3);
  });
});

describe("the session schema's refinements", () => {
  const base = () =>
    foldBenchSession(META, [
      env(1, { type: "takes-reserved", takes: [{ id: TK as never, n: 1, requestId: "r1", request: SNAPSHOT, createdAt: "2026-08-16T10:00:01.000Z" }] }),
    ]);

  it("refuses a duplicate take number", () => {
    const session = base();
    session.takes.push({ ...session.takes[0]!, id: TK2 as never, requestId: "r2" });
    assert.equal(BenchSessionSchema.safeParse(session).success, false);
  });

  it("refuses a counter that does not clear an allocation", () => {
    const session = base();
    session.nextTake = 1;
    assert.equal(BenchSessionSchema.safeParse(session).success, false);
  });

  it("refuses an active token missing from the registry", () => {
    const session = base();
    session.composer.activeTokens = ["Image 9"];
    assert.equal(BenchSessionSchema.safeParse(session).success, false);
  });

  it("refuses a filed take that names no artifact", () => {
    const session = base();
    session.takes[0]!.disposition = "filed";
    assert.equal(BenchSessionSchema.safeParse(session).success, false);
  });
});

describe("multimedia admission (issue 305 §5.2)", () => {
  it("images budget by count and the ceiling is the row's, never a house number", () => {
    const carried = [{ kind: "image" as const }, { kind: "image" as const }, { kind: "image" as const }];
    const refusal = admitReference({ kind: "image" }, carried, MODEL);
    assert.equal(refusal.ok, false);
    if (!refusal.ok) {
      assert.equal(refusal.binding, "images");
      assert.equal(refusal.reason, "3 of 3 images.");
    }
  });

  it("audio budgets by aggregate seconds against the manifest allowance", () => {
    const ok = admitReference({ kind: "audio", durationSec: 12 }, [], MODEL);
    assert.equal(ok.ok, true);
    const over = admitReference({ kind: "audio", durationSec: 55 }, [{ kind: "audio", durationSec: 12 }], MODEL);
    assert.equal(over.ok, false);
    if (!over.ok) {
      assert.equal(over.binding, "audio-seconds");
      assert.equal(over.reason, "0:55 — over the 0:48 left");
    }
  });

  it("no declared allowance is a refusal, not unlimited — and the words are the spec's", () => {
    const video = admitReference({ kind: "video", durationSec: 5 }, [], MODEL);
    assert.equal(video.ok, false);
    if (!video.ok) assert.equal(video.reason, "this model takes no video");
    const noAudio = admitReference(
      { kind: "audio", durationSec: 5 },
      [],
      { ...MODEL, limits: {} },
    );
    assert.equal(noAudio.ok, false);
    if (!noAudio.ok) assert.equal(noAudio.reason, "this model takes no audio");
  });

  it("an unknown duration refuses; zero is what would make it fit", () => {
    for (const durationSec of [undefined, null] as const) {
      const refusal = admitReference({ kind: "audio", durationSec: durationSec as never }, [], MODEL);
      assert.equal(refusal.ok, false);
      if (!refusal.ok) assert.equal(refusal.reason, "duration could not be read");
    }
  });

  it("an unverified model runs at the floor: no references of any kind", () => {
    const floor = multimediaCapacity([], { ...MODEL, unverified: true });
    assert.equal(floor.imageCeiling, 0);
    assert.equal(floor.audioCeilingSec, 0);
  });

  it("validateReferences names the first offender instead of judging some other order", () => {
    const verdict = validateReferences(
      [{ kind: "image" }, { kind: "video", durationSec: 4 }, { kind: "image" }],
      MODEL,
    );
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.index, 1);
      assert.equal(verdict.refusal.binding, "unsupported-kind");
    }
  });

  it("speaks clock words", () => {
    assert.equal(formatSeconds(12), "0:12");
    assert.equal(formatSeconds(60), "1:00");
    assert.equal(formatSeconds(134), "2:14");
  });
});

describe("the summary", () => {
  it("counts running and failed takes without carrying them", () => {
    const session = foldBenchSession(META, [
      env(1, {
        type: "takes-reserved",
        takes: [
          { id: TK as never, n: 1, requestId: "r1/0", request: SNAPSHOT, createdAt: "2026-08-16T10:00:01.000Z" },
          { id: TK2 as never, n: 2, requestId: "r1/1", request: SNAPSHOT, createdAt: "2026-08-16T10:00:01.000Z" },
        ],
      }),
      env(2, { type: "take-status", takeId: TK as never, status: "failed", error: "x" }),
    ]);
    const summary = benchSessionSummary(session);
    assert.equal(summary.takeCount, 2);
    assert.equal(summary.failedCount, 1);
    assert.equal(summary.runningCount, 1); // the sibling still allocating counts as running
  });
});

describe("the Keyframe lane (issue 305 §3)", () => {
  const FRAME_MODEL: ManifestModel = {
    id: "frame-video",
    provider: "fal",
    capability: "video",
    displayName: "Frame Video",
    accepts: { referenceImages: 0, referenceRoles: false, startFrame: false, endFrame: false },
    limits: { maxDurationSec: 10 },
    pricing: { kind: "perSecond", microUsdPerSecond: 100000 },
    modes: {
      generate: { locked: [] },
      "first-frame": { route: "t/image-to-video", locked: ["aspect"] },
      "first-and-last-frame": { route: "t/image-to-video", locked: ["aspect"] },
    },
  };
  const PLAIN_MODEL: ManifestModel = { ...FRAME_MODEL, id: "plain-video", displayName: "Plain Video" };
  delete (PLAIN_MODEL as { modes?: unknown }).modes;

  const entry = (n: number) => ({
    token: `Image ${n}`,
    kind: "image" as const,
    source: { source: "artifact" as const, artifactId: `ar_01J8F3K2QW9VZX4N7M0RTYB6H${n}`, hash: "sha256:deadbeef" },
  });

  it("frame events fold into their own lane, and composer-set cannot clobber it", () => {
    const meta = { schemaVersion: 1 as const, id: "sess_01J8F3K2QW9VZX4N7M0RTYB6HD" as BenchSession["id"], createdAt: "2026-08-16T10:00:00.000Z" };
    const at = "2026-08-16T10:01:00.000Z";
    const session = foldBenchSession(meta, [
      { seq: 1, at, event: { type: "reference-added", entry: entry(1), lane: "keyframe" } },
      { seq: 2, at, event: { type: "composer-set", mode: "video", provider: "fal", model: "frame-video", params: { kind: "video" }, brief: "a tide" } },
      { seq: 3, at, event: { type: "reference-added", entry: entry(2), lane: "keyframe" } },
      { seq: 4, at, event: { type: "reference-removed", token: "Image 1", lane: "keyframe" } },
    ]);
    assert.deepEqual(session.composer.keyframeTokens, ["Image 2"]);
    assert.deepEqual(session.composer.activeTokens, []);
    // Removed from the lane, never from the registry — the name survives for a restore.
    assert.equal(session.tokenRegistry.length, 2);
    const parsed = BenchSessionSchema.parse(session);
    assert.deepEqual(parsed.composer.keyframeTokens, ["Image 2"]);
  });

  it("a lane-less event is the reference lane — every log written before the lane existed", () => {
    const meta = { schemaVersion: 1 as const, id: "sess_01J8F3K2QW9VZX4N7M0RTYB6HD" as BenchSession["id"], createdAt: "2026-08-16T10:00:00.000Z" };
    const session = foldBenchSession(meta, [
      { seq: 1, at: "2026-08-16T10:01:00.000Z", event: { type: "reference-added", entry: entry(1) } },
    ]);
    assert.deepEqual(session.composer.activeTokens, ["Image 1"]);
    assert.deepEqual(session.composer.keyframeTokens, []);
  });

  it("the session refuses a keyframe token the registry does not know, or that is not a picture", () => {
    const meta = { schemaVersion: 1 as const, id: "sess_01J8F3K2QW9VZX4N7M0RTYB6HD" as BenchSession["id"], createdAt: "2026-08-16T10:00:00.000Z" };
    const base = foldBenchSession(meta, []);
    assert.throws(
      () => BenchSessionSchema.parse({ ...base, composer: { ...base.composer, keyframeTokens: ["Image 9"] } }),
      /keyframe token .{0,2}Image 9.{0,2} is not in the registry/,
    );
    const audio = {
      token: "Audio 1",
      kind: "audio" as const,
      source: { source: "artifact" as const, artifactId: "ar_01J8F3K2QW9VZX4N7M0RTYB6HA", hash: "sha256:deadbeef" },
    };
    assert.throws(
      () =>
        BenchSessionSchema.parse({
          ...base,
          tokenRegistry: [audio],
          nextToken: { audio: 2 },
          composer: { ...base.composer, keyframeTokens: ["Audio 1"] },
        }),
      /only an image can ride as a keyframe/,
    );
  });

  it("keyframes ride video, not image — the snapshot itself says so", () => {
    assert.throws(
      () =>
        BenchRequestSnapshotSchema.parse({
          mode: "image",
          brief: "x",
          references: [],
          keyframes: [entry(1)],
          provider: "fal",
          model: "m",
          params: { kind: "image", count: 1 },
        }),
      /keyframes ride video, not image/,
    );
  });

  it("the plan maps count to mode strictly, with worded refusals from the manifest", () => {
    assert.deepEqual(keyframePlan(FRAME_MODEL, 1), { ok: true, mode: "first-frame" });
    assert.deepEqual(keyframePlan(FRAME_MODEL, 2), { ok: true, mode: "first-and-last-frame" });
    const three = keyframePlan(FRAME_MODEL, 3);
    assert.ok(!three.ok && /keyframe sequence route/.test(three.reason));
    const none = keyframePlan(PLAIN_MODEL, 1);
    assert.ok(!none.ok && /has no first frame route/.test(none.reason));
  });

  it("a sequence with no declared ceiling refuses; a declared one admits up to it", () => {
    const sequenced: ManifestModel = {
      ...FRAME_MODEL,
      modes: { ...FRAME_MODEL.modes, "keyframe-sequence": { route: "t/reference-to-video", locked: [], maxFrames: 4 } },
    };
    assert.deepEqual(keyframePlan(sequenced, 3), { ok: true, mode: "keyframe-sequence" });
    const over = keyframePlan(sequenced, 5);
    assert.ok(!over.ok && /at most 4 keyframes/.test(over.reason));
    const undeclared: ManifestModel = {
      ...FRAME_MODEL,
      modes: { ...FRAME_MODEL.modes, "keyframe-sequence": { route: "t/reference-to-video", locked: [] } },
    };
    const refused = keyframePlan(undeclared, 3);
    assert.ok(!refused.ok && /declares no ceiling/.test(refused.reason));
    assert.equal(keyframeCapacity(sequenced), 4);
    assert.equal(keyframeCapacity(FRAME_MODEL), 2);
    assert.equal(keyframeCapacity(PLAIN_MODEL), 0);
    assert.deepEqual(frameTaskModes(FRAME_MODEL), ["first-frame", "first-and-last-frame"]);
    assert.deepEqual(frameTaskModes(PLAIN_MODEL), []);
  });
});

describe("recipes (issue 305 §3)", () => {
  it("a recipe's controls must match its mode, and a fault is stated rather than repaired", () => {
    const bad = BenchRecipeSchema.safeParse({
      id: "rcp_01J8F3K2QW9VZX4N7M0RTYB6HD",
      name: "Tide studies",
      mode: "video",
      provider: "fal",
      model: "m",
      params: { kind: "image", count: 1 },
      createdAt: "2026-08-16T10:00:00.000Z",
    });
    assert.equal(bad.success, false);

    const recipe = BenchRecipeSchema.parse({
      id: "rcp_01J8F3K2QW9VZX4N7M0RTYB6HD",
      name: "Tide studies",
      mode: "image",
      provider: "fal",
      model: "test-image",
      params: { kind: "image", count: 2 },
      createdAt: "2026-08-16T10:00:00.000Z",
    });
    assert.deepEqual(recipeFault(recipe, { models: [MODEL] }, []), { ok: true });
    const gone = recipeFault({ ...recipe, model: "left" }, { models: [MODEL] }, []);
    assert.ok(!gone.ok && /no longer in the manifest/.test(gone.reason));
    const off = recipeFault(recipe, { models: [MODEL] }, ["test-image"]);
    assert.ok(!off.ok && /switched off in Providers/.test(off.reason));
  });
});
