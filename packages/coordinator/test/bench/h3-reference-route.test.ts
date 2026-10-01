import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { newId, type BenchTake, type RecipeIdentity, type WorldBundle } from "@arke-studio/contracts";
import { SHIPPED_MANIFEST } from "@arke-studio/providers";
import { WorldStore } from "../../src/world/store.js";
import type { BenchStore } from "../../src/bench/store.js";
import { addBenchReference, openBenchSession, planBenchDispatch } from "../../src/bench/service.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
import { analyzePcmWav, audioHash } from "../../src/audio/qc.js";
import { wav } from "../audio/helpers.js";

/*
 * H3 Video's Reference lane (design turn 179): the pictures travel the reference route, each
 * named by a subject line Arke writes; the take records what was sent; a row without the route
 * refuses in one clause; a keyframe never rides beside them.
 */

const CLOCK = () => "2026-10-01T12:00:00.000Z";
const H3 = SHIPPED_MANIFEST.models.find((row) => row.id === "comfyui-h3-video")!;
const H3_768 = SHIPPED_MANIFEST.models.find((row) => row.id === "comfyui-h3-video-768")!;
const BRIEF = "The woman is @Image 1. Dimly lit luxurious bedroom at night, a couple, slow camera move.";

const hex = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function world() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return { dir, store };
}

/** Files a picture as an artifact; the sidecar's hash is the bytes' own. */
async function filePicture(dir: string, store: WorldStore, file: string, bytes = `bytes of ${file}`) {
  await store.ownedWrite(async () => {
    await mkdir(join(dir, "artifacts"), { recursive: true });
    await writeFile(join(dir, "artifacts", file), bytes);
    await writeFile(join(dir, "artifacts", `${file}.json`), JSON.stringify({
      id: newId("ar"), kind: "image", file, hash: `sha256:${hex(bytes)}`, origin: { by: "user" }, links: [], created: CLOCK(),
    }));
  });
  return store.getBundle().artifacts.find((artifact) => artifact.file === file)!;
}

const reader = (dir: string) => ({
  read: async (path: string) => {
    const root = resolve(dir), target = resolve(root, path);
    if (target !== root && !target.startsWith(root + sep)) return { refused: "that file is not in this world" };
    return { hash: `sha256:${hex(await readFile(target))}` };
  },
});

async function bench(dir: string, model = H3.id) {
  const opened = await openBenchSession(dir, CLOCK, { fresh: true, defaultModel: { provider: "comfyui", model } });
  assert.ok(opened);
  return opened;
}

async function compose(store: BenchStore, model: string, who?: Record<string, string>, brief = BRIEF) {
  await store.append({ type: "composer-set", mode: "video", provider: "comfyui", model,
    params: { kind: "video", durationSec: 15, aspect: "16:9", resolution: "480p", ...(who ? { who } : {}) }, brief }, { at: CLOCK() });
}

async function attach(opened: { store: BenchStore }, store: WorldStore, artifactId: string, model = H3, lane?: "keyframe") {
  const session = (await opened.store.fold())!;
  return addBenchReference({ store: opened.store, session }, store.getBundle(), model,
    { source: { source: "artifact", artifactId }, requestId: `attach-${artifactId}-${lane ?? "reference"}`, at: CLOCK(), ...(lane ? { lane } : {}) });
}

describe("H3 Video's Reference lane (design turn 179)", () => {
  it("prepends a subject line, translates the citation, and sends the route with the picture's hash", async () => {
    const { dir, store } = await world();
    const picture = await filePicture(dir, store, "dancer.png");
    const opened = await bench(dir);
    assert.equal((await attach(opened, store, picture.id)).outcome, "added");
    await compose(opened.store, H3.id, { "Image 1": "the woman" });
    const routes: Array<string | undefined> = [];
    const recipe: RecipeIdentity = { id: H3.id, version: 1, templateDigest: "b".repeat(64), dependencyDigest: "c".repeat(64), route: "reference" };
    const plan = planBenchDispatch((await opened.store.fold())!, store.getBundle(), SHIPPED_MANIFEST, {
      worldId: store.worldId, requestId: "route", at: CLOCK(),
      recipeVersionOf: (_model, route) => { routes.push(route); return route ? 1 : 2; },
      adapterRecipeFor: (_model, selections, route) => { routes.push(route); assert.deepEqual(selections, []); return recipe; },
    });
    assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
    if (!plan.ok) return;
    const params = plan.inputs[0]!.params;
    const prompt = "<Subject 1> is the woman, shown in <Picture 1>.\n" +
      "The woman is <Picture 1>. Dimly lit luxurious bedroom at night, a couple, slow camera move.";
    assert.equal(params.prompt, prompt);
    assert.equal(params.recipeRoute, "reference");
    assert.deepEqual(params.references, ["artifacts/dancer.png"]);
    assert.deepEqual(params.referenceHashes, [picture.hash]);
    assert.equal(params.taskMode, undefined);
    assert.deepEqual(routes, ["reference", "reference"]);
    const snapshot = plan.reserved[0]!.request;
    assert.equal(snapshot.brief, BRIEF, "the take keeps the author's own words");
    assert.equal(snapshot.recipeVersion, 1, "the route's version, not the parent's");
    assert.deepEqual(snapshot.recipe, recipe);
    assert.deepEqual(plan.inputs[0]!.recipe, recipe);
    assert.deepEqual(snapshot.referenceRoute, {
      route: "reference", prompt, pictures: [{ token: "Image 1", file: "dancer.png", hash: picture.hash, who: "the woman" }],
    });
  });

  it("a picture nobody named is the person; nothing else in the brief is rewritten", async () => {
    const { dir, store } = await world();
    const picture = await filePicture(dir, store, "dancer.png");
    const opened = await bench(dir);
    await attach(opened, store, picture.id);
    await compose(opened.store, H3.id, { "Image 1": "  " }, "Image 1 stays words; @Image 1 is cited.");
    const plan = planBenchDispatch((await opened.store.fold())!, store.getBundle(), SHIPPED_MANIFEST, { worldId: store.worldId, requestId: "default", at: CLOCK() });
    assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
    if (!plan.ok) return;
    assert.equal(plan.inputs[0]!.params.prompt,
      "<Subject 1> is the person, shown in <Picture 1>.\nImage 1 stays words; <Picture 1> is cited.");
  });

  it("a picture from a character's folder is that character, whatever was typed", async () => {
    const { dir, store } = await world();
    const sheet = store.getBundle().sheets[0]!;
    const path = `references/${sheet.id}/identity.png`;
    await store.ownedWrite(async () => {
      await mkdir(join(dir, "references", sheet.id), { recursive: true });
      await writeFile(join(dir, path), "a face");
    });
    const opened = await bench(dir);
    const outcome = await addBenchReference({ store: opened.store, session: (await opened.store.fold())! }, store.getBundle(), H3,
      { source: { source: "world-file", path }, worldFile: reader(dir), requestId: "cast", at: CLOCK() });
    assert.equal(outcome.outcome, "added", JSON.stringify(outcome));
    await compose(opened.store, H3.id, { "Image 1": "somebody else" });
    const plan = planBenchDispatch((await opened.store.fold())!, store.getBundle(), SHIPPED_MANIFEST, { worldId: store.worldId, requestId: "cast", at: CLOCK() });
    assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
    if (!plan.ok) return;
    assert.match(String(plan.inputs[0]!.params.prompt), new RegExp(`^<Subject 1> is ${sheet.name}, shown in <Picture 1>\\.\\n`));
    assert.equal(plan.reserved[0]!.request.referenceRoute!.pictures[0]!.who, sheet.name);
  });

  it("the lane admits what the node takes — nine pictures — not the first frame's budget", async () => {
    const { dir, store } = await world();
    const files: Array<Awaited<ReturnType<typeof filePicture>>> = [];
    for (let i = 1; i <= 10; i++) files.push(await filePicture(dir, store, `picture-${i}.png`));
    const opened = await bench(dir);
    for (const file of files.slice(0, 9)) assert.equal((await attach(opened, store, file.id)).outcome, "added", file.file);
    assert.equal((await attach(opened, store, files[9]!.id)).outcome, "refused", "a tenth picture is past the node's limit");
    // Nine pictures write nine subject lines, in tray order, ahead of the brief.
    await compose(opened.store, H3.id, undefined, "Nine people.");
    const nine = planBenchDispatch((await opened.store.fold())!, store.getBundle(), SHIPPED_MANIFEST, { worldId: store.worldId, requestId: "nine", at: CLOCK() });
    assert.ok(nine.ok, nine.ok ? undefined : nine.reason);
    if (nine.ok) {
      const lines = String(nine.inputs[0]!.params.prompt).split("\n");
      for (let n = 1; n <= 9; n++) assert.match(lines[n - 1]!, new RegExp(`^<Subject ${n}> is .+, shown in <Picture ${n}>\\.$`));
      assert.equal(lines[9], "Nine people.");
      assert.equal(nine.reserved[0]!.request.referenceRoute!.pictures.length, 9);
    }
  });

  it("H3 Video 768p keeps the picture and refuses in one clause", async () => {
    const { dir, store } = await world();
    const picture = await filePicture(dir, store, "dancer.png");
    const opened = await bench(dir);
    await attach(opened, store, picture.id);
    await opened.store.append({ type: "composer-set", mode: "video", provider: "comfyui", model: H3_768.id,
      params: { kind: "video", durationSec: 7, aspect: "16:9", resolution: "768p" }, brief: BRIEF }, { at: CLOCK() });
    const session = (await opened.store.fold())!;
    assert.deepEqual(session.composer.activeTokens, ["Image 1"], "the picture stays in the tray");
    const plan = planBenchDispatch(session, store.getBundle(), SHIPPED_MANIFEST, { worldId: store.worldId, requestId: "768", at: CLOCK() });
    assert.deepEqual(plan, { ok: false, reason: "H3 Video 768p takes no reference pictures yet" });
  });

  it("a keyframe and reference pictures do not ride one take", async () => {
    const { dir, store } = await world();
    const picture = await filePicture(dir, store, "dancer.png");
    const frame = await filePicture(dir, store, "frame.png");
    const opened = await bench(dir);
    await attach(opened, store, picture.id);
    assert.equal((await attach(opened, store, frame.id, H3, "keyframe")).outcome, "added");
    await compose(opened.store, H3.id);
    const plan = planBenchDispatch((await opened.store.fold())!, store.getBundle(), SHIPPED_MANIFEST, { worldId: store.worldId, requestId: "both", at: CLOCK() });
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.match(plan.reason, /References and keyframes cannot ride one request/);
  });

  it("the Keyframe lane alone is still H3 Video's first frame", async () => {
    const { dir, store } = await world();
    const frame = await filePicture(dir, store, "frame.png");
    const opened = await bench(dir);
    await attach(opened, store, frame.id, H3, "keyframe");
    await compose(opened.store, H3.id, undefined, "She turns to camera.");
    const plan = planBenchDispatch((await opened.store.fold())!, store.getBundle(), SHIPPED_MANIFEST, { worldId: store.worldId, requestId: "frame", at: CLOCK() });
    assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
    if (!plan.ok) return;
    assert.equal(plan.inputs[0]!.params.taskMode, "first-frame");
    assert.equal(plan.inputs[0]!.params.recipeRoute, undefined);
    assert.equal(plan.reserved[0]!.request.referenceRoute, undefined);
  });

  it("a re-run reuses the take's pictures and words by hash, and refuses a picture that changed", async () => {
    const { dir, store } = await world();
    const picture = await filePicture(dir, store, "dancer.png");
    const opened = await bench(dir);
    await attach(opened, store, picture.id);
    await compose(opened.store, H3.id, { "Image 1": "the woman" });
    const options = { worldId: store.worldId, requestId: "first", at: CLOCK() };
    const plan = planBenchDispatch((await opened.store.fold())!, store.getBundle(), SHIPPED_MANIFEST, options);
    assert.ok(plan.ok);
    if (!plan.ok) return;
    const take = { ...plan.reserved[0]!, status: "succeeded", disposition: "open", createdAt: CLOCK() } as BenchTake;
    // The composer has moved on: another label, another brief. The re-run is the take's.
    await compose(opened.store, H3.id, { "Image 1": "a stranger" }, "Something else entirely.");
    const again = planBenchDispatch((await opened.store.fold())!, store.getBundle(), SHIPPED_MANIFEST, { ...options, requestId: "again", fromTake: take });
    assert.ok(again.ok, again.ok ? undefined : again.reason);
    if (!again.ok) return;
    assert.equal(again.inputs[0]!.params.prompt, plan.inputs[0]!.params.prompt);
    assert.deepEqual(again.inputs[0]!.params.referenceHashes, [picture.hash]);
    // The same artifact id, other bytes: the take's picture is gone, and the re-run says so.
    await store.ownedWrite(async () => {
      await writeFile(join(dir, "artifacts", "dancer.png.json"), JSON.stringify({ ...picture, hash: `sha256:${hex("other bytes")}` }));
    });
    const changed = planBenchDispatch((await opened.store.fold())!, store.getBundle(), SHIPPED_MANIFEST, { ...options, requestId: "changed", fromTake: take });
    assert.deepEqual(changed, { ok: false, reason: "Image 1 has changed since this take. Generate a current take instead." });
  });

  it("a take made before the route existed is not re-run down it", async () => {
    const { dir, store } = await world();
    const picture = await filePicture(dir, store, "dancer.png");
    const opened = await bench(dir);
    await attach(opened, store, picture.id);
    await compose(opened.store, H3.id);
    const plan = planBenchDispatch((await opened.store.fold())!, store.getBundle(), SHIPPED_MANIFEST, { worldId: store.worldId, requestId: "now", at: CLOCK() });
    assert.ok(plan.ok);
    if (!plan.ok) return;
    const { referenceRoute: _dropped, ...older } = plan.reserved[0]!.request;
    void _dropped;
    const take = { ...plan.reserved[0]!, request: older, status: "succeeded", disposition: "open", createdAt: CLOCK() } as BenchTake;
    const rerun = planBenchDispatch((await opened.store.fold())!, store.getBundle(), SHIPPED_MANIFEST, { worldId: store.worldId, requestId: "old", at: CLOCK(), fromTake: take });
    assert.equal(rerun.ok, false);
    if (!rerun.ok) assert.match(rerun.reason, /another version of Local · H3 Video/);
  });
});

/*
 * A world Bench voices the characters its Cast pictures are (owner, 2026-10-01): a character with
 * an On screen voice rides as voice guidance on a route that takes audio, and stays home — without
 * refusing — on one that does not.
 */
describe("a Cast picture brings its character's On screen voice to a world Bench", () => {
  const R2V = SHIPPED_MANIFEST.models.find((row) => row.id === "comfyui-h3-reference-video")!;
  const voiced = (bundle: WorldBundle, sheetId: string): WorldBundle => {
    const next = structuredClone(bundle);
    let kit = next.referenceKits.find((candidate) => candidate.sheetId === sheetId);
    if (kit === undefined) {
      kit = { sheetId, tiles: [], compilations: [] } as unknown as (typeof next.referenceKits)[number];
      next.referenceKits.push(kit);
    }
    // A prepared sample as the voice page leaves one: one second of tone, measured by the real QC.
    const pcm = wav(Array.from({ length: 48_000 }, (_, i) => Math.round(Math.sin(i / 10) * 8000)));
    const report = analyzePcmWav(pcm, CLOCK()), outputHash = audioHash(pcm);
    kit.designatedVoiceSample = { schemaVersion: 1, file: `voice/${outputHash.replace(":", "-")}.wav`, operationId: randomUUID(), designatedAt: CLOCK(),
      warningCodes: [], attestations: [],
      provenance: { schemaVersion: 1, source: { kind: "legacy-character-sample", sheetId, sourceFile: "voice/clone.wav", legacySource: "cloning-recording",
        legacyDesignatedAt: CLOCK(), sourceMediaHash: outputHash }, sourceTechnical: report.technical, outputHash, outputTechnical: report.technical,
        preparation: [], qualityReport: report, createdAt: CLOCK() } } as never;
    return next;
  };

  it("rides H3 Reference Video as @Audio guidance, and stays out of H3 Video without refusing", async () => {
    const { dir, store } = await world();
    const sheet = store.getBundle().sheets.find((candidate) => candidate.type === "character")!;
    const path = `references/${sheet.id}/identity.png`;
    await store.ownedWrite(async () => {
      await mkdir(join(dir, "references", sheet.id), { recursive: true });
      await writeFile(join(dir, path), "a face");
    });
    const bundle = voiced(store.getBundle(), sheet.id);
    for (const [row, rides] of [[R2V, true], [H3, false]] as const) {
      const opened = await bench(dir, row.id);
      const outcome = await addBenchReference({ store: opened.store, session: (await opened.store.fold())! }, bundle, row,
        { source: { source: "world-file", path }, worldFile: reader(dir), requestId: `cast-${row.id}`, at: CLOCK() });
      assert.equal(outcome.outcome, "added", JSON.stringify(outcome));
      await compose(opened.store, row.id, undefined, "She says: \"You think money fixes everything?\"");
      const plan = planBenchDispatch((await opened.store.fold())!, bundle, SHIPPED_MANIFEST, { worldId: store.worldId, requestId: `voice-${row.id}`, at: CLOCK() });
      assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
      if (!plan.ok) continue;
      const audio = plan.reserved[0]!.request.audioReferences;
      if (rides) {
        assert.deepEqual(audio?.references.map((ref) => [ref.characterName, ref.label]), [[sheet.name, "@Audio1"]]);
        assert.ok(String(plan.inputs[0]!.params.prompt).includes(
          `${sheet.name} uses <Audio 1> as voice guidance. Speak the scene's authored dialogue; do not repeat the audio reference's words.`));
      } else {
        assert.equal(audio, undefined, "H3 Video takes no audio, so the voice stays home");
        assert.doesNotMatch(String(plan.inputs[0]!.params.prompt), /voice guidance/);
      }
    }
  });
});
