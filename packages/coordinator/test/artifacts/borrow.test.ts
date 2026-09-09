import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { storyTimelineFingerprint } from "@arke-studio/contracts";
import { listBorrowableArtifacts } from "../../src/artifacts/borrow.js";
import { fileArtifact } from "../../src/artifacts/filing.js";
import { importEditorMedia } from "../../src/productions/editor-import.js";
import { createProduction } from "../../src/productions/ops.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import type { MediaProbe } from "../../src/media/probe.js";

/**
 * Borrowing from another world (issue 1033): what a world offers — its placeable, world-owned
 * files, named as its own shelf names them, with the picture it has — and what a borrow leaves
 * behind on the file it copies in: the world it came from, as filing's provenance.
 */

const probe: MediaProbe = { async durationSec() { return 3; }, async info() { return { durationSec: 3, hasAudio: true, hasVideo: true }; } };

describe("what a world offers", () => {
  it("lists placeable world-owned files newest first, named by their links, with the picture each has", async (t) => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir);
    t.after(() => store.close());
    const bundle = store.getBundle();
    const sheet = bundle.sheets[0]!;
    const file = async (name: string, bytes: string, extra: { links?: string[]; production?: string | null } = {}) => {
      const path = join(dir, name);
      await writeFile(path, bytes);
      const outcome = await fileArtifact(store, { sourcePath: path, mediaProbe: probe, production: extra.production ?? null, ...(extra.links ? { links: extra.links } : {}) });
      assert.ok(outcome.outcome === "filed", `${name} filed`);
      return outcome.artifact;
    };
    const plate = await file("plate.png", "png bytes", { links: [sheet.id] });
    const clip = await file("clip.mp4", "film bytes");
    await file("notes.md", "# notes");
    const production = await createProduction(store, { title: "Scoped", medium: "video", frameRate: 24 });
    await file("scoped.mp4", "scoped bytes", { production });
    const rows = await listBorrowableArtifacts(store.getBundle(), dir);
    const byFile = new Map(rows.map((row) => [row.file, row]));
    assert.ok(!byFile.has("notes.md"), "a document has nothing to place");
    assert.ok(!byFile.has("scoped.mp4"), "a production's own file stays off the shelf (SPEC-020 R-13)");
    assert.ok(byFile.has("harbour-bells.wav"), "the fixture world's own sound is offered");
    assert.equal(byFile.get("plate.png")!.name, sheet.name, "named by what it is linked to (issue 1005)");
    assert.equal(byFile.get("plate.png")!.picture, "artifacts/plate.png", "a still is its own picture");
    assert.equal(byFile.get("clip.mp4")!.name, "clip.mp4", "a file nothing names keeps its name");
    assert.equal(byFile.get("clip.mp4")!.picture, null, "no poster drawn yet");
    assert.equal(byFile.get("clip.mp4")!.durationSec, 3);
    assert.ok(rows.findIndex((row) => row.id === clip.id) < rows.findIndex((row) => row.id === plate.id), "newest first");
    await mkdir(join(dir, ".index", "posters"), { recursive: true });
    await writeFile(join(dir, ".index", "posters", `${clip.id}.png`), "poster");
    const again = await listBorrowableArtifacts(store.getBundle(), dir);
    assert.equal(again.find((row) => row.id === clip.id)!.picture, `.index/posters/${clip.id}.png`, "the poster once it exists");
  });
});

describe("what a borrow leaves behind", () => {
  it("files the copy with the source world as its provenance and lists it in the Library", async (t) => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir);
    t.after(() => store.close());
    const id = await createProduction(store, { title: "Footage", medium: "video", frameRate: 24 });
    const production = () => store.getBundle().productions.find((candidate) => candidate.meta.id === id)!;
    const elsewhere = join(dir, "from-another-world.mp4");
    await writeFile(elsewhere, "borrowed bytes");
    const failures = await importEditorMedia(store, [elsewhere], {
      productionId: id, baseRevision: null, sourceFingerprint: storyTimelineFingerprint(production()), destination: "library",
    }, { mediaProbe: probe, importedFrom: "world:the-other-one", abandoned: () => false });
    assert.deepEqual(failures, []);
    const filed = store.getBundle().artifacts.find((artifact) => artifact.file === "from-another-world.mp4")!;
    assert.deepEqual(filed.origin, { by: "user", importedFrom: "world:the-other-one" });
    assert.equal(production().timeline?.status, "ready");
    if (production().timeline?.status !== "ready") return;
    assert.ok(production().timeline!.status === "ready" && (production().timeline as { timeline: { library: Array<{ kind: string; artifactId?: string }> } }).timeline.library.some((item) => item.kind === "artifact" && item.artifactId === filed.id));
  });
});
