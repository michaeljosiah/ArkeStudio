import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  admitReference,
  BenchSessionSchema,
  benchSessionSummary,
  benchSourceKey,
  benchTokenFor,
  foldBenchSession,
  formatSeconds,
  multimediaCapacity,
  parseBenchToken,
  validateReferences,
  type BenchEventEnvelope,
  type BenchReferenceToken,
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
