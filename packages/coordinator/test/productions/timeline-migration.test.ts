import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProductionTimelineSchema, sortScenes } from "@arke-studio/contracts";
import { placementsLiveOnTimeline } from "../../src/productions/timeline.js";
import { placeOverlay } from "../../src/takes/review.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
import { assembleScene } from "./assemble.js";

/**
 * Legacy placements fold into typed tracks with the first write that reaches the record
 * (SPEC-037 R-30, R-31; issue #681), in the same commit as the command, and from then on the
 * lane and audio-track writers refuse: one writable copy of every placement.
 */

const CLOCK = () => "2026-09-01T12:00:00.000Z";
const PRODUCTION = "saltlight";

async function open(): Promise<WorldStore> {
  const store = await WorldStore.open(await makeTempWorld(), { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return store;
}

function productionOf(store: WorldStore) {
  return store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
}

describe("cut.json migration on the first timeline write", () => {
  it("carries lanes into typed tracks with the command, then refuses the lane writers", async () => {
    const store = await open();
    const bells = store.getBundle().artifacts.find((artifact) => artifact.kind === "audio");
    assert.ok(bells, "the fixture world files one audio artifact");
    await placeOverlay(store, PRODUCTION, { artifactId: bells.id, startSec: 2, endSec: 5, lane: 1 });
    assert.equal(productionOf(store).cut.overlays.length, 1);
    assert.equal(placementsLiveOnTimeline(productionOf(store)), false);

    const { dropped } = await assembleScene(store, PRODUCTION, sortScenes(productionOf(store).scenes)[0]!.id);
    assert.deepEqual(dropped, []);

    const saved = ProductionTimelineSchema.parse(
      JSON.parse(await readFile(join(store.dir, "productions", PRODUCTION, "timeline.json"), "utf8")),
    );
    assert.equal(saved.migratedCut, true);
    assert.equal(saved.revision, 1, "the migration is part of the base the command applied to, not a revision of its own");
    assert.equal(saved.history.undo.length, 1, "and not an undo step");
    const sound = saved.tracks.find((track) => track.id === "tr_lane-1-sound");
    assert.ok(sound, "the lane's sound became a typed track");
    assert.equal(sound.kind, "ambience");
    assert.deepEqual(
      sound.clips.map((clip) => [clip.startFrame, clip.durationFrames, clip.source.kind === "artifact" ? clip.source.artifactId : null]),
      [[48, 72, bells.id]],
      "2s to 5s at 24 fps, to the frame",
    );
    assert.equal(placementsLiveOnTimeline(productionOf(store)), true);
    assert.equal(productionOf(store).cut.overlays.length, 1, "cut.json is still readable; it simply has no writer now");
  });

  it("names a placement it cannot carry instead of dropping it silently", async () => {
    const store = await open();
    const production = productionOf(store);
    const cutPath = join(store.dir, "productions", PRODUCTION, "cut.json");
    const { sha256 } = await import("../../src/world/text-files.js");
    const existing = await readFile(cutPath, "utf8").catch(() => null);
    await store.commit({
      kind: "test-orphan-overlay",
      source: "test",
      files: [
        {
          path: `productions/${PRODUCTION}/cut.json`,
          action: existing === null ? "create" : "replace",
          content:
            JSON.stringify(
              {
                audio: [],
                overlays: [
                  { id: "ov_01J8G0000000000000000000B9", artifactId: "ar_01J8G0000000000000000000ZZ", startSec: 0, endSec: 1, lane: 0, audio: "keep" },
                ],
              },
              null,
              2,
            ) + "\n",
          baseHash: existing === null ? null : sha256(existing),
        },
      ],
    });
    const { dropped } = await assembleScene(store, PRODUCTION, sortScenes(production.scenes)[0]!.id);
    assert.deepEqual(dropped, ["ov_01J8G0000000000000000000B9 cites artifact ar_01J8G0000000000000000000ZZ, which this world does not have"]);
  });
});
