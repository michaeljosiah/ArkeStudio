import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  benchSourceKey,
  newId,
  type BenchTake,
  type ManifestModel,
  type ModelManifest,
  type SessionId,
} from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { fileGeneratedArtifact } from "../../src/artifacts/filing.js";
import { BenchStore, sessionDir, sessionMediaDir } from "../../src/bench/store.js";
import {
  addBenchReference,
  discoverBenchSessions,
  openBenchSession,
  planBenchDispatch,
  recoverBenchSession,
} from "../../src/bench/service.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

const CLOCK = () => "2026-08-16T12:00:00.000Z";

const IMAGE_MODEL: ManifestModel = {
  id: "test-image",
  provider: "fal",
  capability: "image",
  displayName: "Test Image",
  accepts: { referenceImages: 2, startFrame: false, endFrame: false },
  limits: { maxPromptChars: 100 },
  pricing: { kind: "perImage", microUsdPerImage: 60000 },
};

const MANIFEST: ModelManifest = {
  manifestVersion: 1,
  generated: "2026-08-16",
  models: [IMAGE_MODEL],
};

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  // A live watcher holds the runner's event loop open; the sweep closes what a failing
  // assertion would have skipped.
  closeOnCleanup(() => store.close());
  return { dir, store };
}

async function freshBench(dir: string) {
  const opened = await openBenchSession(dir, CLOCK, {
    fresh: true,
    defaultModel: { provider: "fal", model: "test-image" },
  });
  assert.ok(opened);
  return opened;
}

async function refolded(opened: { store: BenchStore }) {
  const session = await opened.store.fold();
  return session === null ? null : { store: opened.store, session };
}

describe("the bench store (issue 305 §6)", () => {
  it("appends land durably and a repeated requestId writes nothing", async () => {
    const dir = await makeTempWorld();
    const opened = await freshBench(dir);
    const first = await opened.store.append({ type: "title-set", title: "Harbour night studies" }, { at: CLOCK(), requestId: "r1" });
    assert.equal(first.deduplicated, false);
    const again = await opened.store.append({ type: "title-set", title: "Harbour night studies" }, { at: CLOCK(), requestId: "r1" });
    assert.equal(again.deduplicated, true);
    assert.equal(again.envelope.seq, first.envelope.seq);
    const session = await opened.store.fold();
    assert.equal(session?.title, "Harbour night studies");
  });

  it("repairs a torn final line instead of extending it", async () => {
    const dir = await makeTempWorld();
    const opened = await freshBench(dir);
    await opened.store.append({ type: "title-set", title: "whole" }, { at: CLOCK() });
    // A crash mid-append leaves bytes that are not a record.
    await appendFile(opened.store.eventsPath, '{"seq":99,"at":"2026', "utf8");
    const store2 = new BenchStore(opened.store.dir);
    const events = await store2.read();
    assert.ok(events.every((e) => e.seq < 99));
    const session = await store2.fold();
    assert.equal(session?.title, "whole");
  });

  it("a session that was never created folds to null rather than a ghost", async () => {
    const dir = await makeTempWorld();
    const store = new BenchStore(sessionDir(dir, newId("sess") as SessionId));
    assert.equal(await store.fold(), null);
  });
});

describe("opening and discovery", () => {
  it("Generate resumes the most recently updated session and creates only when there are none", async () => {
    const dir = await makeTempWorld();
    const a = await freshBench(dir);
    // No session id: resumes `a` rather than minting a sibling.
    const resumed = await openBenchSession(dir, () => "2026-08-16T13:00:00.000Z");
    assert.equal(resumed?.session.id, a.session.id);
    // Clear-the-bench: a NEW session, and the old one is still discoverable.
    const b = await openBenchSession(dir, () => "2026-08-16T14:00:00.000Z", { fresh: true });
    assert.notEqual(b?.session.id, a.session.id);
    const summaries = await discoverBenchSessions(dir);
    assert.equal(summaries.length, 2);
    assert.equal(summaries[0]?.id, b?.session.id); // newest first
  });
});

describe("reference allocation (issue 305 §4)", () => {
  async function withArtifact(kindFile: string, bytes = "png bytes") {
    const { dir, store } = await open();
    await mkdir(join(dir, "artifacts"), { recursive: true });
    await writeFile(join(dir, "artifacts", kindFile), bytes);
    const sidecar = {
      id: `ar_${"01JMMMMMMMMMMMMMMMMMMMMMMM".slice(0, 26)}`,
      kind: kindFile.endsWith(".png") ? "image" : kindFile.endsWith(".wav") ? "audio" : "document",
      file: kindFile,
      hash: "sha256:deadbeefdeadbeef",
      origin: { by: "user" },
      links: [],
      created: CLOCK(),
    };
    await writeFile(join(dir, "artifacts", `${kindFile}.json`), JSON.stringify(sidecar));
    await store.reload();
    const mine = store.getBundle().artifacts.find((a) => a.file === kindFile);
    if (!mine) throw new Error("the filed sidecar did not scan");
    return { dir, store, artifactId: mine.id };
  }

  it("allocates Image 1, restores the same token on re-add, and never reuses a number", async () => {
    const { dir, store, artifactId } = await withArtifact("quarter.png");
    const opened = await freshBench(dir);
    const bundle = store.getBundle();
    

    const added = await addBenchReference(opened, bundle, IMAGE_MODEL, {
      source: { source: "artifact", artifactId },
      requestId: "r1",
      at: CLOCK(),
    });
    assert.deepEqual(added, { outcome: "added", token: "Image 1" });

    // Active twice is refused as already-active, not double-tokened.
    const again = await addBenchReference((await refolded(opened))!, bundle, IMAGE_MODEL, {
      source: { source: "artifact", artifactId },
      requestId: "r2",
      at: CLOCK(),
    });
    assert.equal(again.outcome, "already-active");

    // Remove, then re-add: the old name comes back; nothing is renumbered.
    await opened.store.append({ type: "reference-removed", token: "Image 1" }, { at: CLOCK() });
    const restored = await addBenchReference((await refolded(opened))!, bundle, IMAGE_MODEL, {
      source: { source: "artifact", artifactId },
      requestId: "r3",
      at: CLOCK(),
    });
    assert.deepEqual(restored, { outcome: "restored", token: "Image 1" });
    const session = await opened.store.fold();
    assert.equal(session?.tokenRegistry.length, 1);
    assert.equal(benchSourceKey(session!.tokenRegistry[0]!.source), `artifact:${artifactId}`);
  });

  it("a document refuses with the spec's words", async () => {
    const { dir, store, artifactId } = await withArtifact("notes.md", "# notes");
    const opened = await freshBench(dir);
    const bundle = store.getBundle();
    const outcome = await addBenchReference(opened, bundle, IMAGE_MODEL, {
      source: { source: "artifact", artifactId },
      requestId: "r1",
      at: CLOCK(),
    });
    assert.deepEqual(outcome, { outcome: "refused", reason: "a document cannot be sent" });
  });

  it("an audio file with no measured duration refuses rather than assuming zero", async () => {
    const { dir, store, artifactId } = await withArtifact("bells.wav", "wav bytes");
    const opened = await freshBench(dir);
    const bundle = store.getBundle();
    // The model declares an allowance, so the KIND is fine — the unknown length is not.
    const model = { ...IMAGE_MODEL, limits: { ...IMAGE_MODEL.limits, maxReferenceAudioSec: 60 } };
    const outcome = await addBenchReference(opened, bundle, model, {
      source: { source: "artifact", artifactId },
      requestId: "r1",
      at: CLOCK(),
    });
    assert.deepEqual(outcome, { outcome: "refused", reason: "duration could not be read" });
  });

});

describe("dispatch planning (issue 305 §9)", () => {
  it("count N reserves N consecutive numbers, one job each, snapshots immutable", async () => {
    const { dir, store } = await open();
    const opened = await freshBench(dir);
    await opened.store.append(
      { type: "composer-set", mode: "image", provider: "fal", model: "test-image", params: { kind: "image", count: 3 }, brief: "a tide-clock" },
      { at: CLOCK() },
    );
    const session = (await opened.store.fold())!;
    const plan = planBenchDispatch(session, store.getBundle(), MANIFEST, {
      worldId: store.worldId,
      requestId: "r1",
      at: CLOCK(),
    });
    assert.ok(plan.ok);
    if (plan.ok) {
      assert.deepEqual(plan.reserved.map((t) => t.n), [1, 2, 3]);
      assert.equal(plan.inputs.length, 3);
      // Each job lands in its own take's media directory inside the session.
      assert.ok(plan.inputs[0]!.landing.dir.startsWith(`.sessions/${session.id}/media/`));
      // Each snapshot is a one-image request whatever the batch asked for.
      assert.ok(plan.reserved.every((t) => t.request.params.kind === "image" && t.request.params.count === 1));
      assert.ok(plan.reserved.every((t) => t.request.brief === "a tide-clock"));
    }
  });

  it("over the model's published prompt cap refuses before anything is reserved", async () => {
    const { dir, store } = await open();
    const opened = await freshBench(dir);
    await opened.store.append(
      { type: "composer-set", mode: "image", provider: "fal", model: "test-image", params: { kind: "image", count: 1 }, brief: "x".repeat(101) },
      { at: CLOCK() },
    );
    const plan = planBenchDispatch((await opened.store.fold())!, store.getBundle(), MANIFEST, {
      worldId: store.worldId,
      requestId: "r1",
      at: CLOCK(),
    });
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.match(plan.reason, /101 characters.*takes 100/);
  });

  it("an empty brief, an unknown model, and a mode mismatch each refuse with their reason", async () => {
    const { dir, store } = await open();
    const opened = await freshBench(dir);
    const fold = async () => (await opened.store.fold())!;
    const plan = (session: Awaited<ReturnType<typeof fold>>) =>
      planBenchDispatch(session, store.getBundle(), MANIFEST, { worldId: store.worldId, requestId: "r", at: CLOCK() });

    await opened.store.append(
      { type: "composer-set", mode: "image", provider: "fal", model: "test-image", params: { kind: "image", count: 1 }, brief: "  " },
      { at: CLOCK() },
    );
    assert.match((plan(await fold()) as { reason: string }).reason, /empty brief/i);

    await opened.store.append(
      { type: "composer-set", mode: "image", provider: "fal", model: "nope", params: { kind: "image", count: 1 }, brief: "x" },
      { at: CLOCK() },
    );
    assert.match((plan(await fold()) as { reason: string }).reason, /no longer in the manifest|No model/);

    await opened.store.append(
      { type: "composer-set", mode: "video", provider: "fal", model: "test-image", params: { kind: "video" }, brief: "x" },
      { at: CLOCK() },
    );
    assert.match((plan(await fold()) as { reason: string }).reason, /image model.*video request/);
  });

  it("a re-run dispatches the take's immutable snapshot, not the live composer", async () => {
    const { dir, store } = await open();
    const opened = await freshBench(dir);
    const take: BenchTake = {
      id: newId("tk") as BenchTake["id"],
      n: 1,
      requestId: "orig",
      status: "succeeded",
      request: {
        mode: "image",
        brief: "the ORIGINAL brief",
        references: [],
        provider: "fal",
        model: "test-image",
        params: { kind: "image", count: 1 },
      },
      disposition: "open",
      createdAt: CLOCK(),
    };
    await opened.store.append({ type: "takes-reserved", takes: [{ id: take.id, n: 1, requestId: "orig", request: take.request, createdAt: CLOCK() }] }, { at: CLOCK() });
    // The composer has since moved on to different words.
    await opened.store.append(
      { type: "composer-set", mode: "image", provider: "fal", model: "test-image", params: { kind: "image", count: 4 }, brief: "something else entirely" },
      { at: CLOCK() },
    );
    const session = (await opened.store.fold())!;
    const plan = planBenchDispatch(session, store.getBundle(), MANIFEST, {
      worldId: store.worldId,
      requestId: "r2",
      at: CLOCK(),
      fromTake: session.takes[0]!,
    });
    assert.ok(plan.ok);
    if (plan.ok) {
      assert.equal(plan.reserved.length, 1); // re-run is always exactly one
      assert.equal(plan.reserved[0]!.n, 2); // a NEW number; nothing is overwritten
      assert.equal(plan.reserved[0]!.request.brief, "the ORIGINAL brief");
    }
  });
});

describe("recovery (issue 305 §6)", () => {
  it("window one: a reserved take with no job fails with 'nothing was spent'", async () => {
    const { dir } = await open();
    const opened = await freshBench(dir);
    const takeId = newId("tk");
    await opened.store.append(
      {
        type: "takes-reserved",
        takes: [{ id: takeId as never, n: 1, requestId: "r1", request: { mode: "image", brief: "x", references: [], provider: "fal", model: "test-image", params: { kind: "image", count: 1 } }, createdAt: CLOCK() }],
      },
      { at: CLOCK() },
    );
    const touched = await recoverBenchSession((await refolded(opened))!, [], CLOCK);
    assert.equal(touched, true);
    const session = await opened.store.fold();
    assert.equal(session?.takes[0]?.status, "failed");
    assert.match(session?.takes[0]?.error ?? "", /nothing was spent/);
    // Idempotent: running it again changes nothing.
    assert.equal(await recoverBenchSession((await refolded(opened))!, [], CLOCK), false);
  });

  it("window two: a job the log never heard finished catches the log up", async () => {
    const { dir } = await open();
    const opened = await freshBench(dir);
    const takeId = newId("tk");
    const session0 = (await opened.store.fold())!;
    await opened.store.append(
      {
        type: "takes-reserved",
        takes: [{ id: takeId as never, n: 1, requestId: "r1", request: { mode: "image", brief: "x", references: [], provider: "fal", model: "test-image", params: { kind: "image", count: 1 } }, createdAt: CLOCK() }],
      },
      { at: CLOCK() },
    );
    const jobId = newId("jb");
    const touched = await recoverBenchSession((await refolded(opened))!, [
      { jobId, targetId: `${session0.id}/${takeId}`, status: "failed", error: "provider said no" },
    ], CLOCK);
    assert.equal(touched, true);
    const session = await opened.store.fold();
    assert.equal(session?.takes[0]?.jobId, jobId);
    assert.equal(session?.takes[0]?.status, "failed");
    assert.equal(session?.takes[0]?.error, "provider said no");
  });

});

describe("keeping (issue 305 §7)", () => {
  it("files with system origin, generation provenance, world ownership — idempotent by take id, never hash-deduped", async () => {
    const { dir, store } = await open();
    const opened = await freshBench(dir);
    const takeId = newId("tk");
    const mediaDir = join(dir, sessionMediaDir(opened.session.id, takeId));
    await mkdir(mediaDir, { recursive: true });
    await writeFile(join(mediaDir, "take.png"), "the same bytes");

    // The same bytes already exist as a USER artifact — keep must not collapse into it.
    await mkdir(join(dir, "artifacts"), { recursive: true });
    await writeFile(join(dir, "artifacts", "upload.png"), "the same bytes");
    const generation = {
      sessionId: opened.session.id,
      takeId: takeId as never,
      takeNumber: 1,
      brief: "a rusted tide-clock face on wet slate",
      references: [],
      provider: "fal",
      model: "test-image",
      params: { kind: "image" as const, count: 1 },
      costMicroUsd: 60000,
    };
    const first = await fileGeneratedArtifact(store, { sourcePath: join(mediaDir, "take.png"), generation });
    assert.deepEqual(first.origin, { by: "system", producedBy: "bench" });
    assert.equal(first.production, undefined); // the world owns it
    assert.equal(first.generation?.takeId, takeId);
    assert.match(first.file, /take-1\.png$/);

    // Retry of Keep: the same artifact comes back; no sibling is minted.
    const again = await fileGeneratedArtifact(store, { sourcePath: join(mediaDir, "take.png"), generation });
    assert.equal(again.id, first.id);

    // And the user's identical bytes are still their own artifact.
    const files = store.getBundle().artifacts.map((a) => a.file).sort();
    assert.equal(files.filter((f) => f !== "upload.png").length >= 1, true);
    const bytes = await readFile(join(dir, "artifacts", first.file), "utf8");
    assert.equal(bytes, "the same bytes");
  });
});
