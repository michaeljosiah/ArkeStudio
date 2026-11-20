import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { orderedShots, type AudioSpineCommand, type SpineMarker } from "@arke-studio/contracts";
import { fileArtifact } from "../../src/artifacts/filing.js";
import { applyProductionSpineCommand, previewAudioSpineCommand, songTime } from "../../src/productions/spine.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";

/**
 * What a spine card says (issue 3092). It named the song by its artifact id, its length as
 * "227.639979s measured audio", an import as "Import 12 JSON markers", each marker as its JSON,
 * and described the engine underneath: a person approving it could not tell which song, or which
 * part of it, they were agreeing to.
 */

const PRODUCTION = "saltlight";
const SONG = "why-you-do-me-like-that.mp3";
const probe = { async durationSec() { return 227.639979; }, async info() { return { durationSec: 227.639979, hasAudio: true }; } };

async function songWorld(t: TestContext) {
  const store = await WorldStore.open(await makeTempWorld()); t.after(() => store.close());
  const source = join(store.dir, SONG); await writeFile(source, "song fixture");
  const filed = await fileArtifact(store, { sourcePath: source, mediaProbe: probe, production: PRODUCTION });
  assert.ok(filed.outcome === "filed");
  return { store, song: filed.artifact.id };
}

const preview = (store: WorldStore, baseRevision: number | null, command: AudioSpineCommand) =>
  previewAudioSpineCommand(store.getBundle(), { productionId: PRODUCTION, baseRevision, command }, store.now());

it("names the song by its file and length, and says nothing of the engine", async t => {
  const { store, song } = await songWorld(t);
  const card = preview(store, null, { kind: "create", trackArtifactId: song });
  assert.equal(card.title, `Use ${SONG} as the song · 3:47`, "a player's length: 227.6s is 3:47, not 3:48");
  assert.deepEqual(card.commands, [{ label: `Use ${SONG} as the song`, detail: "3:47" }]);
  assert.equal(card.consequence, "The Cut plays to this song.");
  const said = JSON.stringify([card.title, card.consequence, card.commands, card.expectedResult]);
  assert.doesNotMatch(said, /ar_|authority|version-fenced|spine|measured/);
});

it("counts the sections and lyrics it marks, and names each one by its words and time", async t => {
  const { store, song } = await songWorld(t);
  await applyProductionSpineCommand(store, { productionId: PRODUCTION, baseRevision: null, command: { kind: "create", trackArtifactId: song } }, { source: "test" });
  const sections = ["Intro", "Verse 1", "Pre-chorus", "Chorus", "Verse 2", "Chorus", "Bridge", "Chorus", "Outro"];
  const markers: SpineMarker[] = [
    ...sections.map((label, index): SpineMarker => ({ kind: "section", id: `mk_01J8G${"0".repeat(19)}S${index}`, label, atSec: index * 24 + 0.5, source: "json" })),
    ...[16, 44, 62.25].map((atSec, index): SpineMarker => ({ kind: "lyric", id: `mk_01J8G${"0".repeat(19)}A${index}`, text: "Why you do me like that", atSec, source: "json" })),
  ];
  const card = preview(store, 1, { kind: "import-markers", format: "json", markers });
  assert.equal(card.title, "Mark 9 sections and 3 lyrics");
  assert.deepEqual(card.commands[0], { label: "Intro", detail: "section at 0:00.5" });
  assert.ok(card.commands.some(row => row.label === "“Why you do me like that”" && row.detail === "lyric at 1:02.25"));
  assert.equal(card.consequence, "Changes the song's sections and lyrics.");
  assert.doesNotMatch(JSON.stringify(card.commands), /mk_|"kind"|source/);
});

it("pins a shot by its number and scene, at a time in the song", async t => {
  const { store, song } = await songWorld(t);
  await applyProductionSpineCommand(store, { productionId: PRODUCTION, baseRevision: null, command: { kind: "create", trackArtifactId: song } }, { source: "test" });
  const scene = store.getBundle().productions.find(p => p.meta.id === PRODUCTION)!.scenes[0]!;
  const shot = orderedShots(scene)[0]!;
  const card = preview(store, 1, { kind: "set-anchor", shotId: shot.id, anchor: { startSec: 12, endSec: 18.5, clipAudio: { mode: "mute" } } });
  assert.equal(card.title, `Pin shot ${shot.number} of ${scene.title} to 0:12–0:18.5`);
  assert.deepEqual(card.commands, [{ label: `Pin shot ${shot.number} of ${scene.title}`, detail: "0:12–0:18.5" }]);
});

// Removing a pinned scene's four shots took an unpin card for each (issue 3136).
it("unpins several shots on one card, saying how many, of which scene and where each was", async t => {
  const { store, song } = await songWorld(t);
  const spine = () => store.getBundle().productions.find(p => p.meta.id === PRODUCTION)!.spine!;
  const scenes = store.getBundle().productions.find(p => p.meta.id === PRODUCTION)!.scenes;
  const scene = scenes.find(candidate => orderedShots(candidate).length >= 2)!;
  const [first, second] = orderedShots(scene);
  const elsewhere = orderedShots(scenes.find(candidate => candidate.id !== scene.id && orderedShots(candidate).length > 0)!)[0]!;
  await applyProductionSpineCommand(store, { productionId: PRODUCTION, baseRevision: null, command: { kind: "create", trackArtifactId: song } }, { source: "test" });
  for (const [index, shot] of [first!, second!, elsewhere].entries()) {
    await applyProductionSpineCommand(store, { productionId: PRODUCTION, baseRevision: index + 1,
      command: { kind: "set-anchor", shotId: shot.id, anchor: { startSec: index * 4, endSec: index * 4 + 4, clipAudio: { mode: "mute" } } } }, { source: "test" });
  }
  assert.equal(spine().revision, 4);

  const card = preview(store, 4, { kind: "delete-anchors", shotIds: [first!.id, second!.id] });
  assert.equal(card.title, `Unpin 2 shots of ${scene.title}`);
  assert.deepEqual(card.commands, [
    { label: `Unpin shot ${first!.number} of ${scene.title}`, detail: "was 0:00–0:04" },
    { label: `Unpin shot ${second!.number} of ${scene.title}`, detail: "was 0:04–0:08" },
  ]);
  assert.equal(card.consequence, "Changes where shots sit in the song.");
  assert.equal(card.expectedResult, "Saved as revision 5 of the song.");
  assert.doesNotMatch(JSON.stringify([card.title, card.commands]), /sh_/);
  assert.equal(preview(store, 4, { kind: "delete-anchors", shotIds: [first!.id, elsewhere.id] }).title, "Unpin 2 shots", "shots of two scenes name neither");
  assert.equal(preview(store, 4, { kind: "delete-anchors", shotIds: [second!.id] }).title, `Unpin shot ${second!.number} of ${scene.title}`);

  const written = await applyProductionSpineCommand(store, { productionId: PRODUCTION, baseRevision: 4, command: { kind: "delete-anchors", shotIds: [first!.id, second!.id] } }, { source: "test" });
  assert.equal(written.spine?.revision, 5, "one revision for both");
  assert.deepEqual(Object.keys(spine().anchors), [elsewhere.id]);
  // One that is not pinned refuses the card whole, by the authority's own reason.
  assert.throws(() => preview(store, 5, { kind: "delete-anchors", shotIds: [elsewhere.id, first!.id] }), /is not anchored/);
});

it("reads a time as a player does, to the millisecond it was given", () => {
  assert.equal(songTime(0), "0:00");
  assert.equal(songTime(16.5), "0:16.5");
  assert.equal(songTime(62.25), "1:02.25");
  assert.equal(songTime(227.639979), "3:47.64");
  assert.equal(songTime(3_600), "60:00");
});
