import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WORLD_EXPORT_EXCLUDED } from "../../src/takes/export.js";
import { recordReferenceTake, recordUploadedReferenceTake } from "../../src/references/takes.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";

/**
 * What a finalized reference take leaves on disk (issue 231).
 *
 * Finalization copied the landed file into the take's immutable directory and left the staging
 * copy where it was, so every generated image was stored twice. One short session left ten
 * orphaned PNGs behind, 22 MB of them under a single character's `looks/incoming/`, and an
 * export carried the duplicates too. A world folder is meant to be read by hand; it showed each
 * image twice with nothing to say which one mattered.
 *
 * Production takes never had this — `recordTakesFromJob` moves the media and removes the
 * landing directory, "one stored artifact (R-3)". These tests hold reference takes to the same
 * rule, and hold the line on the paths that are not staging.
 */

const CLOCK = () => "2026-08-01T12:00:00.000Z";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  return { dir, store };
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

function jobFor(kind: string, id: string, landed: string) {
  return {
    id: "jb_01J8E0000000000000000000N1",
    idempotencyKey: "01J8E1000000000000000000P1",
    worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
    target: { kind, id },
    capability: "image",
    provider: "fal",
    model: "flux-pro-1.1",
    params: {
      prompt: "a look",
      references: [],
      provenance: { canonRevision: 42, sheets: { "maren-kest": 4 }, artDirectionVersion: 3 },
    },
    estimatedMicroUsd: 40000,
    status: "succeeded",
    providerJobId: "fal-n1",
    attempt: 1,
    landedFiles: [landed],
    error: null,
    createdAt: CLOCK(),
    updatedAt: CLOCK(),
  } as const;
}

describe("a finalized reference take stores its image once (issue 231)", () => {
  it("takes the staging copy with it, and the empty staging directory too", async () => {
    const { dir, store } = await open();
    const landed = "references/maren-kest/looks/incoming/look-g1-1.png";
    await mkdir(join(dir, "references", "maren-kest", "looks", "incoming"), { recursive: true });
    await writeFile(join(dir, landed), "look-bytes");

    const take = await recordReferenceTake(store, jobFor("character-look", "maren-kest/g1/1", landed) as never);
    assert.ok(take);
    const stored = join(dir, "references", "maren-kest", "takes", take.id, take.media!);
    assert.equal(await readFile(stored, "utf8"), "look-bytes", "the take owns the bytes");
    assert.equal(await exists(join(dir, landed)), false, "and the staging copy is not a second one");
    assert.equal(
      await exists(join(dir, "references", "maren-kest", "looks", "incoming")),
      false,
      "an emptied staging directory is not left behind to be read as content",
    );
    await store.close();
  });

  it("keeps a sibling's staging copy while that sibling is still unfinalized", async () => {
    // Four looks land together and finalize one at a time. Removing the directory out from
    // under the three still waiting would lose them.
    const { dir, store } = await open();
    const incoming = join(dir, "references", "maren-kest", "looks", "incoming");
    await mkdir(incoming, { recursive: true });
    for (const n of [1, 2]) await writeFile(join(incoming, `look-g2-${n}.png`), `look-${n}`);

    const take = await recordReferenceTake(
      store,
      jobFor("character-look", "maren-kest/g2/1", "references/maren-kest/looks/incoming/look-g2-1.png") as never,
    );
    assert.ok(take);
    assert.equal(await exists(join(incoming, "look-g2-1.png")), false, "the finalized one goes");
    assert.equal(await readFile(join(incoming, "look-g2-2.png"), "utf8"), "look-2", "the waiting one stays");
    assert.equal(await exists(incoming), true, "and so does the directory holding it");
    await store.close();
  });

  it("never touches candidates/, which is not staging", async () => {
    // The main-photo accept path reads the chosen candidate back out of candidates/, and the
    // scan lists the ones nobody promoted. Deleting there would take the picture the user is
    // still choosing from.
    const { dir, store } = await open();
    const landed = "references/maren-kest/candidates/main-photo-g3-1.png";
    await mkdir(join(dir, "references", "maren-kest", "candidates"), { recursive: true });
    await writeFile(join(dir, landed), "candidate-bytes");

    const take = await recordReferenceTake(
      store,
      jobFor("main-photo-candidate", "maren-kest/g3/1", landed) as never,
    );
    assert.ok(take);
    assert.equal(await readFile(join(dir, landed), "utf8"), "candidate-bytes", "the candidate survives");
    await store.close();
  });

  it("never touches a candidate the user uploaded themselves", async () => {
    const { dir, store } = await open();
    const candidate = "references/maren-kest/candidates/from-my-camera.png";
    await mkdir(join(dir, "references", "maren-kest", "candidates"), { recursive: true });
    await writeFile(join(dir, candidate), "my-own-photo");

    const take = await recordUploadedReferenceTake(store, "maren-kest", candidate);
    assert.equal(await readFile(join(dir, candidate), "utf8"), "my-own-photo", "their file stays theirs");
    assert.ok(await exists(join(dir, "references", "maren-kest", "takes", take.id, take.media!)));
    await store.close();
  });

  it("leaves a sheet whose own slug is `incoming` alone", async () => {
    // A sheet named "Incoming" slugs to `incoming`, so its candidates land at
    // references/incoming/candidates/. A cleanup that looked for any path segment called
    // `incoming` would match that and delete the picture the user is choosing from.
    const { dir, store } = await open();
    const landed = "references/incoming/candidates/main-photo-g5-1.png";
    await mkdir(join(dir, "references", "incoming", "candidates"), { recursive: true });
    await writeFile(join(dir, landed), "candidate-bytes");

    const take = await recordReferenceTake(
      store,
      {
        ...jobFor("main-photo-candidate", "incoming/g5/1", landed),
        params: {
          prompt: "a portrait",
          references: [],
          provenance: { canonRevision: 42, sheets: { incoming: 4 }, artDirectionVersion: 3 },
        },
      } as never,
    );
    assert.ok(take);
    assert.equal(await readFile(join(dir, landed), "utf8"), "candidate-bytes", "the candidate survives");
    await store.close();
  });

  it("leaves nothing at the destination when the copy cannot finish", async () => {
    // The skip-if-present shortcut is only safe while a present file is a whole one. The media
    // stages to .tmp-<ulid> and renames, so the destination appears whole or not at all — where
    // copying straight to the target would leave a partial file after a crash mid-write, which
    // the next pass would take for finished, skip, and then delete the intact source behind.
    // A copy that cannot finish stands in for that crash: it must leave the take empty, so a
    // replay copies again rather than adopting a stub.
    const { dir, store } = await open();
    const landed = "references/maren-kest/incoming/character-sheet-g6.png";
    const job = jobFor("character-sheet", "maren-kest/g6", landed);
    await mkdir(join(dir, "references", "maren-kest", "incoming"), { recursive: true });
    // No file at `landed`: the copy fails.
    await assert.rejects(() => recordReferenceTake(store, job as never));

    const takeDir = join(dir, "references", "maren-kest", "takes", `tk_${job.id.slice(3)}`);
    const left = await readdir(takeDir).catch(() => [] as string[]);
    assert.deepEqual(left, [], "no stub media, no take.json, and no temporary file left to be mistaken for either");
    await store.close();
  });

  it("replays without needing the staging copy it already removed", async () => {
    // Finalization is retryable from Activity, and the main-photo accept path re-enters it for
    // recovery. A second pass must not fail because the first one tidied up.
    const { dir, store } = await open();
    const landed = "references/maren-kest/incoming/character-sheet-g4.png";
    await mkdir(join(dir, "references", "maren-kest", "incoming"), { recursive: true });
    await writeFile(join(dir, landed), "sheet-bytes");
    const job = jobFor("character-sheet", "maren-kest/g4", landed);

    const first = await recordReferenceTake(store, job as never);
    assert.ok(first);
    assert.equal(await exists(join(dir, landed)), false);
    const again = await recordReferenceTake(store, job as never);
    assert.ok(again, "the replay answers with the take rather than failing on a missing source");
    assert.equal(again.id, first.id);
    assert.equal(
      await readFile(join(dir, "references", "maren-kest", "takes", first.id, first.media!), "utf8"),
      "sheet-bytes",
    );
    await store.close();
  });
});

describe("what a world export leaves behind (issue 231)", () => {
  it("does not exclude incoming/, because a kit tile lives there", () => {
    // The issue proposed excluding `incoming` as a backstop. It cannot be: `supersedeTile`
    // records a reference tile's kit row as `incoming/<angle>.png` and does not move the file,
    // so excluding the directory would hand someone an export whose kit points at pictures the
    // export did not carry. Removing the duplicate at the source is the whole fix; there is no
    // second copy left for an exclusion to catch.
    assert.equal(WORLD_EXPORT_EXCLUDED.includes("incoming"), false);
  });
});
