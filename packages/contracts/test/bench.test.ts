import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  admitReference,
  AppSettingsSchema,
  BenchPresetSchema,
  BenchRequestSnapshotSchema,
  MUSIC_DURATION_SEC,
  BenchSessionSchema,
  benchSessionSummary,
  BenchReferenceSourceSchema,
  benchSourceKey,
  benchTokenFor,
  foldBenchSession,
  formatSeconds,
  frameTaskModes,
  keyframeAddable,
  keyframeCapacity,
  keyframePlan,
  multimediaCapacity,
  parseBenchToken,
  presetFault,
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

describe("a world file as a reference source", () => {
  /**
   * The world holds far more pictures than the artifacts folder — everything under a character:
   * accepted identity, looks, candidates awaiting review, and every take generated for them.
   * The source union was artifact|take, so none of them could be picked at all (2026-08-18).
   */
  const source = (path: string) => ({
    source: "world-file" as const,
    path,
    hash: ("sha256:" + "a".repeat(16)) as never,
  });

  it("accepts a world-relative path", () => {
    const parsed = BenchReferenceSourceSchema.safeParse(
      source("references/aurora-sabato/candidates/candidate-1.png"),
    );
    assert.equal(parsed.success, true);
  });

  it("refuses a path that could reach outside the world", () => {
    // A path arriving from a client is not permission to read the disk. The coordinator confines
    // it besides; this is the gate that stops a malformed one ever reaching that code.
    for (const bad of [
      "../../.ssh/id_rsa",
      "references/../../secrets.txt",
      "/etc/passwd",
      "C:/Windows/System32/config/SAM",
      // Built from the character code so no escaping can quietly turn it into a harmless
      // filename — the first version of this line did exactly that and passed for the wrong reason.
      ["references", "..", "escape.png"].join(String.fromCharCode(92)),
      "..",
    ]) {
      assert.equal(BenchReferenceSourceSchema.safeParse(source(bad)).success, false, bad);
    }
  });

  it("keys on the path, so the same picture re-picked keeps its token", () => {
    // "Image 2" must mean the same bytes for the session's whole life.
    const key = benchSourceKey(source("references/aurora-sabato/candidates/candidate-1.png") as never);
    assert.equal(key, "file:references/aurora-sabato/candidates/candidate-1.png");
    assert.notEqual(key, benchSourceKey(source("references/aurora-sabato/candidates/candidate-2.png") as never));
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

  /**
   * A spent start frame retires with its take (reported 2026-08-17, from the app).
   *
   * Nothing used to retire one, so a frame used by take 2 was still in the lane for take 3 —
   * invisible unless the Keyframe tab happened to be open. Adding a reference for the next shot
   * then met "References and keyframes cannot ride one request yet", a refusal naming frames the
   * user could not see and had not chosen.
   */
  it("retires the start frame the completed take actually used", () => {
    const framed = { ...SNAPSHOT, mode: "video" as const, keyframes: [ref("Image 1", AR)] };
    const session = foldBenchSession(META, [
      env(1, { type: "reference-added", entry: ref("Image 1", AR), lane: "keyframe" }),
      env(2, { type: "reference-added", entry: ref("Image 2", "ar_01JAAAAAAAAAAAAAAAAAAAAAA1") }),
      env(3, { type: "takes-reserved", takes: [{ id: TK as never, n: 1, requestId: "r1", request: framed, createdAt: "2026-08-16T10:00:03.000Z" }] }),
      env(4, {
        type: "take-completed",
        takeId: TK as never,
        media: { file: "clip.mp4", hash: "sha256:beefbeef" as never },
        completedAt: "2026-08-16T10:00:06.000Z",
      }),
    ]);
    assert.deepEqual(session.composer.keyframeTokens, [], "the frame it was made with is spent");
    // The reference lane is a working set and is left alone — that is what the next request wants.
    assert.deepEqual(session.composer.activeTokens, ["Image 2"]);
    // And the take keeps its own copy, so a re-run replays the frames it was made with.
    assert.deepEqual(session.takes[0]!.request.keyframes.map((k) => k.token), ["Image 1"]);
  });

  it("keeps a frame staged for the next take, and one whose take has not landed", () => {
    const framed = { ...SNAPSHOT, mode: "video" as const, keyframes: [ref("Image 1", AR)] };
    const staged = (events: BenchEventEnvelope[]) => foldBenchSession(META, events).composer.keyframeTokens;

    // Image 2 was staged while take 1 was in flight: a live choice, not a spent one.
    assert.deepEqual(
      staged([
        env(1, { type: "reference-added", entry: ref("Image 1", AR), lane: "keyframe" }),
        env(2, { type: "takes-reserved", takes: [{ id: TK as never, n: 1, requestId: "r1", request: framed, createdAt: "2026-08-16T10:00:02.000Z" }] }),
        env(3, { type: "reference-added", entry: ref("Image 2", "ar_01JAAAAAAAAAAAAAAAAAAAAAA1"), lane: "keyframe" }),
        env(4, { type: "take-completed", takeId: TK as never, media: { file: "clip.mp4", hash: "sha256:beefbeef" as never }, completedAt: "2026-08-16T10:00:06.000Z" }),
      ]),
      ["Image 2"],
    );

    // A take that failed keeps its frame: there is something to retry with.
    assert.deepEqual(
      staged([
        env(1, { type: "reference-added", entry: ref("Image 1", AR), lane: "keyframe" }),
        env(2, { type: "takes-reserved", takes: [{ id: TK as never, n: 1, requestId: "r1", request: framed, createdAt: "2026-08-16T10:00:02.000Z" }] }),
        env(3, { type: "take-status", takeId: TK as never, status: "failed", error: "the provider refused" }),
      ]),
      ["Image 1"],
    );
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

  it("keyframes ride video, and nothing else — the snapshot itself says so", () => {
    // Once a third mode exists the refusal cannot name only the other one: a spoken take has
    // no frames either, and the message has to hold for both.
    for (const [mode, params] of [
      ["image", { kind: "image", count: 1 }],
      ["voice", { kind: "voice", count: 1 }],
    ] as const) {
      assert.throws(
        () =>
          BenchRequestSnapshotSchema.parse({
            mode,
            brief: "x",
            references: [],
            keyframes: [entry(1)],
            provider: "fal",
            model: "m",
            params,
          }),
        /keyframes ride video, and nothing else/,
        `${mode} refuses keyframes`,
      );
    }
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

describe("presets (issue 305 §3)", () => {
  it("a settings file written before the rename keeps its setups, and everything else", () => {
    // The object is strict, so an untouched legacy key would throw — and AppSettingsFile
    // catches that and hands back defaults, which would cost the user their routing, spend
    // and appearance choices as a side effect of renaming a menu.
    const legacy = {
      routing: { image: "test-image" },
      spend: { thresholdMicroUsd: 5000, periodDays: 30 },
      recipes: [
        {
          id: "rcp_01J8F3K2QW9VZX4N7M0RTYB6HD",
          name: "Tide studies",
          mode: "image",
          provider: "fal",
          model: "test-image",
          params: { kind: "image", count: 2 },
          createdAt: "2026-08-16T10:00:00.000Z",
        },
      ],
    };
    const migrated = AppSettingsSchema.parse(legacy);
    assert.equal(migrated.presets.length, 1, "the saved setup survived the rename");
    assert.equal(migrated.presets[0]!.name, "Tide studies");
    assert.equal(migrated.presets[0]!.id, "rcp_01J8F3K2QW9VZX4N7M0RTYB6HD", "and kept its stored id");
    assert.equal(migrated.routing.image, "test-image", "and so did everything beside it");
    assert.equal(migrated.spend.thresholdMicroUsd, 5000);
    assert.equal("recipes" in migrated, false, "the old key does not linger");

    // A file already written with the new key is untouched, and a file carrying both keeps
    // the new one rather than letting a stale copy win.
    const fresh = AppSettingsSchema.parse({ presets: [] });
    assert.deepEqual(fresh.presets, []);
    const both = AppSettingsSchema.parse({ recipes: legacy.recipes, presets: [] });
    assert.deepEqual(both.presets, [], "presets wins when both are present");
  });

  it("a preset's controls must match its mode, and a fault is stated rather than repaired", () => {
    const bad = BenchPresetSchema.safeParse({
      id: "rcp_01J8F3K2QW9VZX4N7M0RTYB6HD",
      name: "Tide studies",
      mode: "video",
      provider: "fal",
      model: "m",
      params: { kind: "image", count: 1 },
      createdAt: "2026-08-16T10:00:00.000Z",
    });
    assert.equal(bad.success, false);

    const preset = BenchPresetSchema.parse({
      id: "rcp_01J8F3K2QW9VZX4N7M0RTYB6HD",
      name: "Tide studies",
      mode: "image",
      provider: "fal",
      model: "test-image",
      params: { kind: "image", count: 2 },
      createdAt: "2026-08-16T10:00:00.000Z",
    });
    assert.deepEqual(presetFault(preset, { models: [MODEL] }, []), { ok: true });
    const gone = presetFault({ ...preset, model: "left" }, { models: [MODEL] }, []);
    assert.ok(!gone.ok && /no longer in the manifest/.test(gone.reason));
    const off = presetFault(preset, { models: [MODEL] }, ["test-image"]);
    assert.ok(!off.ok && /switched off in Providers/.test(off.reason));
  });
});

describe("keyframeAddable — reachability, not the next count's legality", () => {
  it("a gapped mode set admits picks through its illegal middle, and stops at the ceiling", () => {
    const gapped: ManifestModel = {
      id: "gapped",
      provider: "fal",
      capability: "video",
      displayName: "Gapped",
      accepts: { referenceImages: 0, referenceRoles: false, startFrame: false, endFrame: false },
      limits: {},
      pricing: { kind: "perSecond", microUsdPerSecond: 1 },
      modes: {
        generate: { locked: [] },
        "first-frame": { route: "t/i2v", locked: [] },
        "keyframe-sequence": { route: "t/r2v", locked: [], maxFrames: 3 },
      },
    };
    assert.equal(keyframeAddable(gapped, 0), true); // → 1, first-frame
    assert.equal(keyframeAddable(gapped, 1), true); // 2 is illegal, but 3 is reachable
    assert.equal(keyframeAddable(gapped, 2), true); // → 3, sequence
    assert.equal(keyframeAddable(gapped, 3), false); // the ceiling
  });
});

describe("a song's request snapshot (design turn 73)", () => {
  const base = {
    mode: "music" as const,
    brief: "Slow sea shanty · close harmony",
    references: [],
    provider: "fal",
    model: "minimax-music-3",
    params: { kind: "music" as const, lyrics: "[verse]\nSalt in the rope", count: 1 },
    keyframes: [],
  };

  it("carries a style and its words, and asks for no length", () => {
    const snapshot = BenchRequestSnapshotSchema.parse(base);
    assert.equal(snapshot.params.kind, "music");
    if (snapshot.params.kind === "music") {
      assert.equal(snapshot.params.lyrics, "[verse]\nSalt in the rope", "the newlines are the meter — they survive");
      assert.ok(!("durationSec" in snapshot.params), "there is no length control; the route's default is used");
    }
  });

  it("refuses a reference riding a song, because the row declares it takes none", () => {
    // Refused at the snapshot rather than dropped at dispatch: a reference that attaches, is
    // priced and then silently ignored is worse than one that was never allowed on.
    const withReference = {
      ...base,
      references: [
        {
          token: "Image 1",
          kind: "image" as const,
          source: {
            source: "artifact" as const,
            artifactId: "ar_01J8F3K2QW9VZX4N7M0RTYB6HD",
            hash: `sha256:${"a".repeat(64)}`,
          },
        },
      ],
    };
    const result = BenchRequestSnapshotSchema.safeParse(withReference);
    assert.equal(result.success, false);
    if (!result.success) assert.match(JSON.stringify(result.error.issues), /takes no references/);
  });

  it("refuses controls that belong to another mode", () => {
    const mismatched = { ...base, params: { kind: "image" as const, count: 1 } };
    assert.equal(BenchRequestSnapshotSchema.safeParse(mismatched).success, false);
  });

  it("prices sixty seconds at the shipped rate, which is what the screens draw", () => {
    assert.equal(MUSIC_DURATION_SEC, 60);
  });
});
