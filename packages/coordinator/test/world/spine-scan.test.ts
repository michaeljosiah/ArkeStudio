import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId } from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "./helpers.js";

const CLOCK = () => "2026-08-12T12:00:00.000Z";

/**
 * Loading the spine (#253). The absence of `spine.json` is the ordinary case and must stay
 * completely silent — a short film keeps the scene-order cut it has always had.
 */
describe("the spine is loaded, and its absence is not a fault (#253)", () => {
  async function open() {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    return { dir, store, production: store.getBundle().productions[0]! };
  }

  it("a production with no spine.json reads as legacy, with no problem reported", async () => {
    const { store, production } = await open();
    assert.equal(production.spine, null, "no spine means the scene-order cut, not a broken one");
    assert.deepEqual(production.cut, { audio: [] });
    assert.deepEqual(production.takeMediaInfo, {});
    assert.equal(
      store.getBundle().problems?.some((p) => /spine/i.test(JSON.stringify(p))) ?? false,
      false,
      "absence is never a world problem",
    );
    await store.close();
  });

  it("reads a spine, its markers and its anchors back off disk", async () => {
    const { dir, store, production } = await open();
    const trackId = newId("ar");
    await writeFile(
      join(dir, "productions", production.meta.id, "spine.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          revision: 3,
          trackArtifactId: trackId,
          markers: [
            { kind: "section", id: newId("mk"), label: "Verse 1", atSec: 30, source: "json" },
            { kind: "lyric", id: newId("mk"), text: "forgive me", atSec: 30.25, source: "lrc" },
          ],
          anchors: { sh_12: { startSec: 30, endSec: 38, clipAudio: { mode: "keep-diegetic", gainDb: -12 } } },
          updatedAt: "2026-08-12T11:00:00.000Z",
        },
        null,
        2,
      ),
      "utf8",
    );
    await store.reload();

    const spine = store.getBundle().productions[0]!.spine;
    assert.ok(spine, "the file is loaded, not ignored");
    assert.equal(spine.revision, 3);
    assert.equal(spine.trackArtifactId, trackId);
    assert.equal(spine.markers.length, 2);
    assert.deepEqual(spine.anchors["sh_12"], {
      startSec: 30,
      endSec: 38,
      clipAudio: { mode: "keep-diegetic", gainDb: -12 },
    });
    await store.close();
  });

  it("a spine that will not parse leaves the production on the legacy path rather than half a timeline", async () => {
    const { dir, store, production } = await open();
    await writeFile(
      join(dir, "productions", production.meta.id, "spine.json"),
      // endSec before startSec: refused by the schema, so there is no partial timeline to trust.
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        trackArtifactId: newId("ar"),
        markers: [],
        anchors: { sh_12: { startSec: 30, endSec: 10 } },
        updatedAt: "2026-08-12T11:00:00.000Z",
      }),
      "utf8",
    );
    await store.reload();
    assert.equal(store.getBundle().productions[0]!.spine, null, "null, not a spine with the bad anchor dropped");
    await store.close();
  });

  it("reads a take's measurement from beside it, never from inside take.json", async () => {
    const { dir, store, production } = await open();
    const takeId = production.takes[0]?.id;
    assert.ok(takeId, "the fixture production has a take to measure");
    const record = {
      sourceHash: `sha256:${"b".repeat(64)}`,
      mediaInfo: { durationSec: 8.5, hasAudio: true, audioChannels: 2, audioSampleRateHz: 48000 },
      probedAt: "2026-08-12T11:30:00.000Z",
    };
    const takeDir = join(dir, "productions", production.meta.id, "takes", takeId);
    await mkdir(takeDir, { recursive: true });
    await writeFile(join(takeDir, "media-info.json"), JSON.stringify(record, null, 2), "utf8");
    await store.reload();

    const reloaded = store.getBundle().productions[0]!;
    assert.deepEqual(reloaded.takeMediaInfo[takeId], record);
    // And take.json is untouched: the measurement lives beside the immutable record, not in it.
    assert.ok(!JSON.stringify(reloaded.takes.find((t) => t.id === takeId)).includes("durationSec"));
    await store.close();
  });
});
