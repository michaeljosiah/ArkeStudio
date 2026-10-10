import assert from "node:assert/strict";
import { it } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ManifestModel } from "@arke-studio/contracts";
import { FsWorldProvider } from "../../src/world/provider.js";
import { fileArtifact } from "../../src/artifacts/filing.js";
import { setAudiobookPicture } from "../../src/productions/audiobook-listening.js";
import {
  chooseAudiobookMotion,
  quoteAudiobookMotion,
  saveAudiobookMotionCandidate,
} from "../../src/productions/audiobook-motion.js";
import { withHarness, CHAPTER, LEDGER } from "./picture-harness.js";
import { readAudiobook } from "../../src/productions/audiobook.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

const model: ManifestModel = {
  id: "motion",
  displayName: "Motion",
  provider: "comfyui",
  capability: "video",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { durations: { "5": "5" } },
  pricing: { kind: "unmetered" },
  modes: { "first-frame": { locked: [] } },
};
const book = "the-ledger-of-nights",
  chapter = "01-neap",
  block = "p0.0";

it("reads timing Activity status without building or inspecting a listening plan", () => withHarness(async (h) => {
  const store = h.store()!;
  const getBundle = store.getBundle;
  store.getBundle = () => { throw new Error("Activity status must not inspect production media"); };
  try {
    await h.send({ kind: "audiobook-word-timing", worldId: WORLD_ID, productionId: LEDGER, action: "status", requestId: "01J00000000000000000000001" });
    const answer = h.events.find(event => event.type === "audiobook.word-timing");
    assert.ok(answer?.type === "audiobook.word-timing");
    assert.equal(answer.state.running, false);
    assert.deepEqual(answer.state.blocks, []);
    assert.equal(h.enqueued.length, 0);
  } finally { store.getBundle = getBundle; }
}));

it("saves a candidate durably without replacing the still, then uses/reverts it without deleting the artifact", async () => {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root);
  await provider.loadWorld(WORLD_ID);
  const store = provider.openStore!()!;
  try {
    await setAudiobookPicture(store, book, chapter, block, { file: "world-art.png", source: "world" });
    const quote = await quoteAudiobookMotion(
      store,
      book,
      chapter,
      block,
      model,
      { kind: "video", durationSec: 5 },
      "A lamp moves gently.",
    );
    const source = join(root, "motion.mp4");
    await writeFile(source, "synthetic clip for a persistence test");
    const filed = await fileArtifact(store, {
      sourcePath: source,
      mediaProbe: {
        durationSec: async () => 5,
        info: async () => ({ durationSec: 5, width: 864, height: 480, hasVideo: true, hasAudio: true }),
      },
    });
    assert.ok(filed.outcome === "filed");
    const saved = await saveAudiobookMotionCandidate(store, book, chapter, block, quote, filed.artifact.id);
    assert.equal(saved.pictures?.[block]?.file, "world-art.png");
    assert.equal(saved.pictures?.[block]?.motion, undefined);
    assert.equal(saved.pictures?.[block]?.motionCandidate?.active, false);
    assert.equal(store.getBundle().meta.schemaVersion, 73);
    const chosen = await chooseAudiobookMotion(
      store,
      book,
      chapter,
      block,
      "candidate",
      "repeat",
      filed.artifact.id,
    );
    assert.equal(chosen.pictures?.[block]?.motion?.active, true);
    assert.equal(chosen.pictures?.[block]?.motionCandidate, undefined);
    const still = await chooseAudiobookMotion(store, book, chapter, block, "still", "repeat");
    assert.equal(still.pictures?.[block]?.motion?.active, false);
    assert.ok(store.getBundle().artifacts.some((a) => a.id === filed.artifact.id));
    await writeFile(join(worldDir, "world-art.png"), "replacement bytes");
    await assert.rejects(
      saveAudiobookMotionCandidate(store, book, chapter, block, quote, filed.artifact.id),
      /source picture changed/,
    );
    await assert.rejects(
      chooseAudiobookMotion(store, book, chapter, block, "candidate", "repeat", filed.artifact.id),
      /source picture changed/,
    );
  } finally {
    await provider.close();
  }
});


it("quotes without spending, refuses a changed ceiling, and dispatches exactly one first-frame job before explicit adoption", () => withHarness(async (h) => {
  const ids = { worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, block: "p0.0", requestId: "01J00000000000000000000001" };
  await setAudiobookPicture(h.store()!, LEDGER, CHAPTER, "p0.0", { file: "world-art.png", source: "world" });
  await h.send({ kind: "quote-audiobook-motion", ...ids, model: "motion", params: { kind: "video", durationSec: 5 }, prompt: "A gentle movement." });
  const response = h.events.find((event) => event.type === "audiobook.motion" && event.state === "quoted");
  assert.ok(response?.type === "audiobook.motion" && response.quote, JSON.stringify(h.events));
  assert.equal(h.enqueued.length, 0);
  await h.send({ kind: "make-audiobook-motion", ...ids, quote: { ...response.quote, estimatedMicroUsd: 0 } });
  assert.equal(h.enqueued.length, 0);
  assert.ok(h.events.some((event) => event.type === "audiobook.motion" && event.reason?.includes("price changed")));
  await h.send({ kind: "make-audiobook-motion", ...ids, requestId: "01J00000000000000000000002", quote: response.quote });
  assert.equal(h.enqueued.length, 1, JSON.stringify(h.events));
  const record = await readAudiobook(h.store()!, LEDGER, CHAPTER);
  assert.ok(record !== null && record !== "unreadable");
  assert.equal(record.pictures?.["p0.0"]?.motion, undefined);
  assert.ok(record.pictures?.["p0.0"]?.motionCandidate);
  assert.equal(record.pictures?.["p0.0"]?.file, "world-art.png");
  assert.ok(h.events.some((event) => event.type === "audiobook.motion" && event.state === "review"), JSON.stringify(h.events));
  await h.send({ kind: "choose-audiobook-motion", ...ids, choice: "candidate", behavior: "hold", artifactId: record.pictures!["p0.0"]!.motionCandidate!.artifactId });
  assert.ok(h.events.some((event) => event.type === "audiobook.motion" && event.state === "chosen"));
}, { model: { ...model, provider: "fal", accepts: { referenceImages: 0, startFrame: true, endFrame: false }, pricing: { kind: "perSecond", microUsdPerSecond: 10000 } }, videoOutput: true }));
