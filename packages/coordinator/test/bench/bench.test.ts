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
import { AppSettingsFile } from "../../src/app-settings.js";
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
          keyframes: [],
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
        takes: [{ id: takeId as never, n: 1, requestId: "r1", request: { mode: "image", brief: "x", references: [], keyframes: [], provider: "fal", model: "test-image", params: { kind: "image", count: 1 } }, createdAt: CLOCK() }],
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
        takes: [{ id: takeId as never, n: 1, requestId: "r1", request: { mode: "image", brief: "x", references: [], keyframes: [], provider: "fal", model: "test-image", params: { kind: "image", count: 1 } }, createdAt: CLOCK() }],
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
          keyframes: [],
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

describe("the Keyframe lane (issue 305 §3)", () => {
  const VIDEO_MODEL: ManifestModel = {
    id: "test-video",
    provider: "fal",
    capability: "video",
    displayName: "Test Video",
    accepts: { referenceImages: 2, startFrame: false, endFrame: false },
    limits: { maxDurationSec: 10, resolutions: ["720p"], aspects: ["16:9"] },
    pricing: { kind: "perSecond", microUsdPerSecond: 100000 },
    modes: {
      generate: { locked: [] },
      "first-frame": { route: "test/image-to-video", locked: ["aspect"] },
      "first-and-last-frame": { route: "test/image-to-video", locked: ["aspect"] },
    },
  };
  const VIDEO_MANIFEST: ModelManifest = { manifestVersion: 1, generated: "2026-08-16", models: [IMAGE_MODEL, VIDEO_MODEL] };

  async function fileImage(dir: string, name: string, id: string, hash: string) {
    await mkdir(join(dir, "artifacts"), { recursive: true });
    await writeFile(join(dir, "artifacts", name), `bytes of ${name}`);
    await writeFile(
      join(dir, "artifacts", `${name}.json`),
      JSON.stringify({ id, kind: "image", file: name, hash, origin: { by: "user" }, links: [], created: CLOCK() }),
    );
  }

  async function withImage(name = "frame.png") {
    const { dir, store } = await open();
    await fileImage(dir, name, `ar_${"01JKKKKKKKKKKKKKKKKKKKKKKK".slice(0, 26)}`, "sha256:deadbeefdeadbeef");
    await store.reload();
    const mine = store.getBundle().artifacts.find((a) => a.file === name);
    if (!mine) throw new Error("the filed sidecar did not scan");
    return { dir, store, artifactId: mine.id };
  }

  it("a keyframe pick lands in its own lane, never among the riding references", async () => {
    const { dir, store, artifactId } = await withImage();
    const opened = await freshBench(dir);
    const added = await addBenchReference(opened, store.getBundle(), VIDEO_MODEL, {
      source: { source: "artifact", artifactId },
      lane: "keyframe",
      requestId: "r1",
      at: CLOCK(),
    });
    assert.deepEqual(added, { outcome: "added", token: "Image 1" });
    const session = (await opened.store.fold())!;
    assert.deepEqual(session.composer.keyframeTokens, ["Image 1"]);
    assert.deepEqual(session.composer.activeTokens, []);
  });

  it("only a picture rides as a keyframe, in those words", async () => {
    const { dir, store } = await open();
    await mkdir(join(dir, "artifacts"), { recursive: true });
    await writeFile(join(dir, "artifacts", "bells.wav"), "wav bytes");
    await writeFile(
      join(dir, "artifacts", "bells.wav.json"),
      JSON.stringify({
        id: `ar_${"01JRRRRRRRRRRRRRRRRRRRRRRR".slice(0, 26)}`,
        kind: "audio",
        file: "bells.wav",
        hash: "sha256:deadbeefdeadbeef",
        origin: { by: "user" },
        links: [],
        created: CLOCK(),
      }),
    );
    await store.reload();
    const artifactId = store.getBundle().artifacts.find((a) => a.file === "bells.wav")!.id;
    const opened = await freshBench(dir);
    const outcome = await addBenchReference(opened, store.getBundle(), VIDEO_MODEL, {
      source: { source: "artifact", artifactId },
      lane: "keyframe",
      requestId: "r1",
      at: CLOCK(),
    });
    assert.deepEqual(outcome, { outcome: "refused", reason: "only an image can ride as a keyframe" });
  });

  it("the lane's ceiling is the frame modes' own: a third frame refuses with the missing route", async () => {
    const { dir, store } = await withImage("one.png");
    await fileImage(dir, "two.png", `ar_${"01JNNNNNNNNNNNNNNNNNNNNNNN".slice(0, 26)}`, "sha256:beefbeefbeefbeef");
    await fileImage(dir, "three.png", `ar_${"01JPPPPPPPPPPPPPPPPPPPPPPP".slice(0, 26)}`, "sha256:feedfeedfeedfeed");
    await store.reload();
    const bundle = store.getBundle();
    const ids = ["one.png", "two.png", "three.png"].map((f) => bundle.artifacts.find((a) => a.file === f)!.id);
    const opened = await freshBench(dir);
    for (const [i, id] of ids.slice(0, 2).entries()) {
      const ok = await addBenchReference((await refolded(opened))!, bundle, VIDEO_MODEL, {
        source: { source: "artifact", artifactId: id },
        lane: "keyframe",
        requestId: `r${i}`,
        at: CLOCK(),
      });
      assert.equal(ok.outcome, "added");
    }
    const third = await addBenchReference((await refolded(opened))!, bundle, VIDEO_MODEL, {
      source: { source: "artifact", artifactId: ids[2]! },
      lane: "keyframe",
      requestId: "r3",
      at: CLOCK(),
    });
    assert.equal(third.outcome, "refused");
    assert.match((third as { reason: string }).reason, /keyframe sequence route/);
  });

  it("dispatch honors the mode's route, drops the locked aspect, and snapshots the frames", async () => {
    const { dir, store, artifactId } = await withImage();
    const opened = await freshBench(dir);
    await addBenchReference(opened, store.getBundle(), VIDEO_MODEL, {
      source: { source: "artifact", artifactId },
      lane: "keyframe",
      requestId: "r1",
      at: CLOCK(),
    });
    await opened.store.append(
      {
        type: "composer-set",
        mode: "video",
        provider: "fal",
        model: "test-video",
        params: { kind: "video", aspect: "16:9", resolution: "720p", durationSec: 5 },
        brief: "the tide going still",
      },
      { at: CLOCK() },
    );
    const session = (await opened.store.fold())!;
    const plan = planBenchDispatch(session, store.getBundle(), VIDEO_MANIFEST, {
      worldId: store.worldId,
      requestId: "r2",
      at: CLOCK(),
    });
    assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
    if (plan.ok) {
      const params = plan.inputs[0]!.params;
      assert.equal(params["taskMode"], "first-frame");
      assert.equal(params["route"], "test/image-to-video");
      assert.deepEqual(params["references"], ["artifacts/frame.png"]);
      // The mode locks aspect and declares no sentinel: the chosen value must not go (R-33).
      assert.ok(!("aspect" in params), "locked aspect must not be sent");
      assert.equal(params["resolution"], "720p");
      assert.equal(plan.reserved[0]!.request.keyframes.length, 1);
      assert.equal(plan.reserved[0]!.request.keyframes[0]!.token, "Image 1");
    }
  });

  it("references and keyframes refuse to ride one request together", async () => {
    const { dir, store } = await withImage("one.png");
    await fileImage(dir, "two.png", `ar_${"01JQQQQQQQQQQQQQQQQQQQQQQQ".slice(0, 26)}`, "sha256:beefbeefbeefbeef");
    await store.reload();
    const bundle = store.getBundle();
    const firstId = bundle.artifacts.find((a) => a.file === "one.png")!.id;
    const secondId = bundle.artifacts.find((a) => a.file === "two.png")!.id;
    const opened = await freshBench(dir);
    await addBenchReference(opened, bundle, VIDEO_MODEL, {
      source: { source: "artifact", artifactId: firstId },
      requestId: "r1",
      at: CLOCK(),
    });
    await addBenchReference((await refolded(opened))!, bundle, VIDEO_MODEL, {
      source: { source: "artifact", artifactId: secondId },
      lane: "keyframe",
      requestId: "r2",
      at: CLOCK(),
    });
    await opened.store.append(
      { type: "composer-set", mode: "video", provider: "fal", model: "test-video", params: { kind: "video" }, brief: "x" },
      { at: CLOCK() },
    );
    const plan = planBenchDispatch((await opened.store.fold())!, bundle, VIDEO_MANIFEST, {
      worldId: store.worldId,
      requestId: "r3",
      at: CLOCK(),
    });
    assert.ok(!plan.ok);
    assert.match((plan as { reason: string }).reason, /References and keyframes cannot ride one request yet/);
  });
});

describe("recipes (issue 305 §3)", () => {
  const settingsPath = async () => join(await makeTempWorld(), "settings.json");
  const RECIPE_INPUT = {
    name: "Tide studies",
    mode: "image" as const,
    provider: "fal" as const,
    model: "test-image",
    params: { kind: "image" as const, count: 2 },
    brief: "a rusted tide-clock face",
  };

  it("saves validated against the manifest, persists, and the same name replaces", async () => {
    const path = await settingsPath();
    const file = new AppSettingsFile(path);
    const saved = await file.saveRecipe(RECIPE_INPUT, MANIFEST, CLOCK());
    assert.ok(saved.ok);
    if (saved.ok) {
      assert.equal(saved.recipe.name, "Tide studies");
      assert.match(saved.recipe.id, /^rcp_/);
    }

    // A fresh reader sees the same recipe: settings.json is the record, not the cache.
    const reread = await new AppSettingsFile(path).load();
    assert.equal(reread.recipes.length, 1);
    assert.equal(reread.recipes[0]!.params.kind === "image" && reread.recipes[0]!.params.count, 2);

    // Saving under the same name replaces — one gesture, one spelling, same identity.
    const replaced = await file.saveRecipe({ ...RECIPE_INPUT, params: { kind: "image", count: 4 } }, MANIFEST, CLOCK());
    assert.ok(replaced.ok);
    const after = await new AppSettingsFile(path).load();
    assert.equal(after.recipes.length, 1);
    if (saved.ok && replaced.ok) assert.equal(replaced.recipe.id, saved.recipe.id);
    assert.equal(after.recipes[0]!.params.kind === "image" && after.recipes[0]!.params.count, 4);
  });

  it("a model the manifest does not carry, or of the wrong capability, refuses with words", async () => {
    const file = new AppSettingsFile(await settingsPath());
    const unknown = await file.saveRecipe({ ...RECIPE_INPUT, model: "gone" }, MANIFEST, CLOCK());
    assert.ok(!unknown.ok && /not in the model manifest/.test(unknown.reason));
    const wrongMode = await file.saveRecipe(
      { ...RECIPE_INPUT, mode: "video", params: { kind: "video" } },
      MANIFEST,
      CLOCK(),
    );
    assert.ok(!wrongMode.ok && /is a image model, not video/.test(wrongMode.reason));
  });

  it("delete removes the one recipe and leaves the rest", async () => {
    const path = await settingsPath();
    const file = new AppSettingsFile(path);
    const a = await file.saveRecipe(RECIPE_INPUT, MANIFEST, CLOCK());
    const b = await file.saveRecipe({ ...RECIPE_INPUT, name: "Night harbour" }, MANIFEST, CLOCK());
    assert.ok(a.ok && b.ok);
    if (a.ok) await file.deleteRecipe(a.recipe.id);
    const after = await new AppSettingsFile(path).load();
    assert.deepEqual(after.recipes.map((r) => r.name), ["Night harbour"]);
  });

  it("one unreadable recipe drops alone rather than taking the settings file down", async () => {
    const path = await settingsPath();
    const file = new AppSettingsFile(path);
    await file.saveRecipe(RECIPE_INPUT, MANIFEST, CLOCK());
    const raw = JSON.parse(await readFile(path, "utf8")) as { recipes: unknown[]; models: unknown };
    raw.recipes.push({ this: "is not a recipe" });
    (raw as { models: { disabled: string[] } }).models = { disabled: ["something-off"] };
    await writeFile(path, JSON.stringify(raw));
    const reread = await new AppSettingsFile(path).load();
    assert.equal(reread.recipes.length, 1, "the good recipe survives");
    assert.deepEqual(reread.models.disabled, ["something-off"], "the rest of settings survives too");
  });
});

describe("the review's reckonings (issue 305 §3)", () => {
  const GAPPED_MODEL: ManifestModel = {
    id: "test-gapped",
    provider: "fal",
    capability: "video",
    displayName: "Gapped Video",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    limits: { maxDurationSec: 10 },
    pricing: { kind: "perSecond", microUsdPerSecond: 100000 },
    modes: {
      generate: { locked: [] },
      "first-frame": { route: "test/image-to-video", locked: [] },
      "keyframe-sequence": { route: "test/reference-to-video", locked: [], maxFrames: 3 },
    },
  };
  const GAPPED_MANIFEST: ModelManifest = { manifestVersion: 1, generated: "2026-08-16", models: [GAPPED_MODEL] };

  async function threeImages() {
    const { dir, store } = await open();
    await mkdir(join(dir, "artifacts"), { recursive: true });
    const ids: string[] = [];
    for (const [i, name] of ["kf-a.png", "kf-b.png", "kf-c.png"].entries()) {
      await writeFile(join(dir, "artifacts", name), `bytes ${name}`);
      const id = `ar_01JW${"WWWWWWWWWWWWWWWWWWWWW"}${i}`;
      await writeFile(
        join(dir, "artifacts", `${name}.json`),
        JSON.stringify({ id, kind: "image", file: name, hash: `sha256:ab${i}dab${i}dab${i}dab${i}d`, origin: { by: "user" }, links: [], created: CLOCK() }),
      );
      ids.push(id);
    }
    await store.reload();
    const found = ["kf-a.png", "kf-b.png", "kf-c.png"].map((f) => store.getBundle().artifacts.find((a) => a.file === f)!.id);
    return { dir, store, ids: found };
  }

  it("a gapped mode set fills THROUGH its illegal middle, which dispatch states until it passes", async () => {
    const { dir, store, ids } = await threeImages();
    const opened = await freshBench(dir);
    const bundle = store.getBundle();
    // No first-and-last-frame mode: two frames is illegal, three is legal. Both picks admit.
    for (const [i, id] of ids.slice(0, 2).entries()) {
      const ok = await addBenchReference((await refolded(opened))!, bundle, GAPPED_MODEL, {
        source: { source: "artifact", artifactId: id },
        lane: "keyframe",
        requestId: `g${i}`,
        at: CLOCK(),
      });
      assert.equal(ok.outcome, "added", JSON.stringify(ok));
    }
    await opened.store.append(
      { type: "composer-set", mode: "video", provider: "fal", model: "test-gapped", params: { kind: "video" }, brief: "x" },
      { at: CLOCK() },
    );
    // The middle is stated, not silently dead:
    const midway = planBenchDispatch((await opened.store.fold())!, bundle, GAPPED_MANIFEST, {
      worldId: store.worldId,
      requestId: "g-mid",
      at: CLOCK(),
    });
    assert.ok(!midway.ok);
    assert.match((midway as { reason: string }).reason, /first and last frame route/);
    // …and the third pick makes it legal on the sequence route.
    const third = await addBenchReference((await refolded(opened))!, bundle, GAPPED_MODEL, {
      source: { source: "artifact", artifactId: ids[2]! },
      lane: "keyframe",
      requestId: "g2",
      at: CLOCK(),
    });
    assert.equal(third.outcome, "added");
    const plan = planBenchDispatch((await opened.store.fold())!, bundle, GAPPED_MANIFEST, {
      worldId: store.worldId,
      requestId: "g-full",
      at: CLOCK(),
    });
    assert.ok(plan.ok, (plan as { reason?: string }).reason);
    if (plan.ok) {
      assert.equal(plan.inputs[0]!.params["taskMode"], "keyframe-sequence");
      assert.equal(plan.inputs[0]!.params["route"], "test/reference-to-video");
    }
  });

  it("an image dispatch ignores riding keyframes instead of refusing from hidden state", async () => {
    const { dir, store, ids } = await threeImages();
    const opened = await freshBench(dir);
    const bundle = store.getBundle();
    const added = await addBenchReference(opened, bundle, GAPPED_MODEL, {
      source: { source: "artifact", artifactId: ids[0]! },
      lane: "keyframe",
      requestId: "i0",
      at: CLOCK(),
    });
    assert.equal(added.outcome, "added");
    // The composer moves on to an image request; the lane rides along, ignored.
    await opened.store.append(
      { type: "composer-set", mode: "image", provider: "fal", model: "test-image", params: { kind: "image", count: 1 }, brief: "a tide-clock" },
      { at: CLOCK() },
    );
    const plan = planBenchDispatch((await opened.store.fold())!, bundle, MANIFEST, {
      worldId: store.worldId,
      requestId: "i1",
      at: CLOCK(),
    });
    assert.ok(plan.ok, (plan as { reason?: string }).reason);
    if (plan.ok) {
      assert.ok(!("taskMode" in plan.inputs[0]!.params));
      assert.equal(plan.reserved[0]!.request.keyframes.length, 0);
    }
  });
});
