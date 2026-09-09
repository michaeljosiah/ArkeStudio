import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { storyTimelineFingerprint } from "@arke-studio/contracts";
import { fileArtifact } from "../../src/artifacts/filing.js";
import {
  ARTIFACT_POSTER_DIR,
  artifactPosterPath,
  backfillArtifactPosters,
  wantsArtifactPoster,
  writeArtifactPoster,
} from "../../src/artifacts/poster.js";
import { importEditorMedia } from "../../src/productions/editor-import.js";
import { createProduction } from "../../src/productions/ops.js";
import type { TakePosterMaker } from "../../src/takes/poster.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { tempDir } from "../tmp.js";
import type { MediaProbe } from "../../src/media/probe.js";

/**
 * A video artifact's picture (issue 1037): drawn under `.index/posters/<id>.png` as the file is
 * imported, drawn later for the ones that were filed before, and never a failed import.
 */

function maker(): { maker: TakePosterMaker; written: string[] } {
  const written: string[] = [];
  return {
    written,
    maker: {
      write: async (_input, output) => {
        written.push(output);
        await writeFile(output, "png");
        return { ok: true };
      },
    },
  };
}

const probe: MediaProbe = { async durationSec() { return 3; }, async info() { return { durationSec: 3, hasAudio: true, hasVideo: true }; } };

describe("which artifacts get a picture", () => {
  it("draws for a video and for nothing else", () => {
    assert.equal(wantsArtifactPoster({ kind: "video", file: "clip.mp4" }), true);
    assert.equal(wantsArtifactPoster({ kind: "audio", file: "song.mp4" }), false, "an mp4 measured as sound has no frame");
    assert.equal(wantsArtifactPoster({ kind: "video", file: "clip.mkv" }), true, "a video whatever its container; the runner says if it can read it");
    assert.equal(wantsArtifactPoster({ kind: "image", file: "plate.png" }), false);
    assert.equal(artifactPosterPath("ar_01J8G0000000000000000000F1"), `${ARTIFACT_POSTER_DIR}/ar_01J8G0000000000000000000F1.png`);
  });
});

describe("drawing the picture", () => {
  it("writes the poster beside the derived index as the file is imported, before the timeline moves", async (t) => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir);
    t.after(() => store.close());
    const id = await createProduction(store, { title: "Footage", medium: "video", frameRate: 24 });
    const production = () => store.getBundle().productions.find((candidate) => candidate.meta.id === id)!;
    const source = join(dir, "holiday.mp4");
    await writeFile(source, "a real film");
    const posters = maker();
    const failures = await importEditorMedia(store, [source], {
      productionId: id, baseRevision: null, sourceFingerprint: storyTimelineFingerprint(production()), destination: "append",
    }, { mediaProbe: probe, poster: posters.maker, abandoned: () => false });
    assert.deepEqual(failures, []);
    const artifact = store.getBundle().artifacts.find((candidate) => candidate.file === "holiday.mp4")!;
    assert.equal(posters.written.length, 1, "one poster asked for");
    assert.ok(posters.written[0]!.endsWith(join(".index", "posters", `${artifact.id}.png`)), "named by the artifact's id under the derived index");
    assert.equal(await readFile(join(dir, ".index", "posters", `${artifact.id}.png`), "utf8"), "png");
  });

  it("reports a maker that cannot draw and files the artifact anyway", async (t) => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir);
    t.after(() => store.close());
    const source = join(dir, "broken.mp4");
    await writeFile(source, "bytes");
    const filed = await fileArtifact(store, { sourcePath: source, production: null, mediaProbe: probe });
    assert.equal(filed.outcome, "filed");
    if (filed.outcome !== "filed") return;
    const reasons: string[] = [];
    const drawn = await writeArtifactPoster(store, filed.artifact, { write: async () => ({ ok: false, reason: "timeout" }) }, (reason) => reasons.push(reason));
    assert.equal(drawn, false);
    assert.deepEqual(reasons, ["timeout"]);
    assert.equal(await stat(join(dir, ".index", "posters", `${filed.artifact.id}.png`)).catch(() => null), null);
    // Without a maker at all nothing is asked and nothing is said: most builds have no ffmpeg.
    assert.equal(await writeArtifactPoster(store, filed.artifact, undefined), false);
    // A run that wrote a partial file and then failed leaves nothing behind for a later pass to
    // mistake for a picture; and an empty file already there is drawn over.
    const output = join(dir, ".index", "posters", `${filed.artifact.id}.png`);
    const partial: TakePosterMaker = { write: async (_input, out) => { await writeFile(out, "half"); return { ok: false, reason: "timeout" }; } };
    assert.equal(await writeArtifactPoster(store, filed.artifact, partial), false);
    assert.equal(await stat(output).catch(() => null), null, "the partial file is gone");
    await mkdir(join(dir, ".index", "posters"), { recursive: true });
    await writeFile(output, "");
    const whole = maker();
    assert.equal(await writeArtifactPoster(store, filed.artifact, whole.maker), true);
    assert.equal(whole.written.length, 1, "an empty poster is not a poster");
  });

  it("backfills the videos filed before posters existed, skips the ones drawn, and stops at the budget", async (t) => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir);
    t.after(() => store.close());
    const filed = [];
    for (const name of ["one.mp4", "two.mp4", "three.mp4"]) {
      const source = join(dir, name);
      await writeFile(source, `film ${name}`);
      const outcome = await fileArtifact(store, { sourcePath: source, production: null, mediaProbe: probe });
      assert.equal(outcome.outcome, "filed");
      if (outcome.outcome === "filed") filed.push(outcome.artifact);
    }
    const still = join(dir, "plate.png");
    await writeFile(still, "png bytes");
    assert.equal((await fileArtifact(store, { sourcePath: still, production: null })).outcome, "filed");
    // One already drawn by hand: the pass costs it one stat and nothing more.
    await mkdir(join(dir, ".index", "posters"), { recursive: true });
    await writeFile(join(dir, ".index", "posters", `${filed[0]!.id}.png`), "already");
    const posters = maker();
    let now = 0;
    const drawn = await backfillArtifactPosters(store, posters.maker, { budgetMs: 100, now: () => (now += 10) });
    assert.equal(drawn, 2, "the two undrawn videos, not the still and not the one already there");
    assert.equal(await readFile(join(dir, ".index", "posters", `${filed[0]!.id}.png`), "utf8"), "already");
    assert.equal(await backfillArtifactPosters(store, posters.maker, { budgetMs: 100 }), 0, "every later pass finds them all");
    assert.equal(await backfillArtifactPosters(store, undefined, { budgetMs: 100 }), 0, "no maker, no work");
    // A budget already spent draws nothing.
    const exhausted = maker();
    let late = 0;
    assert.equal(await backfillArtifactPosters(store, exhausted.maker, { budgetMs: 1, now: () => (late += 1000) }), 0);
  });

  it("does not hold the open past its budget for a maker that hangs", async (t) => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir);
    t.after(() => store.close());
    const source = join(dir, "stuck.mp4");
    await writeFile(source, "a film ffmpeg cannot finish");
    assert.equal((await fileArtifact(store, { sourcePath: source, production: null, mediaProbe: probe })).outcome, "filed");
    // The maker's own timeout is fifteen seconds; the pass in front of `world.opened` waits only its budget.
    const hanging: TakePosterMaker = { write: () => new Promise(() => undefined) };
    const started = Date.now();
    assert.equal(await backfillArtifactPosters(store, hanging, { budgetMs: 50 }), 0);
    assert.ok(Date.now() - started < 5_000, "returned at the budget, not the maker's timeout");
  });
});

describe("where the picture is read from and written to", () => {
  it("draws nothing for a shelf or an index that is a link out of the world, and draws into the world's own", async () => {
    const asked = maker();
    const artifact = { id: "ar_01J8G0000000000000000000L1", kind: "video" as const, file: "clip.mp4" };
    // A world whose artifacts/ is a link to a directory elsewhere on the host: not read.
    const outside = await tempDir("arke-outside-");
    await writeFile(join(outside, "clip.mp4"), "host bytes");
    const linkedShelf = await tempDir("arke-linked-shelf-");
    await symlink(outside, join(linkedShelf, "artifacts"), "junction");
    assert.equal(await writeArtifactPoster({ dir: linkedShelf }, artifact, asked.maker), false);
    assert.deepEqual(asked.written, [], "a linked shelf is not handed to the maker");
    // A real shelf whose .index/posters is a link out: nothing is written through it.
    const linkedIndex = await tempDir("arke-linked-index-");
    const elsewhere = await tempDir("arke-elsewhere-");
    await mkdir(join(linkedIndex, "artifacts"));
    await writeFile(join(linkedIndex, "artifacts", "clip.mp4"), "film");
    await mkdir(join(linkedIndex, ".index"));
    await symlink(elsewhere, join(linkedIndex, ".index", "posters"), "junction");
    assert.equal(await writeArtifactPoster({ dir: linkedIndex }, artifact, asked.maker), false);
    assert.deepEqual(asked.written, []);
    assert.deepEqual(await readdir(elsewhere), [], "nothing landed outside the world");
    // A sidecar naming a path, or an id that is one, is not a poster either.
    assert.equal(await writeArtifactPoster({ dir: linkedIndex }, { ...artifact, file: "../world.json" }, asked.maker), false);
    assert.equal(await writeArtifactPoster({ dir: linkedIndex }, { ...artifact, id: "../escape" }, asked.maker), false);
    assert.deepEqual(asked.written, []);
    // The world's own directories are drawn into as before, index created on the way.
    const own = await tempDir("arke-own-");
    await mkdir(join(own, "artifacts"));
    await writeFile(join(own, "artifacts", "clip.mp4"), "film");
    assert.equal(await writeArtifactPoster({ dir: own }, artifact, asked.maker), true);
    assert.equal(asked.written.length, 1);
    assert.equal(await readFile(join(own, ".index", "posters", `${artifact.id}.png`), "utf8"), "png");
  });
});
