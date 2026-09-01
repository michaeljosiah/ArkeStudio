import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { storyTimelineFingerprint, type Selections } from "@arke-studio/contracts";
import { applyTimelineCommand, TimelineCommandRefused } from "../../src/productions/timeline.js";
import { acceptTake, setTrim } from "../../src/takes/review.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
import { sha256 } from "../../src/world/text-files.js";

/**
 * The selection has writers the timeline revision does not fence (review round one, P1): a take
 * accepted or a trim set after a take switch leaves the revision alone, so Undo of that switch
 * would otherwise write the recorded old selection over the newer choice. Each shot must still
 * read as the entry recorded it, or the history command refuses and writes nothing.
 */

const CLOCK = () => "2026-09-01T12:00:00.000Z";
const PRODUCTION = "saltlight";
const CLIP_TAKE = "tk_01J8F0000000000000000000B2";

async function open(): Promise<WorldStore> {
  const store = await WorldStore.open(await makeTempWorld(), { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return store;
}

function productionOf(store: WorldStore) {
  return store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
}

describe("take-switch history against a selection that moved since", () => {
  it("refuses Undo and Redo when another writer changed the shot, and writes nothing", async () => {
    const store = await open();
    const selectionsPath = join(store.dir, "productions", PRODUCTION, "selections.json");
    const timelinePath = join(store.dir, "productions", PRODUCTION, "timeline.json");
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
    await applyTimelineCommand(store, PRODUCTION, {
      kind: "commands",
      commands: [{ kind: "switch-take", shotId: "sh_12", takeId: CLIP_TAKE }],
      baseRevision: null,
      sourceFingerprint: storyTimelineFingerprint(productionOf(store)),
    });
    assert.equal(productionOf(store).selections["sh_12"]?.acceptedTakeId, CLIP_TAKE);

    // A trim through the ordinary review path: the timeline revision does not move.
    await setTrim(store, productionOf(store), { shotId: "sh_12", trimInSec: 1 });
    const trimmed = await readFile(selectionsPath, "utf8");
    const timelineBefore = await readFile(timelinePath, "utf8");
    await assert.rejects(
      applyTimelineCommand(store, PRODUCTION, { kind: "undo", baseRevision: 1 }),
      (error: unknown) => error instanceof TimelineCommandRefused && /selection changed since this take switch/.test(error.reason),
    );
    assert.equal(await readFile(selectionsPath, "utf8"), trimmed, "the newer trim survives");
    assert.equal(await readFile(timelinePath, "utf8"), timelineBefore, "and the timeline did not move either");

    // Put the selection back exactly as the entry recorded it, and Undo works again.
    await setTrim(store, productionOf(store), { shotId: "sh_12", trimInSec: 0 });
    await applyTimelineCommand(store, PRODUCTION, { kind: "undo", baseRevision: 1 });
    assert.equal(productionOf(store).selections["sh_12"]?.acceptedTakeId ?? null, null);

    // Redo has the same fence from the other side.
    await acceptTake(store, productionOf(store), { takeId: CLIP_TAKE, shotId: "sh_12", by: "user" });
    const reaccepted = JSON.parse(await readFile(selectionsPath, "utf8")) as Selections;
    await assert.rejects(
      applyTimelineCommand(store, PRODUCTION, { kind: "redo", baseRevision: 2 }),
      (error: unknown) => error instanceof TimelineCommandRefused && /selection changed since this take switch/.test(error.reason),
    );
    assert.deepEqual(JSON.parse(await readFile(selectionsPath, "utf8")), reaccepted);
  });
});
