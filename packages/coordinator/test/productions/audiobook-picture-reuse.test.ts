import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { type ArtifactBenchGeneration, type BenchReferenceToken, type DomainEvent } from "@arke-studio/contracts";
import { savedPicture, openSavedPicture } from "../../src/productions/audiobook-picture-reuse.js";
import { setAudiobookPicture } from "../../src/productions/audiobook-listening.js";
import { readAudiobook } from "../../src/productions/audiobook.js";
import { BenchStore, sessionDir } from "../../src/bench/store.js";
import { discoverBenchSessions } from "../../src/bench/service.js";
import { pngBytes } from "../queue/fake-provider.js";
import { CHAPTER, IMAGE, LEDGER, CLOCK, WORLD_ID, withHarness, type Harness } from "./picture-harness.js";

const ID = "ar_01J00000000000000000000001";
const REF = "ar_01J00000000000000000000002";
const SESSION = "sess_01J00000000000000000000001";
const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
const bytes = pngBytes();
const source = { artifactId: ID, hash: hash(bytes) };
const references: BenchReferenceToken[] = [
  { token: "Image 3", kind: "image", source: { source: "world-file", path: "artifacts/source.png", hash: hash(bytes) } },
  { token: "Image 7", kind: "image", sheetId: "maren-kest", source: { source: "world-file", path: "references/maren-kest/head-front.png", hash: hash(bytes) } },
];
const generation: ArtifactBenchGeneration = { source: "bench", sessionId: SESSION, takeId: "tk_01J00000000000000000000001", takeNumber: 1, brief: "Edit @Image 3. Keep the person in @Image 7.", provider: IMAGE.provider, model: IMAGE.id, params: { kind: "image", count: 3, aspect: "1:1" }, references, keyframes: [], costMicroUsd: 50000 };
async function prepare(dir: string) {
  await mkdir(join(dir, "artifacts"), { recursive: true });
  await mkdir(join(dir, "references/maren-kest"), { recursive: true });
  await writeFile(join(dir, "references/maren-kest/head-front.png"), bytes);
  for (const [id, file] of [[ID, "saved.png"], [REF, "source.png"]]) {
    await writeFile(join(dir, "artifacts", file!), bytes);
    await writeFile(join(dir, "artifacts", `${file}.json`), JSON.stringify({ id, kind: "image", file, hash: hash(bytes), origin: { by: "system", producedBy: "fixture" }, links: [], created: CLOCK, ...(id === ID ? { generation } : {}) }));
  }
}
const last = (events: DomainEvent[]) => events.filter((event): event is Extract<DomainEvent, { type: "audiobook.picture-made" }> => event.type === "audiobook.picture-made").at(-1)!;
const make = (h: Harness, price = 50000) => h.send({ kind: "make-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, block: "p0.0", prompt: generation.brief, who: [], reuse: source, confirmedMicroUsd: price, requestId: "01J00000000000000000000009" });
const choose = (h: Harness) => setAudiobookPicture(h.store()!, LEDGER, CHAPTER, "p0.0", { file: "artifacts/saved.png", source: "world" });

describe("saved Bench pictures retain their real inputs (#2143)", () => {
  it("opens a no-spend draft with exact ordered tokens, hashes, model and image controls; original remains untouched", () => withHarness(async h => {
    const before = await readFile(join(h.worldDir, "artifacts/saved.png.json"));
    const saved = await savedPicture(h.store()!, source, generation.brief);
    const opened = await openSavedPicture(h.store()!, saved, () => CLOCK);
    assert.deepEqual(opened.session.tokenRegistry, references);
    assert.deepEqual(opened.session.composer.activeTokens, ["Image 3", "Image 7"]);
    assert.equal(opened.session.composer.brief, generation.brief);
    assert.deepEqual(opened.session.composer.params, { kind: "image", aspect: "1:1", count: 1 });
    assert.equal(opened.session.composer.model, IMAGE.id);
    assert.deepEqual((await new BenchStore(sessionDir(h.worldDir, opened.session.id)).fold())!.tokenRegistry, references);
    assert.deepEqual(await readFile(join(h.worldDir, "artifacts/saved.png.json")), before);
    assert.equal(h.enqueued.length, 0);
  }, { prepare }));

  it("Make again quotes and sends both inputs in order and retains original media/provenance/narration", () => withHarness(async h => {
    await choose(h);
    const before = await readAudiobook(h.store()!, LEDGER, CHAPTER);
    const sidecar = await readFile(join(h.worldDir, "artifacts/saved.png.json"));
    await make(h);
    assert.equal(last(h.events).state, "made", last(h.events).reason);
    assert.equal(h.enqueued.length, 1);
    assert.equal(h.enqueued[0]!.estimatedMicroUsd, 50000);
    assert.deepEqual(h.enqueued[0]!.params.references, references.map(entry => entry.source.source === "world-file" ? entry.source.path : ""));
    const session = await new BenchStore(sessionDir(h.worldDir, last(h.events).sessionId! as never)).fold();
    assert.deepEqual(session!.takes[0]!.request.references, references);
    assert.equal(session!.takes[0]!.request.brief, generation.brief);
    assert.equal(session!.takes.length, 1);
    assert.equal(last(h.events).record!.pictures!["p0.0"]!.look, undefined, "no invented cast/look stamp");
    assert.deepEqual(last(h.events).record!.takes, before && before !== "unreadable" ? before.takes : {});
    assert.deepEqual(await readFile(join(h.worldDir, "artifacts/saved.png.json")), sidecar);
    assert.deepEqual(await readFile(join(h.worldDir, "artifacts/saved.png")), Buffer.from(bytes));
  }, { prepare }));

  for (const defect of ["changed", "missing", "selection", "price", "limit", "model"] as const) {
    it(`refuses ${defect} without dispatch or selection changes`, () => withHarness(async h => {
      await choose(h);
      if (defect === "changed") await writeFile(join(h.worldDir, "artifacts/source.png"), Buffer.concat([bytes, Buffer.from("changed")]));
      if (defect === "missing") await unlink(join(h.worldDir, "artifacts/source.png"));
      if (defect === "selection") await setAudiobookPicture(h.store()!, LEDGER, CHAPTER, "p0.0", null);
      const before = await readAudiobook(h.store()!, LEDGER, CHAPTER);
      await make(h, defect === "price" ? 40000 : 50000);
      assert.equal(last(h.events).state, "failed");
      assert.match(last(h.events).reason!, defect === "changed" ? /changed since/ : defect === "missing" ? /no longer/ : defect === "selection" ? /picture changed/ : defect === "price" ? /price moved/ : defect === "model" ? /no picture model/ : /reference|image/i);
      assert.equal(h.enqueued.length, 0);
      assert.deepEqual(await readAudiobook(h.store()!, LEDGER, CHAPTER), before);
    }, { prepare, ...(defect === "limit" ? { model: { ...IMAGE, accepts: { ...IMAGE.accepts, referenceImages: 1 } } } : defect === "model" ? { model: null } : {}) }));
  }

  it("supports artifact tokens and preserves keyframe lane without inferring a cast identity", () => withHarness(async h => {
    const artifact = h.store()!.getBundle().artifacts.find(item => item.id === ID)!;
    assert.equal(artifact.generation?.source, "bench");
    const g = artifact.generation as ArtifactBenchGeneration;
    g.references = [{ ...references[0]!, source: { source: "artifact", artifactId: REF, hash: hash(bytes) } }];
    g.keyframes = [references[1]!];
    const saved = await savedPicture(h.store()!, source, g.brief);
    const opened = await openSavedPicture(h.store()!, saved, () => CLOCK);
    assert.deepEqual(opened.session.composer.activeTokens, ["Image 3"]);
    assert.deepEqual(opened.session.composer.keyframeTokens, ["Image 7"]);
    assert.deepEqual(opened.session.tokenRegistry, [...g.references, ...g.keyframes]);
  }, { prepare }));

  it("carries a previous session take through its contained immutable file without renumbering", () => withHarness(async h => {
    await choose(h);
    await make(h);
    const previous = await new BenchStore(sessionDir(h.worldDir, last(h.events).sessionId! as never)).fold();
    const take = previous!.takes[0]!;
    const original = h.store()!.getBundle().artifacts.find(item => item.id === ID)!.generation as ArtifactBenchGeneration;
    original.sessionId = previous!.id;
    original.references = [{ token: "Image 9", kind: "image", source: { source: "take", takeId: take.id, hash: take.media!.hash } }];
    const saved = await savedPicture(h.store()!, source, original.brief);
    const expected = { ...original.references[0]!, source: { source: "world-file", path: `.sessions/${previous!.id}/media/${take.id}/${take.media!.file}`, hash: take.media!.hash } };
    assert.deepEqual(saved.references, [expected]);
    const reopened = await openSavedPicture(h.store()!, saved, () => CLOCK);
    assert.deepEqual(reopened.session.tokenRegistry, [expected]);
    assert.equal(h.enqueued.length, 1, "restoring the new draft spent nothing");
  }, { prepare }));

  it("does not overwrite a selection changed while a repeat was making", () => withHarness(async h => {
    const initial = await choose(h);
    await setAudiobookPicture(h.store()!, LEDGER, CHAPTER, "p0.0", { file: "artifacts/source.png", source: "world" });
    const changed = await readAudiobook(h.store()!, LEDGER, CHAPTER);
    await assert.rejects(setAudiobookPicture(h.store()!, LEDGER, CHAPTER, "p0.0", { file: "artifacts/saved.png", source: "generated" }, { expected: initial.pictures!["p0.0"]!, arke: true }), /picture changed/);
    assert.deepEqual(await readAudiobook(h.store()!, LEDGER, CHAPTER), changed);
  }, { prepare }));

  it("rejects absent provenance before creating any session", () => withHarness(async h => {
    const initial = await discoverBenchSessions(h.worldDir);
    await assert.rejects(savedPicture(h.store()!, { artifactId: REF, hash: hash(bytes) }, "Edit image"), /provenance is unavailable/);
    assert.deepEqual(await discoverBenchSessions(h.worldDir), initial);
  }, { prepare }));
});
