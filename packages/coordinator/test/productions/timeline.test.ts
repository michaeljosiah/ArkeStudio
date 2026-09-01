import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ProductionTimelineSchema,
  seedStoryPictureTimeline,
  storyTimelineFingerprint,
} from "@arke-studio/contracts";
import { applyTimelineCommand, TimelineCommandRefused } from "../../src/productions/timeline.js";
import { createProduction } from "../../src/productions/ops.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

const CLOCK = () => "2026-09-01T12:00:00.000Z";
const PRODUCTION = "saltlight";

async function open(): Promise<WorldStore> {
  const store = await WorldStore.open(await makeTempWorld(), { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return store;
}

const timelinePath = (store: WorldStore): string =>
  join(store.dir, "productions", PRODUCTION, "timeline.json");

describe("the saved Picture timeline (#678)", () => {
  it("persists a chosen production clock behind the same older-build boundary", async () => {
    const store = await open();
    const slug = await createProduction(store, {
      title: "Twenty Five",
      medium: "video",
      frameRate: 25,
    });
    const raw = JSON.parse(
      await readFile(join(store.dir, "productions", slug, "production.json"), "utf8"),
    ) as { frameRate?: number };
    assert.equal(raw.frameRate, 25);
    assert.equal(store.getBundle().meta.schemaVersion, 5);
  });

  it("keeps a legacy open byte-stable and materialises the first move atomically", async () => {
    const store = await open();
    const production = store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
    assert.deepEqual(production.timeline, { status: "absent" });
    await assert.rejects(readFile(timelinePath(store), "utf8"), { code: "ENOENT" });

    const seeded = seedStoryPictureTimeline(production);
    const clips = seeded.tracks[0]!.clips;
    assert.ok(clips.length > 1, "the fixture has adjacent Picture clips to move");
    const moving = clips[1]!;

    await applyTimelineCommand(store, PRODUCTION, {
      kind: "move-picture",
      clipId: moving.id,
      direction: "earlier",
      baseRevision: null,
      sourceFingerprint: storyTimelineFingerprint(production),
    });

    const saved = ProductionTimelineSchema.parse(JSON.parse(await readFile(timelinePath(store), "utf8")));
    assert.deepEqual(
      saved.tracks[0]!.clips.map((clip) => clip.id),
      [moving.id, clips[0]!.id, ...clips.slice(2).map((clip) => clip.id)],
    );
    assert.equal(saved.revision, 1);
    assert.equal(saved.history.undo.length, 1);
    assert.equal(store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)?.timeline?.status, "ready");
    assert.equal(store.getBundle().meta.schemaVersion, 5);
    await assert.rejects(readWorldMeta(store.dir, { supports: 4 }), /written by a newer Arke Studio/);
  });

  it("refuses stale source and revision without changing timeline bytes", async () => {
    const store = await open();
    const production = store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
    const seeded = seedStoryPictureTimeline(production);
    const moving = seeded.tracks[0]!.clips[1]!;

    await assert.rejects(
      applyTimelineCommand(store, PRODUCTION, {
        kind: "move-picture",
        clipId: moving.id,
        direction: "earlier",
        baseRevision: null,
        sourceFingerprint: "a source order the production never had",
      }),
      TimelineCommandRefused,
    );
    await assert.rejects(readFile(timelinePath(store), "utf8"), { code: "ENOENT" });

    await applyTimelineCommand(store, PRODUCTION, {
      kind: "move-picture",
      clipId: moving.id,
      direction: "earlier",
      baseRevision: null,
      sourceFingerprint: storyTimelineFingerprint(production),
    });
    const before = await readFile(timelinePath(store), "utf8");
    await assert.rejects(
      applyTimelineCommand(store, PRODUCTION, {
        kind: "move-picture",
        clipId: moving.id,
        direction: "later",
        baseRevision: 0,
        sourceFingerprint: storyTimelineFingerprint(production),
      }),
      /moved from revision 0 to 1/,
    );
    assert.equal(await readFile(timelinePath(store), "utf8"), before);
  });

  it("persists Undo and Redo across a restart", async () => {
    let store: WorldStore | null = await open();
    const production = store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
    const seeded = seedStoryPictureTimeline(production);
    const moving = seeded.tracks[0]!.clips[1]!;
    await applyTimelineCommand(store, PRODUCTION, {
      kind: "move-picture",
      clipId: moving.id,
      direction: "earlier",
      baseRevision: null,
      sourceFingerprint: storyTimelineFingerprint(production),
    });
    await applyTimelineCommand(store, PRODUCTION, { kind: "undo", baseRevision: 1 });
    await store.close();

    store = await WorldStore.open(store.dir, { clock: CLOCK });
    closeOnCleanup(() => store?.close());
    const reopened = store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
    assert.equal(reopened.timeline?.status, "ready");
    assert.equal(reopened.timeline?.status === "ready" ? reopened.timeline.timeline.revision : -1, 2);
    assert.deepEqual(
      reopened.timeline?.status === "ready"
        ? reopened.timeline.timeline.tracks[0]!.clips.map((clip) => clip.id)
        : [],
      seeded.tracks[0]!.clips.map((clip) => clip.id),
    );

    await applyTimelineCommand(store, PRODUCTION, { kind: "redo", baseRevision: 2 });
    const redone = store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!.timeline;
    assert.equal(redone?.status === "ready" ? redone.timeline.revision : -1, 3);
    assert.equal(redone?.status === "ready" ? redone.timeline.history.undo.length : 0, 1);
  });

  it("scans malformed saved state as invalid instead of deriving another film", async () => {
    const dir = await makeTempWorld();
    await writeFile(join(dir, "productions", PRODUCTION, "timeline.json"), "{ not json\n", "utf8");
    const store = await WorldStore.open(dir, { clock: CLOCK });
    closeOnCleanup(() => store.close());
    const production = store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
    assert.equal(production.timeline?.status, "invalid");
    assert.ok(store.getBundle().problems.some((problem) => problem.path.endsWith("timeline.json")));
  });
});
