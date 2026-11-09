import assert from "node:assert/strict";
import { it } from "node:test";
import { appendFile, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scanWorld } from "../../src/world/scan.js";
import { ScanCache } from "../../src/world/scan-cache.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "./helpers.js";

/**
 * An open store's scans keep what they read by file identity (issue 2793). These are the cases the
 * cache must never hide: an edit made outside the app, even one that keeps the size and restores
 * the mtime, an addition and a deletion.
 */
const CLOCK = () => "2026-11-08T12:00:00.000Z";
const SIDECAR = join("artifacts", "board-v2.png.json");
const TAKE = join("productions", "saltlight", "takes", "tk_01J8A0000000000000000000A1");

it("an open store's rescan sees every outside edit to records it has already read", async () => {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  try {
    // A sheet's text, changed.
    const sheet = join(dir, "characters", "bray-half-hitch.md");
    await writeFile(sheet, (await readFile(sheet, "utf8")).replace("three belts", "four belts"));

    // An artifact rewritten to the same length with its mtime put back, as a restore tool does.
    const sidecar = join(dir, SIDECAR);
    const before = await stat(sidecar);
    const raw = await readFile(sidecar, "utf8");
    const edited = raw.replace("2026-07-29T11:02:00Z", "2026-07-29T11:03:00Z");
    assert.equal(edited.length, raw.length);
    await writeFile(sidecar, edited);
    await utimes(sidecar, before.atime, before.mtime);

    // One artifact added, one take deleted.
    await writeFile(join(dir, "artifacts", "added.png"), await readFile(join(dir, "artifacts", "board-v2.png")));
    await writeFile(join(dir, "artifacts", "added.png.json"), raw.replace("ar_01J8G0000000000000000000R3", "ar_01J8G0000000000000000000Z9").replace(/board-v2\.png/g, "added.png"));
    await rm(join(dir, TAKE), { recursive: true });

    const bundle = await store.reload();
    assert.deepEqual(bundle.externalEdits.map(edit => edit.path).sort(), ["artifacts/added.png.json", "artifacts/board-v2.png.json",
      "characters/bray-half-hitch.md", "productions/saltlight/takes/tk_01J8A0000000000000000000A1/take.json"], "each change is an outside edit");
    assert.equal(bundle.artifacts.find(artifact => artifact.id === "ar_01J8G0000000000000000000R3")?.created, "2026-07-29T11:03:00Z", "the restored mtime did not hide the new bytes");
    assert.ok(bundle.artifacts.some(artifact => artifact.id === "ar_01J8G0000000000000000000Z9"), "an added record appears");
    assert.equal(bundle.productions.find(p => p.meta.id === "saltlight")?.takes.some(take => take.id === "tk_01J8A0000000000000000000A1"), false, "a deleted record goes");
  } finally {
    await store.close();
  }
});

it("shares an unchanged record between scans and reparses one that changed", async () => {
  const dir = await makeTempWorld();
  const cache = new ScanCache();
  const first = await scanWorld(dir, { cache });
  const second = await scanWorld(dir, { cache });
  const id = "ar_01J8G0000000000000000000R3";
  const before = first.bundle.artifacts.find(artifact => artifact.id === id)!;
  assert.equal(second.bundle.artifacts.find(artifact => artifact.id === id), before, "the same parsed record, not a reread");
  assert.deepEqual(second.manifest, first.manifest);

  const sidecar = join(dir, SIDECAR);
  await writeFile(sidecar, (await readFile(sidecar, "utf8")).replace('"board"', '"image"'));
  const third = await scanWorld(dir, { cache });
  const after = third.bundle.artifacts.find(artifact => artifact.id === id)!;
  assert.notEqual(after, before);
  assert.equal(after.kind, "image");
  assert.notEqual(third.manifest["artifacts/board-v2.png.json"], first.manifest["artifacts/board-v2.png.json"]);
  assert.deepEqual(third, await scanWorld(dir), "a cached scan answers what an uncached one does");
});

it("refolds a conversation once its log grows", async () => {
  const dir = await makeTempWorld();
  const cache = new ScanCache();
  const first = await scanWorld(dir, { cache });
  const conversation = first.bundle.conversations[0]!;
  const events = join(dir, ".conversations", conversation.id, "events.jsonl");
  const last = JSON.parse((await readFile(events, "utf8")).trim().split("\n").at(-1)!) as { seq: number };
  await appendFile(events, JSON.stringify({ schemaVersion: 1, seq: last.seq + 1, eventId: "wce_01J8K0000000000000000000E9", at: "2026-08-07T09:00:00Z",
    event: { type: "conversation.archived" } }) + "\n");
  const second = await scanWorld(dir, { cache });
  const uncached = await scanWorld(dir);
  assert.deepEqual(second.bundle.conversations, uncached.bundle.conversations);
  assert.equal(second.bundle.conversations[0]?.status, "archived", "the appended event is folded in");
  assert.notEqual(first.bundle.conversations[0]?.status, "archived");
});

it("shows a carried conversation once its founding marker is removed, though no other file changed", async () => {
  const dir = await makeTempWorld();
  const cache = new ScanCache();
  const id = (await scanWorld(dir)).bundle.conversations[0]!.id;
  const marker = join(dir, ".conversations", id, ".founding-incomplete");
  await writeFile(marker, "");
  assert.deepEqual((await scanWorld(dir, { cache })).bundle.conversations, [], "an interrupted handoff hides it");
  await rm(marker);
  assert.deepEqual((await scanWorld(dir, { cache })).bundle.conversations.map(row => row.id), [id], "removing the marker alone reveals it (codex on PR 2851)");
});
