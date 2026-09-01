import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ProductionTimelineSchema,
  orderedTrackClips,
  seedStoryPictureTimeline,
  storyTimelineFingerprint,
  type Selections,
} from "@arke-studio/contracts";
import { applyTimelineCommand, TimelineCommandRefused } from "../../src/productions/timeline.js";
import { createProduction } from "../../src/productions/ops.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { sha256 } from "../../src/world/text-files.js";
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

describe("semantic Picture commands (#679)", () => {
  const CLIP_TAKE = "tk_01J8F0000000000000000000B2";
  const FRAME_TAKE = "tk_01J8A0000000000000000000A1";

  it("lands a batch as one revision and one Undo entry, or not at all", async () => {
    const store = await open();
    const production = store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
    const seeded = seedStoryPictureTimeline(production);
    const [first, second, third] = orderedTrackClips(seeded.tracks[0]!);

    await assert.rejects(
      applyTimelineCommand(store, PRODUCTION, {
        kind: "commands",
        commands: [
          { kind: "delete", clipId: first!.id },
          { kind: "trim", clipId: second!.id, edge: "end", deltaFrames: 1 },
        ],
        baseRevision: null,
        sourceFingerprint: storyTimelineFingerprint(production),
      }),
      /cannot extend into/,
    );
    await assert.rejects(readFile(timelinePath(store), "utf8"), { code: "ENOENT" }, "a refused batch materialises nothing");

    await applyTimelineCommand(store, PRODUCTION, {
      kind: "commands",
      commands: [
        { kind: "split", clipId: third!.id, atFrame: third!.startFrame + 10, newClipId: "cl_tail" },
        { kind: "ripple-delete", clipId: second!.id },
      ],
      baseRevision: null,
      sourceFingerprint: storyTimelineFingerprint(production),
      label: "Tighten the opening",
    });
    const saved = ProductionTimelineSchema.parse(JSON.parse(await readFile(timelinePath(store), "utf8")));
    assert.equal(saved.revision, 1);
    assert.equal(saved.history.undo.length, 1);
    assert.equal(saved.history.undo[0]!.kind === "change" ? saved.history.undo[0]!.label : "", "Tighten the opening");
    assert.deepEqual(
      orderedTrackClips(saved.tracks[0]!).slice(0, 3).map((clip) => [clip.id, clip.startFrame]),
      [
        [first!.id, 0],
        [third!.id, first!.durationFrames],
        ["cl_tail", first!.durationFrames + 10],
      ],
    );

    await applyTimelineCommand(store, PRODUCTION, { kind: "undo", baseRevision: 1 });
    const undone = ProductionTimelineSchema.parse(JSON.parse(await readFile(timelinePath(store), "utf8")));
    assert.deepEqual(
      orderedTrackClips(undone.tracks[0]!).map((clip) => [clip.id, clip.startFrame, clip.durationFrames]),
      orderedTrackClips(seeded.tracks[0]!).map((clip) => [clip.id, clip.startFrame, clip.durationFrames]),
    );
  });

  it("switches a take through the append-only review path and undoes only the selection", async () => {
    const store = await open();
    const production = store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
    const shotId = "sh_12";
    const reviewsPath = join(store.dir, "productions", PRODUCTION, "reviews.jsonl");
    const selectionsPath = join(store.dir, "productions", PRODUCTION, "selections.json");
    const reviewsBefore = await readFile(reviewsPath, "utf8");
    const selectionsBefore = JSON.parse(await readFile(selectionsPath, "utf8")) as Selections;
    assert.equal(selectionsBefore[shotId]?.acceptedTakeId, CLIP_TAKE);

    // A still is a frame, never footage: the ordinary acceptance rule refuses it, and the refusal
    // writes nothing — no timeline, no review line, no selection.
    await assert.rejects(
      applyTimelineCommand(store, PRODUCTION, {
        kind: "commands",
        commands: [{ kind: "switch-take", shotId, takeId: FRAME_TAKE }],
        baseRevision: null,
        sourceFingerprint: storyTimelineFingerprint(production),
      }),
      TimelineCommandRefused,
    );
    assert.equal(await readFile(reviewsPath, "utf8"), reviewsBefore);
    await assert.rejects(readFile(timelinePath(store), "utf8"), { code: "ENOENT" });

    // Re-choosing the same take is a real review decision but no selection change, which is
    // exactly the "changes nothing" the pure layer refuses — so the batch carries a move too.
    const seeded = seedStoryPictureTimeline(production);
    const clips = orderedTrackClips(seeded.tracks[0]!);
    await store.commit({
      kind: "test-clear-selection",
      source: "test",
      files: [
        {
          path: `productions/${PRODUCTION}/selections.json`,
          action: "replace",
          content: JSON.stringify({}, null, 2) + "\n",
          baseHash: sha256(await readFile(selectionsPath, "utf8")),
        },
      ],
    });
    const cleared = store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
    assert.equal(cleared.selections[shotId]?.acceptedTakeId ?? null, null);

    await applyTimelineCommand(store, PRODUCTION, {
      kind: "commands",
      commands: [{ kind: "switch-take", shotId, takeId: CLIP_TAKE }],
      baseRevision: null,
      sourceFingerprint: storyTimelineFingerprint(cleared),
    });
    const reviewsAfter = await readFile(reviewsPath, "utf8");
    assert.equal(reviewsAfter.split("\n").length, reviewsBefore.split("\n").length + 1, "one review line appended");
    const switched = ProductionTimelineSchema.parse(JSON.parse(await readFile(timelinePath(store), "utf8")));
    assert.equal(switched.revision, 1);
    const entry = switched.history.undo[0]!;
    assert.equal(entry.kind, "change");
    assert.equal(entry.kind === "change" ? entry.clips.length : -1, 0, "a take switch moves no clip");
    assert.equal(entry.kind === "change" ? entry.selections[0]?.shotId : "", shotId);
    assert.deepEqual(
      orderedTrackClips(switched.tracks[0]!).map((clip) => clip.id),
      clips.map((clip) => clip.id),
    );
    assert.equal(
      store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!.selections[shotId]?.acceptedTakeId,
      CLIP_TAKE,
    );

    await applyTimelineCommand(store, PRODUCTION, { kind: "undo", baseRevision: 1 });
    const afterUndo = store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
    assert.equal(afterUndo.selections[shotId]?.acceptedTakeId ?? null, null, "Undo restores the previous selection");
    assert.equal(await readFile(reviewsPath, "utf8"), reviewsAfter, "Undo erases no review decision");

    await applyTimelineCommand(store, PRODUCTION, { kind: "redo", baseRevision: 2 });
    const afterRedo = store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
    assert.equal(afterRedo.selections[shotId]?.acceptedTakeId, CLIP_TAKE);
    assert.equal(await readFile(reviewsPath, "utf8"), reviewsAfter, "Redo appends no duplicate review record");
  });
});
