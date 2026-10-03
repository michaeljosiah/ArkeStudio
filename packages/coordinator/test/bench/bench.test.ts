import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  benchSourceKey,
  MUSIC_DURATION_SEC,
  newId,
  quoteSpeech,
  type BenchTake,
  type JobSampling,
  type ManifestModel,
  type ModelManifest,
  type SessionId,
} from "@arke-studio/contracts";
import { AppSettingsFile } from "../../src/app-settings.js";
import { WorldStore } from "../../src/world/store.js";
import { fileGeneratedArtifact } from "../../src/artifacts/filing.js";
import { BenchStore, sessionDir, sessionMediaDir } from "../../src/bench/store.js";
import { lyricistBrief } from "../../src/bench/lyricist.js";
import { localTakeFreeze } from "../../src/queue/local-sampling.js";
import {
  addBenchReference,
  discoverBenchSessions,
  openBenchSession,
  planBenchDispatch,
  recoverBenchSession,
  benchTakeFiles,
  deleteBenchTake,
  planBenchUpscale,
  sweepDeletedBenchMedia,
} from "../../src/bench/service.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
import { comfyUiRecipeById, SHIPPED_MANIFEST } from "@arke-studio/providers";

const CLOCK = () => "2026-08-16T12:00:00.000Z";

it("refuses oversized Gemini Bench lines before reserving takes, counting delivery beside Unicode words", async () => {
  const { dir, store } = await open();
  const opened = await freshBench(dir);
  const at = "2026-09-27T12:00:00.000Z";
  for (const model of SHIPPED_MANIFEST.models.filter(m => m.provider === "google" && m.capability === "voice-tts")) {
    const allowance = model.limits.maxSpeechUtf8Bytes! - Buffer.byteLength(model.cadence!.deliveryMappings.warm!.instruction!);
    for (const [brief, fits] of [["字".repeat(2400), false], ["a".repeat(allowance + 1), false], ["a".repeat(allowance), true]] as const) {
      await opened.store.append({ type: "composer-set", mode: "voice", provider: model.provider, model: model.id,
        params: { kind: "voice", count: 1, voiceId: "Charon", voiceProvider: "google", voiceModel: model.id, delivery: "warm" }, brief }, { at });
      const plan = planBenchDispatch((await opened.store.fold())!, store.getBundle(), SHIPPED_MANIFEST,
        { worldId: store.worldId, requestId: "gemini-byte-limit", at, speechAuthorisation: { confirmedMicroUsd: 1000000 } });
      assert.equal(plan.ok, fits, plan.ok ? undefined : plan.reason);
      if (!plan.ok) assert.match(plan.reason, /request limit/);
    }
  }
});

// Review of PR 1477: a pre-turn-181 brief's typed tag compiles to Gemini's own tag, longer than
// the brief the composer priced; the composer's estimate of the brief as typed must still answer.
it("answers a legacy typed-tag Gemini brief with the composer's estimate of the brief as typed", async () => {
  const { dir, store } = await open();
  const opened = await freshBench(dir);
  const at = "2026-09-27T12:00:00.000Z";
  const model = SHIPPED_MANIFEST.models.find(m => m.id === "gemini-3.8-flash-tts")!;
  const brief = "[pause] Go.";
  await opened.store.append({ type: "composer-set", mode: "voice", provider: model.provider, model: model.id,
    params: { kind: "voice", count: 1, voiceId: "Charon", voiceProvider: "google", voiceModel: model.id }, brief }, { at });
  const composer = quoteSpeech(model, brief, { at }).expectedMicroUsd;
  const plan = planBenchDispatch((await opened.store.fold())!, store.getBundle(), SHIPPED_MANIFEST,
    { worldId: store.worldId, requestId: "gemini-legacy-tag", at, speechAuthorisation: { confirmedMicroUsd: composer } });
  assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
  assert.notEqual(plan.inputs[0]!.params.text, brief, "the tag went as the reader's own");
  const late = planBenchDispatch((await opened.store.fold())!, store.getBundle(), SHIPPED_MANIFEST,
    { worldId: store.worldId, requestId: "gemini-legacy-tag", at: "2027-01-01T00:00:00.000Z", speechAuthorisation: { confirmedMicroUsd: composer } });
  assert.equal(late.ok, false, "a rate rise still asks again");
});

it("adapter quotes and re-runs retain the same recipe identity and refuse changed graphs", async () => {
  const { dir, store } = await open();
  const model = SHIPPED_MANIFEST.models.find(row => row.id === "comfyui-h3-video")!;
  const opened = await openBenchSession(dir, CLOCK, { fresh: true, defaultModel: { provider: "comfyui", model: model.id } });
  assert.ok(opened);
  const adapters = [{ releaseId: "neutral-fixture", sha256: "a".repeat(64), strength: 0.5 }];
  await opened.store.append({ type: "composer-set", mode: "video", provider: "comfyui", model: model.id,
    params: { kind: "video", durationSec: 5, aspect: "16:9", resolution: "480p", adapters }, brief: "A red cube moves." }, { at: CLOCK() });
  const session = (await opened.store.fold())!;
  const recipe = { id: model.id, version: 1, templateDigest: "b".repeat(64), dependencyDigest: "c".repeat(64), adapters };
  const options = { worldId: store.worldId, requestId: "adapter-plan", at: CLOCK(), adapterRecipeFor: () => recipe };
  const plan = planBenchDispatch(session, store.getBundle(), SHIPPED_MANIFEST, options);
  assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
  if (!plan.ok) return;
  assert.deepEqual(plan.reserved[0]!.request.recipe, recipe);
  assert.deepEqual(plan.inputs[0]!.recipe, recipe);
  assert.deepEqual(plan.inputs[0]!.params.adapters, adapters);
  const take = { ...plan.reserved[0]!, status: "succeeded", disposition: "open", createdAt: CLOCK() } as BenchTake;
  const rerun = planBenchDispatch(session, store.getBundle(), SHIPPED_MANIFEST, { ...options, fromTake: take,
    adapterRecipeFor: () => ({ ...recipe, templateDigest: "d".repeat(64) }) });
  assert.equal(rerun.ok, false);
  if (!rerun.ok) assert.match(rerun.reason, /recipe has changed/);
});

it("a local H3 take records its sampling and seed, and a re-run keeps the sampling with a new seed (design turn 177)", async () => {
  const { dir, store } = await open();
  const model = SHIPPED_MANIFEST.models.find(row => row.id === "comfyui-h3-video")!;
  const opened = await openBenchSession(dir, CLOCK, { fresh: true, defaultModel: { provider: "comfyui", model: model.id } });
  assert.ok(opened);
  await opened.store.append({ type: "composer-set", mode: "video", provider: "comfyui", model: model.id,
    params: { kind: "video", durationSec: 5, aspect: "16:9", resolution: "480p" }, brief: "A red cube moves." }, { at: CLOCK() });
  const quality = { preset: "quality" as const, ...model.sampling!.presets[2]!.values };
  let setting: { preset: "quality" | "balanced" } = { preset: "quality" };
  const seeds = [101, 202];
  const options = { worldId: store.worldId, requestId: "sampled", at: CLOCK(),
    localFreeze: (modelId: string, rerunOf?: { sampling?: JobSampling }) => localTakeFreeze(modelId, rerunOf, () => setting, () => seeds.shift()!) };
  const plan = planBenchDispatch((await opened.store.fold())!, store.getBundle(), SHIPPED_MANIFEST, options);
  assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
  if (!plan.ok) return;
  assert.deepEqual(plan.reserved[0]!.request.sampling, quality);
  assert.equal(plan.reserved[0]!.request.requestedSeed, 101);
  assert.deepEqual(plan.inputs[0]!.params.sampling, quality);
  assert.equal(plan.inputs[0]!.params.seed, 101);
  setting = { preset: "balanced" };
  const take = { ...plan.reserved[0]!, status: "succeeded", disposition: "open", createdAt: CLOCK() } as BenchTake;
  const rerun = planBenchDispatch((await opened.store.fold())!, store.getBundle(), SHIPPED_MANIFEST, { ...options, fromTake: take });
  assert.ok(rerun.ok, rerun.ok ? undefined : rerun.reason);
  if (!rerun.ok) return;
  assert.deepEqual(rerun.inputs[0]!.params.sampling, quality, "the take's own sampling, not today's setting");
  assert.equal(rerun.inputs[0]!.params.seed, 202);
  assert.equal(rerun.reserved[0]!.request.requestedSeed, 202);
});

it("local H3 bench references freeze multimedia identities and use native ordered tags", async () => {
  const { dir, store } = await open();
  const model = SHIPPED_MANIFEST.models.find(row => row.id === "comfyui-h3-reference-video")!;
  await store.ownedWrite(async () => {
    await mkdir(join(dir, "artifacts"), { recursive: true });
    for (const [file, kind] of [["picture.png", "image"], ["motion.mp4", "video"], ["tone.wav", "audio"]] as const) {
      const bytes = Buffer.from(`fixture ${file}`);
      await writeFile(join(dir, "artifacts", file), bytes);
      await writeFile(join(dir, "artifacts", `${file}.json`), JSON.stringify({ id: newId("ar"), kind, file,
        hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, origin: { by: "user" }, links: [], created: CLOCK(),
        ...(kind === "image" ? {} : { mediaInfo: { durationSec: 2, hasAudio: true } }) }));
    }
  });
  const opened = await openBenchSession(dir, CLOCK, { fresh: true, defaultModel: { provider: "comfyui", model: model.id } });
  assert.ok(opened);
  await opened.store.append({ type: "composer-set", mode: "video", provider: "comfyui", model: model.id,
    params: { kind: "video", durationSec: 5, aspect: "16:9", resolution: "480p" }, brief: "A red cube moves." }, { at: CLOCK() });
  const empty = planBenchDispatch((await opened.store.fold())!, store.getBundle(), SHIPPED_MANIFEST,
    { worldId: store.worldId, requestId: "empty", at: CLOCK() });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.match(empty.reason, /at least one/);
  for (const file of ["picture.png", "motion.mp4", "tone.wav"]) {
    const artifact = store.getBundle().artifacts.find(row => row.file === file)!;
    const outcome = await addBenchReference((await refolded(opened))!, store.getBundle(), model,
      { source: { source: "artifact", artifactId: artifact.id }, requestId: `attach-${file}`, at: CLOCK() });
    assert.notEqual(outcome.outcome, "refused", JSON.stringify(outcome));
  }
  await opened.store.append({ type: "composer-set", mode: "video", provider: "comfyui", model: model.id,
    params: { kind: "video", durationSec: 5, aspect: "16:9", resolution: "480p" },
    brief: "Use @Image 1 for color, @Video 1 for motion and @Audio 1 for sound." }, { at: CLOCK() });
  const plan = planBenchDispatch((await opened.store.fold())!, store.getBundle(), SHIPPED_MANIFEST,
    { worldId: store.worldId, requestId: "dispatch", at: CLOCK() });
  assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
  if (!plan.ok) return;
  const params = plan.inputs[0]!.params;
  assert.match(String(params.prompt), /<Picture 1>.*<Video 1>.*<Audio 2>/);
  assert.deepEqual(params.references, ["artifacts/picture.png"]);
  assert.deepEqual(params.videoReferences, ["artifacts/motion.mp4"]);
  assert.deepEqual((params.referenceMedia as Array<{ kind: string }>).map(ref => ref.kind), ["video", "audio"]);
  assert.equal(plan.reserved[0]!.request.brief, "Use @Image 1 for color, @Video 1 for motion and @Audio 1 for sound.");
});

it("Seedance bench carries legacy artifact hashes and cites its motion reference", async () => {
  const { dir, store } = await open();
  const model = SHIPPED_MANIFEST.models.find(row => row.id === "seedance-2.0")!;
  await store.ownedWrite(async () => {
    await mkdir(join(dir, "artifacts"), { recursive: true });
    for (const [file, kind] of [["picture.png", "image"], ["motion.mp4", "video"], ["motion.webm", "video"], ["tone.wav", "audio"]] as const) {
      const bytes = Buffer.from(`fixture ${file}`);
      await writeFile(join(dir, "artifacts", file), bytes);
      await writeFile(join(dir, "artifacts", `${file}.json`), JSON.stringify({ id: newId("ar"), kind, file,
        hash: `sha256:${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`, origin: { by: "user" }, links: [], created: CLOCK(),
        ...(kind === "image" ? {} : { mediaInfo: { durationSec: 2, hasAudio: true } }) }));
    }
  });
  const opened = await openBenchSession(dir, CLOCK, { fresh: true, defaultModel: { provider: "fal", model: model.id } });
  assert.ok(opened);
  await opened.store.append({ type: "composer-set", mode: "video", provider: "fal", model: model.id,
    params: { kind: "video", durationSec: 5, aspect: "16:9", resolution: "480p" }, brief: "A red cube moves." }, { at: CLOCK() });
  const webm = store.getBundle().artifacts.find(row => row.file === "motion.webm")!;
  const refused = await addBenchReference((await refolded(opened))!, store.getBundle(), model,
    { source: { source: "artifact", artifactId: webm.id }, requestId: "webm", at: CLOCK() });
  assert.deepEqual(refused, { outcome: "refused", reason: "Seedance video references must be MP4 or MOV." });
  assert.equal((await opened.store.fold())!.tokenRegistry.length, 0);
  const empty = planBenchDispatch((await opened.store.fold())!, store.getBundle(), SHIPPED_MANIFEST,
    { worldId: store.worldId, requestId: "empty", at: CLOCK() });
  assert.equal(empty.ok, true);
  for (const file of ["picture.png", "motion.mp4", "tone.wav"]) {
    const artifact = store.getBundle().artifacts.find(row => row.file === file)!;
    const outcome = await addBenchReference((await refolded(opened))!, store.getBundle(), model,
      { source: { source: "artifact", artifactId: artifact.id }, requestId: `attach-${file}`, at: CLOCK() });
    assert.notEqual(outcome.outcome, "refused", JSON.stringify(outcome));
  }
  await opened.store.append({ type: "composer-set", mode: "video", provider: "fal", model: model.id,
    params: { kind: "video", durationSec: 5, aspect: "16:9", resolution: "480p" },
    brief: "Use @Image 1 for color, @Video 1 for motion and @Audio 1 for sound." }, { at: CLOCK() });
  const plan = planBenchDispatch((await opened.store.fold())!, store.getBundle(), SHIPPED_MANIFEST,
    { worldId: store.worldId, requestId: "dispatch", at: CLOCK() });
  assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
  if (!plan.ok) return;
  const params = plan.inputs[0]!.params;
  assert.match(String(params.prompt), /@Image1.*@Video1.*@Audio1/);
  assert.match(String(params.prompt), /Use @Video1 as a motion reference/);
  assert.deepEqual(params.references, ["artifacts/picture.png"]);
  assert.deepEqual(params.videoReferences, ["artifacts/motion.mp4"]);
  assert.deepEqual((params.referenceMedia as Array<{ kind: string }>).map(ref => ref.kind), ["video", "audio"]);
  assert.equal(plan.reserved[0]!.request.brief, "Use @Image 1 for color, @Video 1 for motion and @Audio 1 for sound.");
});

/** A world holding two pictures and a Krea 2 bench over both, built the way the H3 test builds its own. */
async function kreaBench() {
  const { dir, store } = await open();
  const model = SHIPPED_MANIFEST.models.find(row => row.id === "comfyui-krea2-image")!;
  await store.ownedWrite(async () => {
    await mkdir(join(dir, "artifacts"), { recursive: true });
    for (const file of ["coat.png", "ada.png"]) {
      const bytes = Buffer.from(`fixture ${file}`);
      await writeFile(join(dir, "artifacts", file), bytes);
      await writeFile(join(dir, "artifacts", `${file}.json`), JSON.stringify({ id: newId("ar"), kind: "image", file,
        hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, origin: { by: "user" }, links: [], created: CLOCK() }));
    }
  });
  const opened = await openBenchSession(dir, CLOCK, { fresh: true, defaultModel: { provider: "comfyui", model: model.id } });
  assert.ok(opened);
  for (const file of ["coat.png", "ada.png"]) {
    const artifact = store.getBundle().artifacts.find(row => row.file === file)!;
    const outcome = await addBenchReference((await refolded(opened))!, store.getBundle(), model,
      { source: { source: "artifact", artifactId: artifact.id }, requestId: `attach-${file}`, at: CLOCK() });
    assert.notEqual(outcome.outcome, "refused", JSON.stringify(outcome));
  }
  const compose = async (brief: string) => {
    await opened.store.append({ type: "composer-set", mode: "image", provider: "comfyui", model: model.id,
      params: { kind: "image", count: 1 }, brief }, { at: CLOCK() });
    return (await opened.store.fold())!;
  };
  return { store, opened, model, compose, version: comfyUiRecipeById(model.id)!.recipeVersion };
}

it("Krea 2 bench references arrive under the rebalance node's picture labels (issue 1083)", async () => {
  const { store, compose, version } = await kreaBench();
  const plan = planBenchDispatch(await compose("@Image 2 wears the coat from @Image 1, in the rain."), store.getBundle(), SHIPPED_MANIFEST,
    { worldId: store.worldId, requestId: "dispatch", at: CLOCK(), recipeVersionOf: () => version });
  assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
  if (!plan.ok) return;
  const params = plan.inputs[0]!.params;
  // The words point where the bytes go: reference1 is the first picture, which the encoder
  // labels "Picture 1" — and the snapshot keeps the author's own tokens for a re-run.
  assert.equal(params.prompt, "Picture 2 wears the coat from Picture 1, in the rain.");
  assert.deepEqual(params.references, ["artifacts/coat.png", "artifacts/ada.png"]);
  assert.equal(plan.reserved[0]!.request.brief, "@Image 2 wears the coat from @Image 1, in the rain.");
  assert.equal(plan.reserved[0]!.request.recipeVersion, version);
});

it("a Krea 2 re-run means the version its take was made with, and refuses another (issue 1083)", async () => {
  const { store, opened, compose, version } = await kreaBench();
  const first = planBenchDispatch(await compose("@Image 1 in the rain."), store.getBundle(), SHIPPED_MANIFEST,
    { worldId: store.worldId, requestId: "first", at: CLOCK(), recipeVersionOf: () => version });
  assert.ok(first.ok, first.ok ? undefined : first.reason);
  if (!first.ok) return;
  const reserved = first.reserved[0]!;
  await opened.store.append(
    { type: "takes-reserved", takes: [{ id: reserved.id, n: reserved.n, requestId: "first", request: reserved.request, createdAt: CLOCK() }] },
    { at: CLOCK() },
  );
  const made = (await opened.store.fold())!;
  const rerun = planBenchDispatch(made, store.getBundle(), SHIPPED_MANIFEST,
    { worldId: store.worldId, requestId: "again", at: CLOCK(), fromTake: made.takes[0]!, recipeVersionOf: () => version });
  assert.ok(rerun.ok, rerun.ok ? undefined : rerun.reason);
  if (rerun.ok) assert.equal(rerun.inputs[0]!.params.prompt, "Picture 1 in the rain.");
  // The catalogue has moved on: today's recipe would run under the take's old number. Refused
  // by name, the way a take of older production timing is.
  const advanced = planBenchDispatch(made, store.getBundle(), SHIPPED_MANIFEST,
    { worldId: store.worldId, requestId: "later", at: CLOCK(), fromTake: made.takes[0]!, recipeVersionOf: () => version + 1 });
  assert.equal(advanced.ok, false);
  if (!advanced.ok) assert.match(advanced.reason, /another version of Krea 2/);
});

it("the prompt cap is held against the words that travel, not only the brief (issue 1083)", async () => {
  const { store, model, compose } = await kreaBench();
  const cap = model.limits.maxPromptChars!;
  // Exactly at the cap as written; one over once "@Image 1" is named the way Krea 2 reads it.
  const brief = `@Image 1 ${"x".repeat(cap - "@Image 1 ".length)}`;
  assert.equal(brief.length, cap);
  const plan = planBenchDispatch(await compose(brief), store.getBundle(), SHIPPED_MANIFEST,
    { worldId: store.worldId, requestId: "capped", at: CLOCK() });
  assert.equal(plan.ok, false);
  if (!plan.ok) assert.match(plan.reason, new RegExp(`${cap + 1} characters; Krea 2 takes ${cap}`));
});

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

async function fileImage(dir: string, name: string, id: string, hash: string) {
  await mkdir(join(dir, "artifacts"), { recursive: true });
  await writeFile(join(dir, "artifacts", name), `bytes of ${name}`);
  await writeFile(
    join(dir, "artifacts", `${name}.json`),
    JSON.stringify({ id, kind: "image", file: name, hash, origin: { by: "user" }, links: [], created: CLOCK() }),
  );
}

/** A world with one filed image, scanned — the reference every lane test attaches. */
async function withImage(name = "frame.png") {
  const { dir, store } = await open();
  await store.ownedWrite(() =>
    fileImage(dir, name, `ar_${"01JKKKKKKKKKKKKKKKKKKKKKKK".slice(0, 26)}`, "sha256:deadbeefdeadbeef"),
  );
  const mine = store.getBundle().artifacts.find((a) => a.file === name);
  if (!mine) throw new Error("the filed sidecar did not scan");
  return { dir, store, artifactId: mine.id };
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

  it("creates an exact prefilled video session and reopens it without resetting edits", async () => {
    const dir = await makeTempWorld();
    const id = newId("sess") as SessionId;
    const first = await openBenchSession(dir, CLOCK, {
      sessionId: id,
      defaultModel: { provider: "fal", model: "test-video" },
      initial: { mode: "video", brief: "The bell rises through black water.", title: "Drowned bell" },
    });
    assert.equal(first?.session.id, id);
    assert.equal(first?.session.title, "Drowned bell");
    assert.equal(first?.session.composer.mode, "video");
    assert.equal(first?.session.composer.brief, "The bell rises through black water.");
    await first!.store.append(
      {
        type: "composer-set",
        mode: "video",
        provider: "fal",
        model: "test-video",
        params: { kind: "video", durationSec: 5 },
        brief: "Edited on the Bench.",
      },
      { at: CLOCK() },
    );
    const reopened = await openBenchSession(dir, CLOCK, {
      sessionId: id,
      initial: { mode: "video", brief: "The original brief." },
    });
    assert.equal(reopened?.session.composer.brief, "Edited on the Bench.");
  });
});

describe("reference allocation (issue 305 §4)", () => {
  async function withArtifact(kindFile: string, bytes = "png bytes") {
    const { dir, store } = await open();
    await store.ownedWrite(async () => {
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
    });
    const mine = store.getBundle().artifacts.find((a) => a.file === kindFile);
    if (!mine) throw new Error("the filed sidecar did not scan");
    return { dir, store, artifactId: mine.id };
  }

  /**
   * A character's pictures as reference sources (2026-08-18). The world holds far more pictures
   * than the artifacts folder — accepted identity, looks, candidates awaiting review, every take
   * ever generated — and none of them could be picked, because the source union was
   * artifact|take with nothing that could name a plain world file.
   */
  describe("a world file", () => {
    async function withPicture() {
      const { dir, store } = await withArtifact("quarter.png");
      await mkdir(join(dir, "references", "aurora-sabato", "candidates"), { recursive: true });
      await writeFile(join(dir, "references", "aurora-sabato", "candidates", "candidate-1.png"), Buffer.from("fake-png-bytes"));
      return { opened: await freshBench(dir), bundle: store.getBundle(), dir };
    }
    /** The host half, as coordinator.ts builds it: confine, then hash what was actually found. */
    const reader = (dir: string) => ({
      read: async (path: string) => {
        const root = resolve(dir);
        const target = resolve(root, path);
        if (target !== root && !target.startsWith(root + sep)) return { refused: "that file is not in this world" };
        try {
          const bytes = await readFile(target);
          return { hash: `sha256:${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}` };
        } catch {
          return { refused: "that picture is no longer in the world" };
        }
      },
    });

    it("attaches a character's picture and keys it by path", async () => {
      const { opened, bundle, dir } = await withPicture();
      const path = "references/aurora-sabato/candidates/candidate-1.png";
      const added = await addBenchReference(opened, bundle, IMAGE_MODEL, {
        source: { source: "world-file", path },
        worldFile: reader(dir),
        requestId: "r1",
        at: CLOCK(),
      });
      assert.deepEqual(added, { outcome: "added", token: "Image 1" });
      // The hash recorded is of the bytes found, not anything the caller claimed.
      const entry = (await refolded(opened))!.session.tokenRegistry.find((e) => e.token === "Image 1")!;
      assert.equal(entry.source.source, "world-file");
      assert.equal(
        (entry.source as { hash: string }).hash,
        `sha256:${createHash("sha256").update(Buffer.from("fake-png-bytes")).digest("hex").slice(0, 16)}`,
      );
    });

    it("refuses a path that resolves outside the world, and one that is not a picture", async () => {
      const { opened, bundle, dir } = await withPicture();
      const escape = await addBenchReference(opened, bundle, IMAGE_MODEL, {
        source: { source: "world-file", path: "../../secrets.png" },
        worldFile: reader(dir),
        requestId: "r2",
        at: CLOCK(),
      });
      assert.equal(escape.outcome, "refused");

      // A path alone cannot say how long a clip is, and the budget is spent in seconds.
      const clip = await addBenchReference(opened, bundle, IMAGE_MODEL, {
        source: { source: "world-file", path: "references/aurora-sabato/candidates/clip.mp4" },
        worldFile: reader(dir),
        requestId: "r3",
        at: CLOCK(),
      });
      assert.equal(clip.outcome, "refused");
      assert.match((clip as { reason: string }).reason, /only a picture/);
    });

    it("refuses when there is no reader at all rather than attaching an unread file", async () => {
      const { opened, bundle } = await withPicture();
      const outcome = await addBenchReference(opened, bundle, IMAGE_MODEL, {
        source: { source: "world-file", path: "references/aurora-sabato/candidates/candidate-1.png" },
        requestId: "r4",
        at: CLOCK(),
      });
      assert.equal(outcome.outcome, "refused");
    });
  });

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
    const model = { ...IMAGE_MODEL, limits: { ...IMAGE_MODEL.limits, maxReferenceAudioSec: 60, referenceAudioField: "audio_urls" } };
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

describe("citations in the brief (issue 476)", () => {
  /** A session with the world's one image attached and `brief` written over it. */
  async function withBrief(brief: string) {
    const { dir, store, artifactId } = await withImage();
    const opened = await freshBench(dir);
    const outcome = await addBenchReference(opened, store.getBundle(), IMAGE_MODEL, {
      source: { source: "artifact", artifactId },
      requestId: "r-add",
      at: CLOCK(),
    });
    assert.equal(outcome.outcome, "added");
    await opened.store.append(
      { type: "composer-set", mode: "image", provider: "fal", model: "test-image", params: { kind: "image", count: 1 }, brief },
      { at: CLOCK() },
    );
    return { store, opened };
  }

  const planFor = async (
    made: Awaited<ReturnType<typeof withBrief>>,
  ) =>
    planBenchDispatch((await made.opened.store.fold())!, made.store.getBundle(), MANIFEST, {
      worldId: made.store.worldId,
      requestId: "r1",
      at: CLOCK(),
    });

  it("a cited reference that is riding dispatches, and the words go out as written", async () => {
    const plan = await planFor(await withBrief("@Image 1, lit low"));
    assert.ok(plan.ok);
    if (plan.ok) {
      assert.equal(plan.reserved[0]!.request.brief, "@Image 1, lit low");
      assert.equal(plan.reserved[0]!.request.references[0]!.token, "Image 1");
      // The provider sees the author's own words, at-sign and all - one canonical spelling.
      assert.equal(plan.inputs[0]!.params.prompt, "@Image 1, lit low");
    }
  });

  it("a citation nothing is attached for refuses, by name, before anything is reserved", async () => {
    const plan = await planFor(await withBrief("@Image 3, lit low"));
    assert.equal(plan.ok, false);
    if (!plan.ok) {
      assert.match(plan.reason, /@Image 3/);
      assert.match(plan.reason, /not attached/);
    }
  });

  it("names every lost citation once, and only the lost ones", async () => {
    const plan = await planFor(await withBrief("@Image 1 with @Image 4 and @Image 4"));
    assert.equal(plan.ok, false);
    if (!plan.ok) {
      assert.equal(plan.reason.match(/@Image 4/g)?.length, 1);
      assert.doesNotMatch(plan.reason, /@Image 1/);
    }
  });

  it("leaves the older bare spelling alone - a brief from before mentions is not bound by one", async () => {
    const { dir, store } = await open();
    const opened = await freshBench(dir);
    await opened.store.append(
      { type: "composer-set", mode: "image", provider: "fal", model: "test-image", params: { kind: "image", count: 1 }, brief: "citing Image 3" },
      { at: CLOCK() },
    );
    const plan = planBenchDispatch((await opened.store.fold())!, store.getBundle(), MANIFEST, {
      worldId: store.worldId,
      requestId: "r1",
      at: CLOCK(),
    });
    assert.equal(plan.ok, true);
  });

  it("a re-run is judged against its own snapshot, not against what the composer holds now", async () => {
    const made = await withBrief("@Image 1, lit low");
    const first = await planFor(made);
    assert.ok(first.ok);
    if (!first.ok) return;
    const reserved = first.reserved[0]!;
    await made.opened.store.append(
      { type: "takes-reserved", takes: [{ id: reserved.id, n: reserved.n, requestId: "r1", request: reserved.request, createdAt: CLOCK() }] },
      { at: CLOCK() },
    );
    // The picture is taken off the bench afterwards; the take still means what it meant.
    await made.opened.store.append({ type: "reference-removed", token: "Image 1" }, { at: CLOCK() });
    const session = (await made.opened.store.fold())!;
    assert.deepEqual(session.composer.activeTokens, []);
    const rerun = planBenchDispatch(session, made.store.getBundle(), MANIFEST, {
      worldId: made.store.worldId,
      requestId: "r2",
      at: CLOCK(),
      fromTake: session.takes[0]!,
    });
    assert.ok(rerun.ok);
    if (rerun.ok) {
      assert.equal(rerun.reserved[0]!.request.brief, "@Image 1, lit low");
      assert.equal(rerun.reserved[0]!.request.references[0]!.token, "Image 1");
    }
  });

  it("names each citation by the place its picture takes on the wire (review, issue 476)", async () => {
    // Two pictures attached, the FIRST then taken off. The author still sees "@Image 2", because
    // a session token is never renumbered — but the provider is handed one image and counts from
    // one. Sent as written, the prompt asked a model with a single picture to look at its second.
    const { dir, store } = await open();
    await store.ownedWrite(async () => {
      await fileImage(dir, "first.png", newId("ar"), `sha256:${"a".repeat(64)}`);
      await fileImage(dir, "second.png", newId("ar"), `sha256:${"b".repeat(64)}`);
    });
    const idOf = (file: string) => store.getBundle().artifacts.find((a) => a.file === file)!.id;
    let opened = await freshBench(dir);
    for (const file of ["first.png", "second.png"]) {
      const outcome = await addBenchReference(opened, store.getBundle(), IMAGE_MODEL, {
        source: { source: "artifact", artifactId: idOf(file) },
        requestId: `add-${file}`,
        at: CLOCK(),
      });
      assert.equal(outcome.outcome, "added", `${file}: ${JSON.stringify(outcome)}`);
      // Allocation reads the session it is handed, so the second add needs the first one folded
      // in — otherwise both claim Image 1 and the case under test never arises.
      opened = (await refolded(opened))!;
    }
    await opened.store.append({ type: "reference-removed", token: "Image 1" }, { at: CLOCK() });
    await opened.store.append(
      { type: "composer-set", mode: "image", provider: "fal", model: "test-image", params: { kind: "image", count: 1 }, brief: "lit like @Image 2, cold" },
      { at: CLOCK() },
    );
    const session = (await opened.store.fold())!;
    assert.deepEqual(session.composer.activeTokens, ["Image 2"]);
    const plan = planBenchDispatch(session, store.getBundle(), MANIFEST, {
      worldId: store.worldId,
      requestId: "r1",
      at: CLOCK(),
    });
    assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
    if (plan.ok) {
      // The words the provider reads name the one image it is handed.
      assert.equal(plan.inputs[0]!.params.prompt, "lit like @Image 1, cold");
      assert.deepEqual(plan.inputs[0]!.params.references, ["artifacts/second.png"]);
      // The author's own words are what the take remembers, so a re-run redoes this arithmetic
      // against the snapshot's own references rather than inheriting a renamed prompt.
      assert.equal(plan.reserved[0]!.request.brief, "lit like @Image 2, cold");
      assert.equal(plan.reserved[0]!.request.references[0]!.token, "Image 2");
    }
  });

  it("reads no citation where the editor would have offered none (review, issue 476)", async () => {
    // Unbounded, these were both read as "@Image 1" and refused as stale citations — the worst
    // kind of refusal, because the words the author is told to fix were never meant as one.
    for (const brief of ["write to me@Image 1.example", "released @Image 1st of May"]) {
      const { dir, store } = await open();
      const opened = await freshBench(dir);
      await opened.store.append(
        { type: "composer-set", mode: "image", provider: "fal", model: "test-image", params: { kind: "image", count: 1 }, brief },
        { at: CLOCK() },
      );
      const plan = planBenchDispatch((await opened.store.fold())!, store.getBundle(), MANIFEST, {
        worldId: store.worldId,
        requestId: "r1",
        at: CLOCK(),
      });
      assert.equal(plan.ok, true, brief);
    }
  });

  it("the live composer, with the same picture taken off, refuses the words it left behind", async () => {
    const made = await withBrief("@Image 1, lit low");
    await made.opened.store.append({ type: "reference-removed", token: "Image 1" }, { at: CLOCK() });
    const plan = await planFor(made);
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.match(plan.reason, /@Image 1.*not attached/);
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

describe("deleting a take (design turn 180)", () => {
  const REQUEST = { mode: "image" as const, brief: "x", references: [], keyframes: [], provider: "fal", model: "test-image", params: { kind: "image" as const, count: 1 } };
  const exists = (path: string) => access(path).then(() => true, () => false);

  /** A session holding take 1 (landed, with a poster beside it) and take 2 (still running). */
  async function twoTakes() {
    const { dir } = await open();
    const opened = await freshBench(dir);
    const done = newId("tk"), out = newId("tk");
    await opened.store.append({ type: "takes-reserved", takes: [
      { id: done as never, n: 1, requestId: "r1", request: REQUEST, createdAt: CLOCK() },
      { id: out as never, n: 2, requestId: "r1/1", request: REQUEST, createdAt: CLOCK() },
    ] }, { at: CLOCK() });
    await opened.store.append({ type: "take-status", takeId: out as never, status: "running" }, { at: CLOCK() });
    const media = join(dir, sessionMediaDir(opened.session.id, done));
    await mkdir(media, { recursive: true });
    await writeFile(join(media, "output-1.png"), "x".repeat(2048));
    await writeFile(join(media, "output-1.poster.png"), "p".repeat(512));
    await opened.store.append({ type: "take-completed", takeId: done as never, media: { file: "output-1.png", hash: "sha256:00000000000000aa" as never }, completedAt: CLOCK() }, { at: CLOCK() });
    return { dir, opened, done, out, media };
  }

  it("names every file the confirm will list, the take's own first", async () => {
    const { dir, opened, done } = await twoTakes();
    assert.deepEqual(await benchTakeFiles(dir, opened.session.id, done, "output-1.png"), [
      { name: "output-1.png", bytes: 2048 },
      { name: "output-1.poster.png", bytes: 512 },
    ]);
    // A take that never landed anything has an empty list, not an error.
    assert.deepEqual(await benchTakeFiles(dir, opened.session.id, newId("tk")), []);
  });

  it("removes the take and its folder, keeps its number spent, and is idempotent by request", async () => {
    const { dir, opened, done, media } = await twoTakes();
    const outcome = await deleteBenchTake((await refolded(opened))!, dir, done, { requestId: "del-1", at: CLOCK() });
    assert.deepEqual(outcome, { deleted: true });
    assert.equal(await exists(media), false);
    const session = (await opened.store.fold())!;
    assert.deepEqual(session.takes.map((take) => take.n), [2]);
    assert.deepEqual(session.deletedTakes, [{ id: done, n: 1 }]);
    assert.equal(session.nextTake, 3, "the number is never handed out again");
    const again = await deleteBenchTake((await refolded(opened))!, dir, done, { requestId: "del-1", at: CLOCK() });
    assert.deepEqual(again, { deleted: true });
    const raw = await readFile(join(sessionDir(dir, opened.session.id), "events.jsonl"), "utf8");
    assert.equal(raw.split(/\r?\n/).filter((line) => line.includes("take-deleted")).length, 1);
  });

  it("refuses a take still out, and a filed take with its one clause, touching nothing", async () => {
    const { dir, opened, done, out, media } = await twoTakes();
    assert.deepEqual(await deleteBenchTake((await refolded(opened))!, dir, out, { requestId: "del-2", at: CLOCK() }), { deleted: false, reason: "Still generating" });
    await opened.store.append({ type: "take-filed", takeId: done as never, artifactId: newId("ar") as never }, { at: CLOCK() });
    assert.deepEqual(await deleteBenchTake((await refolded(opened))!, dir, done, { requestId: "del-3", at: CLOCK() }), { deleted: false, reason: "Filed — delete it from Artifacts" });
    assert.equal(await exists(media), true);
    assert.equal((await opened.store.fold())!.takes.length, 2);
  });

  it("finishes a delete a crash interrupted: the record landed, the folder did not go", async () => {
    const { dir, opened, done, media } = await twoTakes();
    await opened.store.append({ type: "take-deleted", takeId: done as never }, { at: CLOCK() });
    assert.equal(await exists(media), true);
    await sweepDeletedBenchMedia(dir, (await opened.store.fold())!);
    assert.equal(await exists(media), false);
  });
});

describe("upscaling a take (design turn 178)", () => {
  const VIDEO_REQUEST = { mode: "video" as const, brief: "a couple, slow camera move", references: [], keyframes: [], provider: "comfyui", model: "comfyui-h3-video-768", params: { kind: "video" as const, aspect: "16:9", durationSec: 7 } };

  async function videoTake(width: number, height: number) {
    const { dir, store } = await open();
    const opened = await freshBench(dir);
    const takeId = newId("tk");
    await opened.store.append({ type: "takes-reserved", takes: [{ id: takeId as never, n: 1, requestId: "r1", request: VIDEO_REQUEST, createdAt: CLOCK() }] }, { at: CLOCK() });
    await opened.store.append({ type: "take-completed", takeId: takeId as never, completedAt: CLOCK(),
      media: { file: "output-1.mp4", hash: "sha256:00000000000000aa" as never, info: { durationSec: 7.292, hasAudio: true, hasVideo: true, width, height, frameRate: 24 } } }, { at: CLOCK() });
    return { dir, store, opened, takeId };
  }

  it("reserves a new take naming its source, and one local job made from the source's file", async () => {
    const { store, opened, takeId } = await videoTake(1344, 768);
    const session = (await opened.store.fold())!;
    const plan = planBenchUpscale(session, SHIPPED_MANIFEST, { worldId: store.worldId, requestId: "up-1", takeId, at: CLOCK(), recipeVersionOf: () => 1, seed: 42 });
    assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
    if (!plan.ok) return;
    const [reserved] = plan.reserved;
    assert.equal(reserved!.n, 2, "the source keeps its number; the upscale takes the next");
    assert.notEqual(reserved!.id, takeId);
    assert.deepEqual(reserved!.request.upscale, {
      sourceTakeId: takeId, sourceN: 1, sourceHash: "sha256:00000000000000aa", size: "1080p", aspect: "16:9",
      from: { width: 1344, height: 768 }, to: { width: 1920, height: 1080 }, crop: { edge: "top and bottom", percent: 2 },
    });
    assert.equal(reserved!.request.model, "comfyui-seedvr2-upscale");
    assert.equal(reserved!.request.recipeVersion, 1);
    assert.equal(reserved!.request.requestedSeed, 42);
    const [input] = plan.inputs;
    assert.equal(input!.provider, "comfyui");
    assert.equal(input!.estimatedMicroUsd, 0);
    assert.deepEqual(input!.params, {
      size: "1080p", aspect: "16:9", seed: 42,
      videoReferences: [`${sessionMediaDir(session.id, takeId)}/output-1.mp4`],
      sourceHash: "sha256:00000000000000aa", sourceDurationSec: 7.292,
    });
    assert.equal(input!.landing.dir, sessionMediaDir(session.id, reserved!.id));
    // The reservation folds into a take that says where it came from, beside an untouched source.
    await opened.store.append({ type: "takes-reserved", takes: plan.reserved }, { at: CLOCK() });
    const after = (await opened.store.fold())!;
    assert.equal(after.takes.length, 2);
    assert.equal(after.takes[0]!.media?.file, "output-1.mp4");
  });

  it("refuses a take already at the size, a still, a take still out and a production session", async () => {
    const big = await videoTake(1920, 1080);
    const refused = planBenchUpscale((await big.opened.store.fold())!, SHIPPED_MANIFEST, { worldId: big.store.worldId, requestId: "up-2", takeId: big.takeId, at: CLOCK() });
    assert.deepEqual(refused, { ok: false, reason: "This take is not a video below 1080p" });
    const small = await videoTake(864, 480);
    const session = (await small.opened.store.fold())!;
    assert.deepEqual(planBenchUpscale(session, SHIPPED_MANIFEST, { worldId: small.store.worldId, requestId: "up-3", takeId: newId("tk"), at: CLOCK() }),
      { ok: false, reason: "That take is no longer in this session" });
    const subject = { ...session, subject: { kind: "shot" } } as never;
    assert.deepEqual(planBenchUpscale(subject, SHIPPED_MANIFEST, { worldId: small.store.worldId, requestId: "up-4", takeId: small.takeId, at: CLOCK() }),
      { ok: false, reason: "Upscale from the world bench" });
    const noUpscaler = { ...SHIPPED_MANIFEST, models: SHIPPED_MANIFEST.models.filter((model) => model.upscale === undefined) };
    assert.deepEqual(planBenchUpscale(session, noUpscaler, { worldId: small.store.worldId, requestId: "up-5", takeId: small.takeId, at: CLOCK() }),
      { ok: false, reason: "No upscaler is installed" });
  });

  it("an adapter take's upscale keeps the adapters on its record, never on the job", async () => {
    const { store, opened, takeId } = await videoTake(864, 480);
    const session = (await opened.store.fold())!;
    const adapters = [{ releaseId: "neutral-fixture", sha256: "a".repeat(64), strength: 0.5 }];
    const source = { ...session.takes[0]!, request: { ...session.takes[0]!.request, params: { kind: "video" as const, aspect: "16:9", durationSec: 7, adapters } } };
    const plan = planBenchUpscale({ ...session, takes: [source] }, SHIPPED_MANIFEST, { worldId: store.worldId, requestId: "up-7", takeId, at: CLOCK() });
    assert.ok(plan.ok);
    if (!plan.ok) return;
    // Adult-content visibility reads a take's params; a 1080p copy of an adapter take is that take.
    assert.deepEqual(plan.reserved[0]!.request.params, { kind: "video", aspect: "16:9", resolution: "1080p", adapters });
    assert.equal(plan.inputs[0]!.params["adapters"], undefined);
  });

  it("the upscaler is never a composer's model", async () => {
    const { dir, store } = await open();
    const opened = await freshBench(dir);
    await opened.store.append({ type: "composer-set", mode: "video", provider: "comfyui", model: "comfyui-seedvr2-upscale", params: { kind: "video" }, brief: "sharper" }, { at: CLOCK() });
    const plan = planBenchDispatch((await opened.store.fold())!, store.getBundle(), SHIPPED_MANIFEST, { worldId: store.worldId, requestId: "up-6", at: CLOCK() });
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.match(plan.reason, /upscales a take/);
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
      source: "bench" as const,
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
    assert.equal(first.generation?.source === "bench" ? first.generation.takeId : null, takeId);
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
    await store.ownedWrite(async () => {
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
    });
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
    await store.ownedWrite(async () => {
      await fileImage(dir, "two.png", `ar_${"01JNNNNNNNNNNNNNNNNNNNNNNN".slice(0, 26)}`, "sha256:beefbeefbeefbeef");
      await fileImage(dir, "three.png", `ar_${"01JPPPPPPPPPPPPPPPPPPPPPPP".slice(0, 26)}`, "sha256:feedfeedfeedfeed");
    });
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
    await store.ownedWrite(() =>
      fileImage(dir, "two.png", `ar_${"01JQQQQQQQQQQQQQQQQQQQQQQQ".slice(0, 26)}`, "sha256:beefbeefbeefbeef"),
    );
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

describe("presets (issue 305 §3)", () => {
  const settingsPath = async () => join(await makeTempWorld(), "settings.json");
  const PRESET_INPUT = {
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
    const saved = await file.savePreset(PRESET_INPUT, MANIFEST, CLOCK());
    assert.ok(saved.ok);
    if (saved.ok) {
      assert.equal(saved.preset.name, "Tide studies");
      assert.match(saved.preset.id, /^rcp_/);
    }

    // A fresh reader sees the same preset: settings.json is the record, not the cache.
    const reread = await new AppSettingsFile(path).load();
    assert.equal(reread.presets.length, 1);
    assert.equal(reread.presets[0]!.params.kind === "image" && reread.presets[0]!.params.count, 2);

    // Saving under the same name replaces — one gesture, one spelling, same identity.
    const replaced = await file.savePreset({ ...PRESET_INPUT, params: { kind: "image", count: 4 } }, MANIFEST, CLOCK());
    assert.ok(replaced.ok);
    const after = await new AppSettingsFile(path).load();
    assert.equal(after.presets.length, 1);
    if (saved.ok && replaced.ok) assert.equal(replaced.preset.id, saved.preset.id);
    assert.equal(after.presets[0]!.params.kind === "image" && after.presets[0]!.params.count, 4);
  });

  it("a model the manifest does not carry, or of the wrong capability, refuses with words", async () => {
    const file = new AppSettingsFile(await settingsPath());
    const unknown = await file.savePreset({ ...PRESET_INPUT, model: "gone" }, MANIFEST, CLOCK());
    assert.ok(!unknown.ok && /not in the model manifest/.test(unknown.reason));
    const wrongMode = await file.savePreset(
      { ...PRESET_INPUT, mode: "video", params: { kind: "video" } },
      MANIFEST,
      CLOCK(),
    );
    assert.ok(!wrongMode.ok && /is a image model, not video/.test(wrongMode.reason));
  });

  it("delete removes the one preset and leaves the rest", async () => {
    const path = await settingsPath();
    const file = new AppSettingsFile(path);
    const a = await file.savePreset(PRESET_INPUT, MANIFEST, CLOCK());
    const b = await file.savePreset({ ...PRESET_INPUT, name: "Night harbour" }, MANIFEST, CLOCK());
    assert.ok(a.ok && b.ok);
    if (a.ok) await file.deletePreset(a.preset.id);
    const after = await new AppSettingsFile(path).load();
    assert.deepEqual(after.presets.map((r) => r.name), ["Night harbour"]);
  });

  it("one unreadable preset drops alone rather than taking the settings file down", async () => {
    const path = await settingsPath();
    const file = new AppSettingsFile(path);
    await file.savePreset(PRESET_INPUT, MANIFEST, CLOCK());
    const raw = JSON.parse(await readFile(path, "utf8")) as { presets: unknown[]; models: unknown };
    raw.presets.push({ this: "is not a preset" });
    (raw as { models: { disabled: string[] } }).models = { disabled: ["something-off"] };
    await writeFile(path, JSON.stringify(raw));
    const reread = await new AppSettingsFile(path).load();
    assert.equal(reread.presets.length, 1, "the good preset survives");
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
    const ids: string[] = [];
    await store.ownedWrite(async () => {
      await mkdir(join(dir, "artifacts"), { recursive: true });
      for (const [i, name] of ["kf-a.png", "kf-b.png", "kf-c.png"].entries()) {
        await writeFile(join(dir, "artifacts", name), `bytes ${name}`);
        const id = `ar_01JW${"WWWWWWWWWWWWWWWWWWWWW"}${i}`;
        await writeFile(
          join(dir, "artifacts", `${name}.json`),
          JSON.stringify({ id, kind: "image", file: name, hash: `sha256:ab${i}dab${i}dab${i}dab${i}d`, origin: { by: "user" }, links: [], created: CLOCK() }),
        );
        ids.push(id);
      }
    });
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

describe("what a video dispatch may say about sound and length (asked for 2026-08-16)", () => {
  /** Declares both the audio switch and a reference route that runs shorter than the text one. */
  const SOUNDED: ManifestModel = {
    id: "test-sounded",
    provider: "fal",
    capability: "video",
    displayName: "Sounded Video",
    accepts: { referenceImages: 2, startFrame: false, endFrame: false },
    limits: {
      maxDurationSec: 10,
      durations: { 4: "4", 6: "6", 8: "8", 10: "10" },
      maxReferenceDurationSec: 6,
      soundChoice: true,
      resolutions: ["720p"],
      aspects: ["16:9"],
    },
    pricing: { kind: "perSecond", microUsdPerSecond: 100000 },
    modes: { generate: { locked: [] } },
  };
  /** The same row with neither declaration — the audio switch is not universal. */
  const MUTE: ManifestModel = {
    ...SOUNDED,
    id: "test-mute",
    displayName: "Mute Video",
    limits: { maxDurationSec: 10, durations: { 4: "4", 6: "6", 8: "8", 10: "10" }, resolutions: ["720p"], aspects: ["16:9"] },
  };
  const MANIFEST_2: ModelManifest = {
    manifestVersion: 1,
    generated: "2026-08-16",
    models: [IMAGE_MODEL, SOUNDED, MUTE],
  };

  async function planWith(model: ManifestModel, params: Record<string, unknown>, withReference: boolean) {
    const { dir, store, artifactId } = await withImage();
    const opened = await freshBench(dir);
    if (withReference) {
      await addBenchReference(opened, store.getBundle(), model, {
        source: { source: "artifact", artifactId },
        requestId: "r1",
        at: CLOCK(),
      });
    }
    await opened.store.append(
      {
        type: "composer-set",
        mode: "video",
        provider: "fal",
        model: model.id,
        params: { kind: "video", resolution: "720p", ...params },
        brief: "the tide going still",
      },
      { at: CLOCK() },
    );
    return planBenchDispatch((await opened.store.fold())!, store.getBundle(), MANIFEST_2, {
      worldId: store.worldId,
      requestId: "r2",
      at: CLOCK(),
    });
  }

  it("sends the audio choice only where the route publishes one", async () => {
    const sounded = await planWith(SOUNDED, { durationSec: 4, sound: false }, false);
    assert.ok(sounded.ok, sounded.ok ? undefined : sounded.reason);
    if (sounded.ok) assert.equal(sounded.inputs[0]!.params["sound"], false);
    // A preset saved against a model that has the switch, applied to one that does not: the
    // field is dropped rather than put on a route that never declared it.
    const mute = await planWith(MUTE, { durationSec: 4, sound: false }, false);
    assert.ok(mute.ok, mute.ok ? undefined : mute.reason);
    if (mute.ok) assert.ok(!("sound" in mute.inputs[0]!.params), "no audio field on a route without one");
  });

  it("refuses a length the reference route will not make, and says the references did it", async () => {
    // 8s is fine from text and beyond what this row's reference route makes.
    const free = await planWith(SOUNDED, { durationSec: 8 }, false);
    assert.ok(free.ok, free.ok ? undefined : free.reason);
    const held = await planWith(SOUNDED, { durationSec: 8 }, true);
    assert.equal(held.ok, false);
    if (!held.ok) {
      assert.match(held.reason, /at most 6s with references/);
      // The way out is named: the shot is reachable, just not with this attached.
      assert.match(held.reason, /remove them|shorten/);
    }
  });

  it("prices a reference job at the length its own route will run", async () => {
    const plan = await planWith(SOUNDED, { durationSec: 6 }, true);
    assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
    // 6s at $0.10/s, the length the reference route actually accepts.
    if (plan.ok) assert.equal(plan.inputs[0]!.estimatedMicroUsd, 600000);
  });
});

describe("reading a line on the bench (design 70)", () => {
  const VOICE: ManifestModel = {
    id: "test-tts",
    provider: "elevenlabs",
    capability: "voice-tts",
    displayName: "Test Voice",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    limits: {},
    pricing: { kind: "perCharacter", microUsdPerCharacter: 300 },
    // What a reader can do is its cadence row's alone (design turn 181).
    cadence: { deliveries: ["measured", "whispered", "breaking", "cold", "warm", "urgent"], speed: { min: 0.7, max: 1.2 }, pause: "best-effort-audio-tag",
      emphasis: "best-effort-capitalization", breath: "best-effort-audio-tag", outputTimestamps: "none", phrase: "best-effort-tag",
      deliveryMappings: { measured: { settings: { stability: 0.5 } }, whispered: { settings: { stability: 0.5 }, tag: "whispers" }, breaking: { settings: { stability: 0 }, tag: "crying" },
        cold: { settings: { stability: 1 }, tag: "coldly" }, warm: { settings: { stability: 0.5 }, tag: "warmly" }, urgent: { settings: { stability: 0 }, tag: "urgent" } } },
  };
  const VOICE_SIBLING: ManifestModel = {
    ...VOICE,
    id: "test-tts-sibling",
    displayName: "Test Voice Sibling",
    limits: { audioFormat: "wav" },
    cadence: { deliveries: ["urgent"], speed: null, pause: "unsupported", emphasis: "unsupported", breath: "unsupported", outputTimestamps: "none",
      deliveryMappings: { urgent: { settings: { stability: 0 } } } },
  };
  /** A local row, which maps far fewer deliveries than the cloud one. */
  const LOCAL: ManifestModel = {
    ...VOICE,
    id: "test-local-tts",
    provider: "kokoro",
    displayName: "Local Voice",
    limits: {},
    pricing: { kind: "unmetered" },
    cadence: { deliveries: ["measured", "urgent"], speed: null, pause: "best-effort-punctuation", emphasis: "unsupported", breath: "unsupported", outputTimestamps: "none",
      deliveryMappings: { measured: { settings: { speed: 0.92 } }, urgent: { settings: { speed: 1.15 } } } },
  };
  const CLONED: ManifestModel = {
    ...VOICE,
    id: "comfyui-cloned-voice",
    provider: "comfyui",
    displayName: "Local Cloned Voice",
    limits: { maxPromptChars: 400, audioFormat: "flac" },
    pricing: { kind: "unmetered" },
  };
  const MANIFEST_3: ModelManifest = {
    manifestVersion: 1,
    generated: "2026-08-17",
    models: [IMAGE_MODEL, VOICE_SIBLING, VOICE, LOCAL, CLONED],
  };
  const LINE = "The tide-clock keeps the drowned god's hours.";

  async function planVoice(model: ManifestModel, params: Record<string, unknown>, brief = LINE) {
    const { dir, store } = await open();
    const opened = await freshBench(dir);
    await opened.store.append(
      {
        type: "composer-set",
        mode: "voice",
        provider: model.provider,
        model: model.id,
        params: { kind: "voice", count: 1, ...params },
        brief,
      },
      { at: CLOCK() },
    );
    const bundle = model.provider === "comfyui"
      ? {
          ...store.getBundle(),
          clonedVoices: [{
            id: "harbour-glass", name: "Harbour glass", clip: "voices/harbour-glass.wav",
            description: "Low and dry", attributes: ["low", "dry"], consent: true, created: CLOCK(), language: "en",
          }],
        }
      : store.getBundle();
    return planBenchDispatch((await opened.store.fold())!, bundle, MANIFEST_3, {
      worldId: store.worldId,
      requestId: "v1",
      at: CLOCK(),
    });
  }

  it("sends the words themselves, and prices them exactly", async () => {
    const plan = await planVoice(VOICE, {
      voiceId: "vale",
      voiceProvider: VOICE.provider,
      voiceModel: VOICE.id,
      voiceLabel: "Vale",
    });
    assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
    if (plan.ok) {
      const params = plan.inputs[0]!.params;
      assert.equal(params["text"], LINE, "the brief IS the line, not a prompt describing it");
      assert.equal(params["voiceId"], "vale");
      assert.ok(!("prompt" in params), "nothing here is a prompt");
      // Exact, not a ceiling: 44 characters at 300 microUSD each. A duration estimate can only
      // guess; the characters are already typed.
      assert.equal(plan.inputs[0]!.estimatedMicroUsd, LINE.length * 300);
      assert.equal(plan.inputs[0]!.capability, "voice-tts", "the mode is voice; the capability is not");
      assert.equal(plan.inputs[0]!.model, VOICE.id, "a sibling model earlier in the manifest cannot take the voice");
      assert.equal(plan.inputs[0]!.params["audioFormat"], "mp3");
      assert.equal(plan.reserved[0]!.request.params.kind === "voice" && plan.reserved[0]!.request.params.voiceModel, VOICE.id);
    }
  });

  it("refuses a token dispatch whose displayed estimate is absent or below the current total", async () => {
    const { dir, store } = await open();
    const opened = await freshBench(dir);
    const model: ManifestModel = { ...VOICE, pricing: { kind: "perToken", microUsdPerMillionInput: 500000, microUsdPerMillionOutput: 9000000,
      speech: { tier: "standard", maxInputTokens: 8192, maxOutputTokens: 16384, audioTokensPerSecond: 25, rates: [
        { version: "intro", effectiveFrom: "2026-09-01T00:00:00Z", microUsdPerMillionInput: 500000, microUsdPerMillionOutput: 9000000 },
        { version: "standard", effectiveFrom: "2027-01-01T00:00:00Z", microUsdPerMillionInput: 1000000, microUsdPerMillionOutput: 18000000 },
      ] } } };
    await opened.store.append({ type: "composer-set", mode: "voice", provider: model.provider, model: model.id,
      params: { kind: "voice", count: 2, voiceId: "vale", voiceProvider: model.provider, voiceModel: model.id, voiceLabel: "Vale" }, brief: LINE }, { at: CLOCK() });
    const session = (await opened.store.fold())!;
    const plan = (at: string, confirmedMicroUsd?: number) => planBenchDispatch(session, store.getBundle(), { ...MANIFEST_3, models: [model] },
      { worldId: store.worldId, requestId: "token-consent", at, speechAuthorisation: { confirmedMicroUsd } });
    // The composer shows the estimate for both takes; each take's quote keeps the service-limit
    // authorisation as the dispatcher's cap, never the figure asked (SPEC-049 R-6).
    const each = quoteSpeech(model, LINE, { at: "2026-12-31T23:59:59Z" }).expectedMicroUsd;
    assert.ok(each < 151552 / 10, "an estimate from the words, not the ceiling");
    assert.equal(plan("2026-12-31T23:59:59Z").ok, false);
    assert.equal(plan("2026-12-31T23:59:59Z", each).ok, false, "one take's estimate cannot answer for two");
    const accepted = plan("2026-12-31T23:59:59Z", each * 2);
    assert.ok(accepted.ok, accepted.ok ? undefined : accepted.reason);
    assert.equal(accepted.inputs.reduce((sum, input) => sum + input.estimatedMicroUsd, 0), each * 2);
    const expired = plan("2027-01-01T00:00:00Z", each * 2);
    assert.equal(expired.ok, false);
    if (!expired.ok) assert.match(expired.reason, /price needs confirmation/);
  });

  it("refuses a voice target from a sibling model behind the same provider", async () => {
    const plan = await planVoice(VOICE, {
      voiceId: "vale",
      voiceProvider: VOICE.provider,
      voiceModel: VOICE_SIBLING.id,
    });
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.match(plan.reason, /another speech model/);
  });

  it("holds a delivery the reader cannot express, named on the take, never dropped in silence (design turn 181)", async () => {
    // Kokoro shapes pace only. "breaking" is held: left out of what is sent and named on the
    // take, where before it was refused — the composer shows it struck under Sent as first.
    const held = await planVoice(LOCAL, { voiceId: "af_heart", delivery: "breaking" });
    assert.ok(held.ok, held.ok ? undefined : held.reason);
    if (held.ok) {
      assert.equal(held.inputs[0]!.params["text"], LINE.replace(/\s+/g, " ").trim());
      assert.deepEqual(held.reserved[0]!.request.speech?.held, [{ control: "delivery", reason: "reads measured · urgent" }]);
    }
    // The same delivery on a row that maps it is compiled for that reader (design turn 181): its
    // tag in the words, its numbers beside them, and no delivery name for a client to tag again.
    const ok = await planVoice(VOICE, { voiceId: "vale", delivery: "breaking" });
    assert.ok(ok.ok, ok.ok ? undefined : ok.reason);
    if (ok.ok) {
      assert.deepEqual(ok.inputs[0]!.params["voiceSettings"], { stability: 0, speed: 1 }, "the direction reaches the wire");
      assert.match(String(ok.inputs[0]!.params["text"]), /^\[crying\] /);
      assert.equal(ok.inputs[0]!.params["delivery"], undefined);
      assert.equal(typeof ok.inputs[0]!.params["directionHash"], "string");
      assert.equal(ok.inputs[0]!.params["authoredText"], LINE, "the take's line is the words as written");
      assert.equal(ok.reserved[0]!.request.speech?.directionHash, ok.inputs[0]!.params["directionHash"]);
    }
  });

  it("sends a line's whole direction in the reader's syntax, and records what went (design turn 181)", async () => {
    const line = "Don’t you dare walk away from me, Ade. Not this time.";
    const after = (words: string) => line.indexOf(words) + words.length;
    const direction = {
      delivery: "cold", speed: 1, note: "angry and hurt",
      cues: [
        { kind: "pause", at: after("Ade."), length: "long" },
        { kind: "emphasis", span: { from: line.indexOf("this"), to: line.indexOf("this") + 4, text: "this" }, level: "strong" },
        { kind: "sound", at: line.length, sound: "sighs" },
      ],
    };
    const plan = await planVoice(VOICE, { voiceId: "vale", direction }, line);
    assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
    if (!plan.ok) return;
    const params = plan.inputs[0]!.params;
    assert.equal(params["text"], "[coldly] [angry and hurt] Don’t you dare walk away from me, Ade. [long pause] Not THIS time.");
    const speech = plan.reserved[0]!.request.speech!;
    assert.equal(speech.text, params["text"]);
    assert.deepEqual(speech.held, [{ control: "sound", reason: "no sounds" }], "the test row makes no sounds: held, never spoken");
    assert.match(speech.providerTextHash, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(plan.reserved[0]!.request.params, { kind: "voice", count: 1, voiceId: "vale", direction }, "the take keeps the direction as written");
  });

  // Found in the installed app on 2026-10-02: an English Breeze library voice had its sigh and
  // pause held, because only a cloned voice stated a language and Breeze writes tags only for a
  // line stated English (SPEC-046 R-23).
  it("an English library voice on a paren reader states its language, so its tags are written (design turn 181)", async () => {
    const breeze = SHIPPED_MANIFEST.models.find((row) => row.id === "breeze-tts-2")!;
    const line = "You came back.";
    const direction = { speed: 1, cues: [{ kind: "sound" as const, at: line.length, sound: "sighs" as const }] };
    const planned = async (voiceLanguage?: string) => {
      const { dir, store } = await open();
      const opened = await freshBench(dir);
      await opened.store.append({ type: "composer-set", mode: "voice", provider: breeze.provider, model: breeze.id,
        params: { kind: "voice", count: 1, voiceId: "abigail", ...(voiceLanguage !== undefined ? { voiceLanguage } : {}), direction }, brief: line }, { at: CLOCK() });
      return planBenchDispatch((await opened.store.fold())!, store.getBundle(), { ...MANIFEST_3, models: [...MANIFEST_3.models, breeze] },
        { worldId: store.worldId, requestId: "breeze", at: CLOCK() });
    };
    const english = await planned("en-US");
    assert.ok(english.ok, english.ok ? undefined : english.reason);
    if (english.ok) {
      assert.match(String(english.inputs[0]!.params["text"]), /\(sigh\)$/);
      assert.equal(english.inputs[0]!.params["language"], "en", "the job names the line's language, as Breeze routes by it");
      assert.deepEqual(english.reserved[0]!.request.speech!.held, []);
    }
    const unstated = await planned();
    assert.ok(unstated.ok, unstated.ok ? undefined : unstated.reason);
    if (unstated.ok) {
      assert.equal(unstated.inputs[0]!.params["text"], line, "a voice that lists no language is not assumed English");
      assert.equal(unstated.inputs[0]!.params["language"], undefined);
      assert.equal(unstated.reserved[0]!.request.speech!.held.length, 1);
    }
  });

  it("reads an older line's typed tags as markers, and refuses tags beside a direction (design turn 181)", async () => {
    // A take made before the turn, run again: its tag is the marker it names, never spoken.
    const older = await planVoice(VOICE, { voiceId: "vale", delivery: "cold" }, "Not this time. [long pause] Go.");
    assert.ok(older.ok, older.ok ? undefined : older.reason);
    if (older.ok) {
      assert.equal(older.inputs[0]!.params["text"], "[coldly] Not this time. [long pause] Go.");
      assert.equal(older.inputs[0]!.params["authoredText"], "Not this time. Go.");
    }
    const plan = await planVoice(VOICE, { voiceId: "vale", direction: { speed: 1, cues: [] } }, "Not this time. [sighs]");
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.match(plan.reason, /would be read aloud/);
    const kept = await planVoice(VOICE, { voiceId: "vale" }, "Say it [like a pirate] once.");
    assert.ok(kept.ok, "a bracket that is no marker is the author's words, kept as words");
  });

  it("will not read without a voice, and says which is missing", async () => {
    const plan = await planVoice(VOICE, {});
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.match(plan.reason, /No voice is chosen/);
  });

  it("resolves a cloned voice to the host reference seam without a clip path", async () => {
    const plan = await planVoice(CLONED, {
      voiceId: "harbour-glass",
      voiceProvider: "comfyui",
      voiceModel: "comfyui-cloned-voice",
      voiceLabel: "Harbour glass",
    });
    assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
    if (!plan.ok) return;
    assert.equal(plan.inputs[0]!.voiceReference, true);
    assert.equal("voiceReference" in plan.inputs[0]!.params, false);
    assert.equal("speakerFile" in plan.inputs[0]!.params, false);
  });

  it("asks for N reads the way image asks for N stills", async () => {
    const plan = await planVoice(VOICE, { voiceId: "vale", count: 3 });
    assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
    if (plan.ok) {
      assert.equal(plan.inputs.length, 3);
      assert.equal(plan.reserved.length, 3);
      // Each take records one read, not the batch it was asked for in.
      for (const take of plan.reserved) {
        assert.equal(take.request.params.kind === "voice" && take.request.params.count, 1);
      }
    }
  });

  it("refuses a picture model for a spoken line, naming both", async () => {
    const { dir, store } = await open();
    const opened = await freshBench(dir);
    await opened.store.append(
      {
        type: "composer-set",
        mode: "voice",
        provider: "fal",
        model: "test-image",
        params: { kind: "voice", count: 1, voiceId: "vale" },
        brief: LINE,
      },
      { at: CLOCK() },
    );
    const plan = planBenchDispatch((await opened.store.fold())!, store.getBundle(), MANIFEST_3, {
      worldId: store.worldId,
      requestId: "v2",
      at: CLOCK(),
    });
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.match(plan.reason, /is a image model; this is a voice request/);
  });
});

describe("a lane the mode has no use for rides along (found live, 2026-08-17)", () => {
  const VOICE_ROW: ManifestModel = {
    id: "test-tts-2",
    provider: "elevenlabs",
    capability: "voice-tts",
    displayName: "Test Voice",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    limits: {},
    pricing: { kind: "perCharacter", microUsdPerCharacter: 300 },
  };
  const MANIFEST_4: ModelManifest = {
    manifestVersion: 1,
    generated: "2026-08-17",
    models: [IMAGE_MODEL, VOICE_ROW],
  };

  it("does not refuse a spoken line over a picture the session was carrying", async () => {
    // The failure this prevents, seen in the installed app: a session that had carried a
    // reference for a shot refused every read with "Eleven v3 accepts no reference images" —
    // and voice mode hides the very lane that could have removed it, so the refusal named
    // something the user had no way to act on.
    const { dir, store, artifactId } = await withImage();
    const opened = await freshBench(dir);
    await addBenchReference(opened, store.getBundle(), IMAGE_MODEL, {
      source: { source: "artifact", artifactId },
      requestId: "r1",
      at: CLOCK(),
    });
    await opened.store.append(
      {
        type: "composer-set",
        mode: "voice",
        provider: "elevenlabs",
        model: "test-tts-2",
        params: { kind: "voice", count: 1, voiceId: "vale" },
        brief: "the tide-clock keeps the drowned god's hours",
      },
      { at: CLOCK() },
    );
    const plan = planBenchDispatch((await opened.store.fold())!, store.getBundle(), MANIFEST_4, {
      worldId: store.worldId,
      requestId: "r2",
      at: CLOCK(),
    });
    assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
    if (plan.ok) {
      // Ignored, not sent: the reference stays attached to the session for the modes that can
      // carry it, and nothing about it reaches a route that takes none.
      assert.ok(!("references" in plan.inputs[0]!.params), "no references on the wire");
      assert.equal(plan.reserved[0]!.request.references.length, 0, "and none recorded on the take");
    }
  });

  it("does not refuse a song over one either — music is the other mode that makes a sound", async () => {
    // Raised on review (issue 476). Music arrived a turn after the rule above was written and
    // never joined it: it hides the reference lane exactly as voice does, and its snapshot
    // refuses references outright, so a session carrying a picture refused every song over one
    // the author could no longer see, let alone remove. Same shape, same answer.
    const MUSIC_ROW: ManifestModel = {
      id: "test-music-2",
      provider: "fal",
      capability: "music",
      displayName: "Test Music",
      accepts: { referenceImages: 0, startFrame: false, endFrame: false },
      limits: {},
      pricing: { kind: "perSecond", microUsdPerSecond: 2000 },
    };
    const manifest: ModelManifest = {
      manifestVersion: 1,
      generated: "2026-08-26",
      models: [IMAGE_MODEL, MUSIC_ROW],
    };
    const { dir, store, artifactId } = await withImage();
    const opened = await freshBench(dir);
    await addBenchReference(opened, store.getBundle(), IMAGE_MODEL, {
      source: { source: "artifact", artifactId },
      requestId: "r1",
      at: CLOCK(),
    });
    await opened.store.append(
      {
        type: "composer-set",
        mode: "music",
        provider: "fal",
        model: "test-music-2",
        params: { kind: "music", count: 1, lyrics: "[verse]\nnobody wound it" },
        brief: "Slow sea shanty, close harmony",
      },
      { at: CLOCK() },
    );
    const plan = planBenchDispatch((await opened.store.fold())!, store.getBundle(), manifest, {
      worldId: store.worldId,
      requestId: "r2",
      at: CLOCK(),
    });
    assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
    if (plan.ok) {
      assert.ok(!("references" in plan.inputs[0]!.params), "no references on the wire");
      assert.equal(plan.reserved[0]!.request.references.length, 0, "and none recorded on the take");
    }
  });
});

describe("making a song on the bench (design turn 73)", () => {
  const MUSIC: ManifestModel = {
    id: "test-music",
    provider: "fal",
    capability: "music",
    displayName: "Test Music",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    limits: { durations: { "30": "30", "60": "60" }, durationWire: "number", maxDurationSec: 300 },
    pricing: { kind: "perSecond", microUsdPerSecond: 2000 },
  };
  const MANIFEST_M: ModelManifest = { manifestVersion: 1, generated: "2026-08-18", models: [IMAGE_MODEL, MUSIC] };
  const STYLE = "Slow sea shanty · close harmony · hand drum · minor key";
  const LYRICS = "[verse]\nThe tide-clock kept our hours and nobody wound it.";

  async function planMusic(params: Record<string, unknown>, brief = STYLE) {
    const { dir, store } = await open();
    const opened = await freshBench(dir);
    await opened.store.append(
      {
        type: "composer-set",
        mode: "music",
        provider: MUSIC.provider,
        model: MUSIC.id,
        params: { kind: "music", count: 1, lyrics: LYRICS, ...params },
        brief,
      },
      { at: CLOCK() },
    );
    return planBenchDispatch((await opened.store.fold())!, store.getBundle(), MANIFEST_M, {
      worldId: store.worldId,
      requestId: "m1",
      at: CLOCK(),
    });
  }

  it("sends the style as the prompt and the lyrics as their own field", async () => {
    const plan = await planMusic({});
    assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
    if (plan.ok) {
      const input = plan.inputs[0]!;
      assert.equal(input.capability, "music");
      assert.equal(input.params["prompt"], STYLE, "the style is the description, so it is the prompt");
      assert.equal(input.params["lyrics"], LYRICS, "the words that get sung ride as themselves");
      assert.ok(!("text" in input.params), "a song is not a spoken line");
    }
  });

  it("asks at the route's own default length, and prices that length exactly", async () => {
    const plan = await planMusic({});
    assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
    if (plan.ok) {
      // Sent, not omitted: a request that runs at the provider's default while the estimate was
      // computed from a number is the bug `durationParam` refuses.
      assert.equal(plan.inputs[0]!.params["durationSec"], MUSIC_DURATION_SEC);
      // 60s at 2000 microUSD/s. A ceiling, because the route stops when the song is done.
      assert.equal(plan.inputs[0]!.estimatedMicroUsd, MUSIC_DURATION_SEC * 2000);
      assert.equal(plan.inputs[0]!.estimatedMicroUsd, 120_000, "the $0.12 design turn 73 draws");
    }
  });

  it("refuses a song with no words, naming the half that is missing", async () => {
    const refused = await planMusic({ lyrics: "   " });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.reason, /no lyrics yet/);
  });

  it("still refuses when the style is the empty half", async () => {
    const refused = await planMusic({}, "  ");
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.reason, /empty brief/);
  });

  it("asks for as many songs as the count, each its own take", async () => {
    const plan = await planMusic({ count: 3 });
    assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
    if (plan.ok) {
      assert.equal(plan.inputs.length, 3);
      assert.equal(plan.reserved.length, 3);
      for (const input of plan.inputs) assert.equal(input.params["lyrics"], LYRICS);
    }
  });
});

describe("the lyrics helper drafts, and only drafts (design turn 73)", () => {
  it("carries the description and the style, and says which is which", () => {
    const brief = lyricistBrief({ description: "A farewell on the harbour wall", style: "Slow sea shanty" });
    assert.match(brief, /A farewell on the harbour wall/);
    assert.match(brief, /Slow sea shanty/);
    assert.match(brief, /whole of what it may say/, "the description bounds the content");
    assert.match(brief, /\{"lyrics": "\.\.\."\}/, "answers under its own key, not the enhancer's");
  });

  it("says so plainly when no style has been written yet", () => {
    const brief = lyricistBrief({ description: "A farewell on the harbour wall" });
    assert.match(brief, /No style has been written yet/);
    assert.ok(!brief.includes("undefined"), "an absent style is a sentence, not the word undefined");
  });

  it("treats a blank style as no style at all", () => {
    assert.match(lyricistBrief({ description: "x", style: "   " }), /No style has been written yet/);
  });

  it("does not carry the world's canon into a song", () => {
    // A rewritten image prompt describes what the world established; a verse ASSERTS. Canon
    // reaches the world through the accept gate, and a song is not that gate.
    const brief = lyricistBrief({ description: "A farewell", style: "shanty" });
    assert.match(brief, /Invent nothing the description did not state/);
  });
});
