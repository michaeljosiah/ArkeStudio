import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CutFileSchema } from "@arke-studio/contracts";
import {
  moveOverlay,
  placeOverlay,
  rejoinOverlayAudio,
  removeOverlay,
  splitOverlayAudio,
} from "../../src/takes/review.js";
import { fileArtifact } from "../../src/artifacts/filing.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { tempDir } from "../tmp.js";

/**
 * Overlays (82a): the one stored position on the cut. Everything else about the picture is
 * derived, so these tests are as much about what an overlay is *not* — not a take, not coverage,
 * and not a reason for cut.json to stop holding audio.
 */

const CLOCK = () => "2026-08-01T12:00:00.000Z";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  const artifactId = store.getBundle().artifacts[0]?.id;
  assert.ok(artifactId, "the fixture world files at least one artifact");
  return { dir, store, artifactId };
}

const cutOf = async (dir: string) =>
  CutFileSchema.parse(JSON.parse(await readFile(join(dir, "productions/saltlight/cut.json"), "utf8")));

describe("overlays on the cut (82a)", () => {
  it("places an artifact over a window and files it in cut.json", async () => {
    const { dir, store, artifactId } = await open();
    const overlay = await placeOverlay(store, "saltlight", { artifactId, startSec: 48, endSec: 62 });
    assert.match(overlay.id, /^ov_[0-9A-HJKMNP-TV-Z]{26}$/);
    const cut = await cutOf(dir);
    assert.deepEqual(cut.overlays, [{ id: overlay.id, artifactId, startSec: 48, endSec: 62, lane: 0, audio: "keep" }]);
    await store.close();
  });

  it("keeps the audio cut.json already held", async () => {
    // The file is read through its schema and written whole; a placement that dropped the audio
    // would take a production's dialogue and score with it.
    const { dir, store, artifactId } = await open();
    const path = join(dir, "productions/saltlight/cut.json");
    await writeFile(
      path,
      JSON.stringify({ audio: [{ kind: "score", label: "the verse, low", entries: [{ offsetSec: 0 }] }] }, null, 2),
      "utf8",
    );
    await store.reload();
    await placeOverlay(store, "saltlight", { artifactId, startSec: 1, endSec: 2 });
    const cut = await cutOf(dir);
    assert.equal(cut.audio.length, 1, "the score is still there");
    assert.equal(cut.audio[0]?.label, "the verse, low");
    assert.equal(cut.overlays.length, 1);
    await store.close();
  });

  it("refuses an artifact this world does not have", async () => {
    // A placement citing nothing is one the cut would have to render as an absence it cannot name.
    const { store } = await open();
    await assert.rejects(
      () => placeOverlay(store, "saltlight", { artifactId: "ar_01J8G0000000000000000000ZZ", startSec: 0, endSec: 5 }),
      /is not in this world/,
    );
    await store.close();
  });

  it("refuses a window that ends before it starts, or does not last", async () => {
    const { store, artifactId } = await open();
    await assert.rejects(() => placeOverlay(store, "saltlight", { artifactId, startSec: 10, endSec: 4 }), /cannot start/);
    await assert.rejects(() => placeOverlay(store, "saltlight", { artifactId, startSec: 10, endSec: 10 }), /cannot start/);
    await store.close();
  });

  it("moves one that is already placed, and refuses one that is not", async () => {
    const { dir, store, artifactId } = await open();
    const overlay = await placeOverlay(store, "saltlight", { artifactId, startSec: 48, endSec: 62 });
    const moved = await moveOverlay(store, "saltlight", { overlayId: overlay.id, startSec: 90, endSec: 104 });
    assert.deepEqual([moved.startSec, moved.endSec], [90, 104]);
    assert.equal(moved.artifactId, artifactId, "moving changes when, never what");
    assert.deepEqual((await cutOf(dir)).overlays, [
      { id: overlay.id, artifactId, startSec: 90, endSec: 104, lane: 0, audio: "keep" },
    ]);
    await assert.rejects(
      () => moveOverlay(store, "saltlight", { overlayId: "ov_01J8G0000000000000000000ZZ", startSec: 0, endSec: 1 }),
      /is not on this cut/,
    );
    await store.close();
  });

  it("removes the placement and leaves the artifact filed", async () => {
    const { dir, store, artifactId } = await open();
    const overlay = await placeOverlay(store, "saltlight", { artifactId, startSec: 3, endSec: 9 });
    await removeOverlay(store, "saltlight", overlay.id);
    assert.deepEqual((await cutOf(dir)).overlays, []);
    assert.ok(
      store.getBundle().artifacts.some((a) => a.id === artifactId),
      "an overlay only ever cited the artifact — deleting it deletes a placement",
    );
    await store.close();
  });

  it("writes nothing when a placement is refused", async () => {
    const { dir, store, artifactId } = await open();
    await placeOverlay(store, "saltlight", { artifactId, startSec: 1, endSec: 2 });
    const before = await readFile(join(dir, "productions/saltlight/cut.json"), "utf8");
    await assert.rejects(() => placeOverlay(store, "saltlight", { artifactId, startSec: 5, endSec: 5 }), /cannot start/);
    assert.equal(await readFile(join(dir, "productions/saltlight/cut.json"), "utf8"), before);
    await store.close();
  });

  it("creates no take, no review and no selection — an overlay is none of those", async () => {
    const { dir, store, artifactId } = await open();
    const selectionsBefore = await readFile(join(dir, "productions/saltlight/selections.json"), "utf8").catch(() => "");
    await placeOverlay(store, "saltlight", { artifactId, startSec: 20, endSec: 30 });
    const production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    assert.equal(
      production.takes.filter((t) => t.provider === "user").length,
      0,
      "nothing was dispatched, so nothing is a take",
    );
    assert.equal(
      await readFile(join(dir, "productions/saltlight/selections.json"), "utf8").catch(() => ""),
      selectionsBefore,
      "and no shot's selection changed: an overlay is never coverage",
    );
    await store.close();
  });

  it("keeps a clip on its lane when a move does not name one", async () => {
    // Trimming an edge is a move, and a trim that silently reset the lane would drop the clip.
    const { store, artifactId } = await open();
    const placed = await placeOverlay(store, "saltlight", { artifactId, startSec: 1, endSec: 5, lane: 3 });
    const moved = await moveOverlay(store, "saltlight", { overlayId: placed.id, startSec: 2, endSec: 5 });
    assert.equal(moved.lane, 3);
    await store.close();
  });
});

describe("splitting a clip's sound onto the lane below (lanes)", () => {
  /**
   * The fixture world files a board, a bed and a document — no video, which is the only kind that
   * has a picture and a sound to separate. So one is filed properly, through the same path a
   * person's upload takes, rather than leaving the split's own test asserting nothing.
   *
   * `mediaProbe` says it carries audio: the exporter refuses to name an audio input it has no
   * evidence for, and a split whose sound half never reached the mix would pass a test that
   * checked only the placement.
   */
  async function fileVideo(
    store: WorldStore,
    measured: { hasAudio: boolean } | null = { hasAudio: true },
  ): Promise<string> {
    const source = join(await tempDir("arke-insert-"), "insert.mp4");
    await writeFile(source, "not a real encode, and never decoded here", "utf8");
    // A probe is a pair of measuring functions, not a measurement: this one answers for the file
    // it is handed without an ffprobe to run, which is the whole point of the seam. `null` files
    // it unmeasured, which is the real window between an upload and its probe landing.
    const filed = await fileArtifact(store, {
      sourcePath: source,
      ...(measured === null
        ? {}
        : {
            mediaProbe: {
              durationSec: async () => 12,
              info: async () => ({ durationSec: 12, hasAudio: measured.hasAudio }),
            },
          }),
    });
    assert.equal(filed.outcome, "filed", "the split's own test proves nothing without a video to split");
    assert.equal(filed.artifact.kind, "video", "an .mp4 files as video, which is what has both");
    /*
     * Read back from the world rather than from the return value. Filing measures *after* it has
     * committed the sidecar and hands back the record it wrote first, so `filed.artifact` never
     * carries the measurement even though the file on disk does — and the measurement is the
     * premise here, because the exporter refuses to name an audio input it has no evidence for.
     */
    const stored = store.getBundle().artifacts.find((a) => a.id === filed.artifact.id);
    assert.equal(stored?.mediaInfo?.hasAudio, measured?.hasAudio, "the measurement reached the sidecar");
    return filed.artifact.id;
  }

  /*
   * `finally`, unlike the placement tests above, because these were written watching a failing
   * assert leave the store open and hang the whole run: a broken split then reads as a timeout
   * with no failure named, which is the least useful way for a test to tell you something.
   */
  const withWorld = async (body: (ctx: Awaited<ReturnType<typeof open>>) => Promise<void>) => {
    const ctx = await open();
    try {
      await body(ctx);
    } finally {
      await ctx.store.close();
    }
  };

  it("refuses what has no sound to separate", async () =>
    withWorld(async ({ store }) => {
      const audio = store.getBundle().artifacts.find((a) => a.kind === "audio");
      assert.ok(audio, "the fixture world files an audio artifact");
      const placed = await placeOverlay(store, "saltlight", { artifactId: audio.id, startSec: 0, endSec: 4 });
      await assert.rejects(() => splitOverlayAudio(store, "saltlight", placed.id), /no sound to split/);
    }));

  it("refuses a clip that is not on this cut", async () =>
    withWorld(async ({ store }) => {
      await assert.rejects(
        () => splitOverlayAudio(store, "saltlight", "ov_01J8G0000000000000000000ZZ"),
        /is not on this cut/,
      );
    }));

  it("splits a video into a muted picture and a sound clip one lane down", async () =>
    withWorld(async ({ dir, store }) => {
      const video = await fileVideo(store);
      const placed = await placeOverlay(store, "saltlight", { artifactId: video, startSec: 2, endSec: 6, lane: 2 });
      const sound = await splitOverlayAudio(store, "saltlight", placed.id);
      assert.equal(sound.audio, "only");
      assert.equal(sound.lane, 1, "the lane below the picture");
      assert.deepEqual([sound.startSec, sound.endSec], [2, 6], "over the same window");
      assert.equal(sound.artifactId, video, "both halves still cite the one file");
      assert.notEqual(sound.id, placed.id, "two clips, so either can be deleted on its own");
      const overlays = (await cutOf(dir)).overlays;
      assert.equal(overlays.length, 2);
      assert.equal(overlays.find((o) => o.id === placed.id)?.audio, "mute", "the picture stops sounding");
      await assert.rejects(() => splitOverlayAudio(store, "saltlight", placed.id), /already been split/);
    }));

  it("leaves both halves on the bottom lane when there is no lane below", async () =>
    withWorld(async ({ dir, store }) => {
      const video = await fileVideo(store);
      const placed = await placeOverlay(store, "saltlight", { artifactId: video, startSec: 0, endSec: 3, lane: 0 });
      const sound = await splitOverlayAudio(store, "saltlight", placed.id);
      assert.equal(sound.lane, 0, "a picture-only and a sound-only clip share a lane without fighting");
      assert.equal((await cutOf(dir)).overlays.length, 2);
    }));

  it("removes one half without touching the other", async () =>
    withWorld(async ({ dir, store }) => {
      const video = await fileVideo(store);
      const placed = await placeOverlay(store, "saltlight", { artifactId: video, startSec: 1, endSec: 5, lane: 1 });
      const sound = await splitOverlayAudio(store, "saltlight", placed.id);
      await removeOverlay(store, "saltlight", sound.id);
      const left = (await cutOf(dir)).overlays;
      assert.equal(left.length, 1);
      assert.equal(left[0]?.id, placed.id, "the picture is what is left");
      // Deleting the sound is not the same act as rejoining it — the person threw that sound
      // away, so the picture stays as they left it. `rejoinOverlayAudio` is the way back, and
      // an earlier version of this test asserted the mute with no way back to assert against.
      assert.equal(left[0]?.audio, "mute");
    }));

  it("refuses to split what was measured silent, rather than muting it for good", async () =>
    withWorld(async ({ dir, store }) => {
      const silent = await fileVideo(store, { hasAudio: false });
      const placed = await placeOverlay(store, "saltlight", { artifactId: silent, startSec: 0, endSec: 4 });
      await assert.rejects(() => splitOverlayAudio(store, "saltlight", placed.id), /measured as silent/);
      // The refusal has to leave the clip alone: a mute written before the throw would be a clip
      // silent for ever, from an action that reported itself as refused.
      const after = (await cutOf(dir)).overlays;
      assert.equal(after.length, 1, "no sound half was filed");
      assert.equal(after[0]?.audio, "keep", "and the picture still carries its own sound");
    }));

  it("refuses to split a video nothing has measured yet", async () =>
    withWorld(async ({ store }) => {
      const unprobed = await fileVideo(store, null);
      const placed = await placeOverlay(store, "saltlight", { artifactId: unprobed, startSec: 0, endSec: 4 });
      // Different from measured-silent, and says so: this one becomes splittable once the probe
      // lands, so telling somebody to try again is true here and would be a lie above.
      await assert.rejects(() => splitOverlayAudio(store, "saltlight", placed.id), /has not been measured yet/);
    }));
});

describe("rejoining a split (lanes)", () => {
  const withWorld = async (body: (ctx: Awaited<ReturnType<typeof open>>) => Promise<void>) => {
    const ctx = await open();
    try {
      await body(ctx);
    } finally {
      await ctx.store.close();
    }
  };

  async function fileVideo(store: WorldStore): Promise<string> {
    const source = join(await tempDir("arke-insert-"), "insert.mp4");
    await writeFile(source, "not a real encode, and never decoded here", "utf8");
    const filed = await fileArtifact(store, {
      sourcePath: source,
      mediaProbe: { durationSec: async () => 12, info: async () => ({ durationSec: 12, hasAudio: true }) },
    });
    assert.equal(filed.outcome, "filed");
    return filed.artifact.id;
  }

  it("gives the picture its sound back and takes the twin away", async () =>
    withWorld(async ({ dir, store }) => {
      const video = await fileVideo(store);
      const placed = await placeOverlay(store, "saltlight", { artifactId: video, startSec: 1, endSec: 5, lane: 2 });
      await splitOverlayAudio(store, "saltlight", placed.id);
      const rejoined = await rejoinOverlayAudio(store, "saltlight", placed.id);
      assert.equal(rejoined.audio, "keep");
      const left = (await cutOf(dir)).overlays;
      assert.equal(left.length, 1, "the sound half is gone, or the mix would count it twice");
      assert.equal(left[0]?.id, placed.id);
      assert.equal(left[0]?.lane, 2, "and the picture never moved");
    }));

  it("leaves a sound clip somebody has since made their own", async () =>
    withWorld(async ({ dir, store }) => {
      const video = await fileVideo(store);
      const placed = await placeOverlay(store, "saltlight", { artifactId: video, startSec: 1, endSec: 5, lane: 2 });
      const sound = await splitOverlayAudio(store, "saltlight", placed.id);
      // Dragged somewhere of its own: it is an edit now, not the other half of a split.
      await moveOverlay(store, "saltlight", { overlayId: sound.id, startSec: 9, endSec: 13 });
      await rejoinOverlayAudio(store, "saltlight", placed.id);
      const left = (await cutOf(dir)).overlays;
      assert.equal(left.length, 2, "taking it away would be taking their edit");
      assert.equal(left.find((o) => o.id === sound.id)?.startSec, 9);
    }));

  it("refuses a clip that was never split", async () =>
    withWorld(async ({ store }) => {
      const video = await fileVideo(store);
      const placed = await placeOverlay(store, "saltlight", { artifactId: video, startSec: 0, endSec: 3 });
      await assert.rejects(() => rejoinOverlayAudio(store, "saltlight", placed.id), /is not a split picture/);
    }));
});
