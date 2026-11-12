import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { borrowableTakes, storyTimelineFingerprint,type ClientMessage, type DomainEvent, type WorldBundle } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { createProduction } from "../../src/productions/ops.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import type { MediaProbe } from "../../src/media/probe.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * A production's Cut using a shot made in another production of the same world (issue 2953):
 * the accepted take is copied into this production's Library as a world-owned file that says
 * where it came from, and the production it came from is read and never written.
 */

const SOURCE = "saltlight";
const ACCEPTED = "tk_01J8F0000000000000000000B2";
/** A clip of the same production that no shot accepted. */
const NOT_ACCEPTED = "tk_01J8D0000000000000000000D4";
const UNKNOWN = "tk_01J8Z0000000000000000000Z9";
const probe: MediaProbe = { async durationSec() { return 3; }, async info() { return { durationSec: 3, hasAudio: true, hasVideo: true }; } };

async function harness() {
  const { root, worldDir } = await makeTempRoot();
  // The fixture's takes carry no clip of their own; an accepted one needs its file to be offered at all.
  await writeFile(join(worldDir, "productions", SOURCE, "takes", ACCEPTED, "clip.mp4"), "accepted clip bytes");
  await writeFile(join(worldDir, "productions", SOURCE, "takes", NOT_ACCEPTED, "clip.mp4"), "other clip bytes");
  const provider = new FsWorldProvider(root, { clock: () => "2026-11-11T12:00:00.000Z" });
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    observeEvent: (event) => events.push(event),
    mediaProbe: probe,
  });
  const store = provider.openStore()!;
  const here = await createProduction(store, { title: "Harbour lights", medium: "video", frameRate: 24 });
  const production = (id: string) => store.getBundle().productions.find((candidate) => candidate.meta.id === id)!;
  let request = 0;
  const borrow = async (takeIds: string[], from = SOURCE) => {
    const before = events.length;
    const current = production(here);
    await coordinator.dispatch({
      kind: "borrow-takes", worldId: WORLD_ID, requestId: `01J8E1000000000000000000${String(++request).padStart(2, "0")}`, productionId: from, takeIds,
      editor: { productionId: here, baseRevision: current.timeline?.status === "ready" ? current.timeline.timeline.revision : null, sourceFingerprint: storyTimelineFingerprint(current), destination: "library" },
    } as ClientMessage);
    return events.slice(before).filter((event) => event.type === "queue.enqueue-result") as Array<Record<string, unknown>>;
  };
  const library = () => {
    const timeline = production(here).timeline;
    return timeline?.status === "ready" ? timeline.timeline.library : [];
  };
  return { provider, worldDir, store, here, borrow, library };
}

/** The world's files that say they came from the source production. */
function copied(store: { getBundle(): WorldBundle }) {
  return store.getBundle().artifacts.filter((artifact) => artifact.origin?.by === "user" && artifact.origin.importedFrom === `production:${SOURCE}`);
}

/** Every file under a folder with its hash: what "never written" is checked against. */
async function fingerprint(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[path.slice(dir.length)] = createHash("sha256").update(await readFile(path)).digest("hex");
  }
  return out;
}

describe("a shot from another production of this world (issue 2953)", () => {
  it("copies the accepted take into this production's Library, world-owned and named for where it came from", async () => {
    const { provider, worldDir, store, borrow, library } = await harness();
    try {
      const sourceDir = join(worldDir, "productions", SOURCE);
      const before = await fingerprint(sourceDir);
      const [result] = await borrow([ACCEPTED]);
      assert.deepEqual(result?.["failures"], []);
      assert.equal(result?.["disposition"], "not-queued");
      const filed = copied(store);
      assert.equal(filed.length, 1);
      const copy = filed[0]!;
      assert.equal(copy.production ?? null, null, "the world's file, as an upload beside the Cut is");
      assert.match(copy.file, /^saltlight-sc-\d+-shot-\d+\.mp4$/, "a take's own name is clip.mp4, which says nothing on a lane");
      assert.equal(await readFile(join(worldDir, "artifacts", copy.file), "utf8"), "accepted clip bytes");
      assert.ok(library().some((item) => item.kind === "artifact" && item.artifactId === copy.id), "listed in this production's Library");
      assert.deepEqual(await fingerprint(sourceDir), before, "the production it came from is untouched");

      // The same take again is the same bytes: filing keeps one artifact.
      const [again] = await borrow([ACCEPTED]);
      assert.deepEqual(again?.["failures"], []);
      assert.equal(copied(store).length, 1);
      assert.equal(library().filter((item) => item.kind === "artifact" && item.artifactId === copy.id).length, 1);
    } finally { await provider.close(); }
  });

  it("refuses a take that is not the accepted one, an unknown take and the production's own shots, writing nothing", async () => {
    const { provider, worldDir, store, here, borrow, library } = await harness();
    try {
      const sourceDir = join(worldDir, "productions", SOURCE);
      const before = await fingerprint(sourceDir);
      const shelf = (await readdir(join(worldDir, "artifacts"))).sort();
      const [refused] = await borrow([NOT_ACCEPTED, UNKNOWN]);
      assert.deepEqual((refused!["failures"] as Array<{ index: number; reason: string }>).map((failure) => [failure.index, failure.reason]), [
        [0, `${NOT_ACCEPTED}: no longer offered`],
        [1, `${UNKNOWN}: no longer offered`],
      ]);
      const [own] = await borrow([ACCEPTED], here);
      assert.match(JSON.stringify(own), /already in this production/);
      const [missing] = await borrow([ACCEPTED], "no-such-production");
      assert.match(JSON.stringify(missing), /That production is unavailable/);
      assert.deepEqual((await readdir(join(worldDir, "artifacts"))).sort(), shelf, "nothing filed");
      assert.equal(copied(store).length, 0);
      assert.deepEqual(library(), []);
      assert.deepEqual(await fingerprint(sourceDir), before);
    } finally { await provider.close(); }
  });

  it("offers only an accepted clip that is one shot's own file", async () => {
    const { provider, store } = await harness();
    try {
      const source = store.getBundle().productions.find((candidate) => candidate.meta.id === SOURCE)!;
      assert.deepEqual(borrowableTakes(source).map((row) => row.take.id), [ACCEPTED]);
      // The same production with its accepted take changed one way at a time.
      const offered = (change: Record<string, unknown>) => borrowableTakes({
        ...source, takes: source.takes.map((take) => (take.id === ACCEPTED ? ({ ...take, ...change } as typeof take) : take)),
      }).length;
      assert.equal(offered({ segment: { startSec: 0, endSec: 2 } }), 0, "a segment of a longer pass is not the shot's own file");
      assert.equal(offered({ coversShots: [...source.takes.find((take) => take.id === ACCEPTED)!.coversShots, "sh_13"] }), 0, "a pass over several shots shows more than the one");
      assert.equal(offered({ kind: "frame" }), 0, "a still is not a clip");
      assert.equal(offered({ media: undefined }), 0);
      assert.equal(offered({ media: "../clip.mp4" }), 0, "a file name, never a path");
    } finally { await provider.close(); }
  });
});
