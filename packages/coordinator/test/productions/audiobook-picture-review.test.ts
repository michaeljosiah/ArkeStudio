import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it, mock } from "node:test";
import { DEFAULT_NARRATOR, lookDigest, lookLinesFor, pictureLookChanged, pictureLookFor, type ChapterAudiobook, type AudiobookLook } from "@arke-studio/contracts";
import { audiobookPath, planAudiobook, readAudiobook, writeAudiobook } from "../../src/productions/audiobook.js";
import { setAudiobookPicture } from "../../src/productions/audiobook-listening.js";
import { openChapter } from "../../src/productions/ops.js";
import { ProseAuthoringService } from "../../src/application/prose-authoring.js";
import { WorldStore } from "../../src/world/store.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

const AT = "2026-10-20T00:00:00Z";
const look: AudiobookLook = { chapterHash: "look-source", at: AT, characters: { "maren-kest": { name: "Maren", text: "Grey coat." } } };
async function setup() {
  const dir = await makeTempWorld(), store = await WorldStore.open(dir); closeOnCleanup(() => store.close());
  const production = "the-ledger-of-nights", chapter = store.getBundle().productions.find(row => row.meta.id === production)!.chapters[0]!;
  const opened = await openChapter(store, production, chapter.id);
  const body = "The first lamp stays lit.\n\nThe second lamp stays dark.";
  await new ProseAuthoringService(store).save(production, chapter.file, body, { baseHash: opened.hash });
  const plan = await planAudiobook(store, production, chapter.id, { narrator: DEFAULT_NARRATOR });
  await setAudiobookPicture(store, production, chapter.file, "p0.0", { file: "world-art.png", source: "generated" }, { arke: true, look: pictureLookFor(look, ["maren-kest"])!, shot: { frame: "Close-up", inFrame: ["maren-kest"], notInFrame: [], expressions: {}, details: [], checks: [] } });
  const record = await readAudiobook(store, production, chapter.file) as ChapterAudiobook;
  record.look = { ...look, characters: { "maren-kest": { name: "Maren", text: "Grey coat with marked cuffs." } } };
  const picture = record.pictures!["p0.0"]!;
  picture.focus = { x: 0.3, y: 0.7 };
  picture.motion = { artifactId: "ar_01J8G000000000000000000003", file: "artifacts/retained.mp4", seconds: 5, width: 864, height: 480, sourceHash: `sha256:${"a".repeat(64)}`, sourceAt: picture.at, behavior: "hold", active: true };
  picture.motionCandidate = { ...picture.motion, active: false };
  await writeAudiobook(store, production, chapter.file, record);
  const recordPath = join(dir, audiobookPath(production, chapter.file));
  const choose = (block = "p0.0") => setAudiobookPicture(store, production, chapter.file, block, { file: "world-art.png", source: "world" });
  return { dir, store, production, chapter, plan, record, recordPath, choose, body };
}

it("reaffirms the same current picture, preserves every generation/media field and raises its reader boundary", async () => {
  const h = await setup(), old = h.record.pictures!["p0.0"]!;
  assert.ok(pictureLookChanged(old.look, h.record.look));
  assert.ok((await readWorldMeta(h.dir)).schemaVersion < 105);
  const after = await h.choose(), kept = after.pictures!["p0.0"]!;
  const { lookReview, ...original } = kept;
  assert.deepEqual(original, old);
  assert.deepEqual(after.takes, h.record.takes); assert.deepEqual(after.flags, h.record.flags);
  assert.equal(lookReview?.hash, lookDigest(lookLinesFor(h.record.look, old.look!.who, old.look!.looks)));
  assert.equal(pictureLookChanged(kept.look, after.look, undefined, kept.lookReview), false);
  assert.equal((await readWorldMeta(h.dir)).schemaVersion, 105);
  assert.deepEqual((await readAudiobook(h.store, h.production, h.chapter.file) as ChapterAudiobook).pictures, after.pictures);
  const again = await h.choose(); assert.deepEqual(again.pictures, after.pictures, "repeated choice preserves the first review time");
  const replacement = await setAudiobookPicture(h.store, h.production, h.chapter.file, "p0.0", { file: "artifacts/board-v2.png", source: "world" });
  assert.equal(replacement.pictures!["p0.0"]!.lookReview, undefined); assert.equal(replacement.pictures!["p0.0"]!.look, undefined);
  const cleared = await setAudiobookPicture(h.store, h.production, h.chapter.file, "p0.0", null); assert.equal(cleared.pictures, undefined);
});

it("finds a shifted same-file picture by its exact current words, preserving its provenance", async () => {
  const h = await setup(), opened = await openChapter(h.store, h.production, h.chapter.id);
  await new ProseAuthoringService(h.store).save(h.production, h.chapter.file, "A new warning arrives.\n\n" + h.body, { baseHash: opened.hash });
  const after = await h.choose("p1.0"), { lookReview, ...original } = after.pictures!["p1.0"]!;
  assert.ok(lookReview); assert.deepEqual(original, h.record.pictures!["p0.0"]); assert.equal(after.pictures!["p0.0"], undefined);
});

for (const change of ["selection", "look"] as const) it(`refuses a ${change} changed at the owned-write boundary without losing the concurrent edit`, async () => {
  const h = await setup();
  await h.store.ensureSchemaVersion(105, "test-review-boundary");
  const changed = structuredClone(h.record);
  if (change === "selection") changed.pictures!["p0.0"]!.file = "artifacts/board-v2.png";
  else changed.look!.characters["maren-kest"]!.text = "A red coat.";
  const bytes = JSON.stringify(changed), write = h.store.ownedWrite.bind(h.store);
  const boundary = mock.method(h.store, "ownedWrite", async (operation: () => Promise<unknown>) => {
    await writeFile(h.recordPath, bytes, "utf8");
    return write(operation);
  });
  try {
    await assert.rejects(h.choose(), /picture or its look changed/);
    assert.equal(await readFile(h.recordPath, "utf8"), bytes);
  } finally { boundary.mock.restore(); }
});
