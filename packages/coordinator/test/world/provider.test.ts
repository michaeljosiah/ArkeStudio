import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { tempDir } from "../tmp.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { atomicWriteFile } from "../../src/world/atomic.js";
import { toExtendedLength } from "../../src/world/paths.js";
import { scanWorld } from "../../src/world/scan.js";
import { makeTempRoot } from "./helpers.js";

const CLOCK = () => "2026-08-01T12:00:00.000Z";

describe("FsWorldProvider (R-1, T-14)", () => {
  it("creates the app root skeleton on first run without prompting (R-1)", async () => {
    const root = join(await tempDir("arke-approot-"), "deeper", "ArkeStudio");
    const provider = new FsWorldProvider(root, { clock: CLOCK });
    await provider.ensureAppRoot();
    assert.ok(JSON.parse(await readFile(join(root, "config.json"), "utf8")));
    assert.deepEqual(await provider.listWorlds(), []);
  });

  it("ignores worlds/ children without a world.json rather than reporting corruption (R-1)", async () => {
    const { root } = await makeTempRoot();
    await mkdir(join(root, "worlds", "just-notes"), { recursive: true });
    await writeFile(join(root, "worlds", "just-notes", "notes.txt"), "keep me", "utf8");
    const provider = new FsWorldProvider(root, { clock: CLOCK });
    const worlds = await provider.listWorlds();
    assert.equal(worlds.length, 1);
    assert.equal(worlds[0]!.slug, "the-undersong");
  });

  it("creates a world end to end: slug, world.json, change line, then opens it", async () => {
    const root = await tempDir("arke-create-");
    const provider = new FsWorldProvider(root, { clock: CLOCK });
    const { worldId, slug } = await provider.createWorld({
      name: "The Undersong",
      logline: "A drowned god still sings.",
      tone: "quiet dread",
    });
    assert.equal(slug, "the-undersong");

    const bundle = await provider.loadWorld(worldId);
    assert.equal(bundle.meta.name, "The Undersong");
    assert.equal(bundle.meta.canonRevision, 0);
    assert.equal(bundle.meta.nextCanonId, 1);
    assert.equal(bundle.changes.length, 1);

    // A second world with a colliding name gets a distinct slug, case-insensitively (R-7).
    const second = await provider.createWorld({ name: "the undersong" });
    assert.equal(second.slug, "the-undersong-2");
    await provider.close();
  });

  it("opens a scoped locked store without changing the renderer's selected world", async () => {
    const { root, worldDir } = await makeTempRoot();
    const provider = new FsWorldProvider(root, { clock: CLOCK });
    const selected = (await provider.listWorlds())[0]!;
    await provider.loadWorld(selected.worldId);
    const background = await provider.createWorld({ name: "Background World" });

    await provider.withWorldStore(background.worldId, async (store) => {
      await store.ownedWrite(() => writeFile(join(store.dir, "background-result.txt"), "landed", "utf8"));
    });

    assert.equal(provider.openStore()?.worldId, selected.worldId);
    assert.equal(provider.openStore()?.dir, worldDir);
    const worlds = await provider.listWorlds();
    const backgroundSlug = worlds.find((world) => world.worldId === background.worldId)!.slug;
    assert.equal(await readFile(join(root, "worlds", backgroundSlug, "background-result.txt"), "utf8"), "landed");
    await assert.rejects(readFile(join(worldDir, "background-result.txt"), "utf8"));
    await provider.close();
  });

  it("serves preserved character image formats with matching MIME types", async () => {
    const { root } = await makeTempRoot();
    const mediaDir = join(root, "worlds", "the-undersong", "references", "maren-kest", "takes", "tk_formats");
    await mkdir(mediaDir, { recursive: true });
    await writeFile(join(mediaDir, "portrait.jpg"), "jpeg");
    await writeFile(join(mediaDir, "portrait.webp"), "webp");
    const provider = new FsWorldProvider(root, { clock: CLOCK });

    assert.equal(
      (await provider.serveMedia("the-undersong", "references/maren-kest/takes/tk_formats/portrait.jpg"))?.contentType,
      "image/jpeg",
    );
    assert.equal(
      (await provider.serveMedia("the-undersong", "references/maren-kest/takes/tk_formats/portrait.webp"))?.contentType,
      "image/webp",
    );
    await provider.close();
  });

  it("reads and writes the deepest path the layout allows via extended-length prefixes (R-10)", async () => {
    // Build a path beyond the classic 260-char limit and prove our own I/O handles it.
    const base = await tempDir("arke-deep-");
    const segments = Array.from({ length: 12 }, () => "a".repeat(24));
    const deepDir = join(base, ...segments);
    const deepFile = join(deepDir, "clip-placeholder.txt");
    assert.ok(deepFile.length > 300, `constructed path is ${deepFile.length} chars`);
    await atomicWriteFile(deepFile, "deep content");
    assert.equal(await readFile(toExtendedLength(deepFile), "utf8"), "deep content");
  });
});

describe("cold-scan budget (§2.13)", () => {
  it("scans a 50-sheet, 200-entry, 500-take world in under ten seconds", async () => {
    const root = await tempDir("arke-bench-");
    const dir = join(root, "benchmark");
    await mkdir(join(dir, "characters"), { recursive: true });
    await mkdir(join(dir, "canon"), { recursive: true });
    const takeDirBase = join(dir, "productions", "bench", "takes");
    await writeFile(
      join(dir, "world.json"),
      JSON.stringify({
        worldId: "01J8F3K2QW9VZX4N7M0RTYB6ZZ",
        slug: "benchmark",
        schemaVersion: 1,
        name: "Benchmark",
        canonRevision: 1,
        nextCanonId: 201,
        created: "2026-08-01T00:00:00Z",
        updated: "2026-08-01T00:00:00Z",
      }),
      "utf8",
    );
    await mkdir(join(dir, "productions", "bench", "scenes"), { recursive: true });
    await writeFile(
      join(dir, "productions", "bench", "production.json"),
      JSON.stringify({
        id: "bench",
        format: "video",
        title: "Bench",
        status: "in-progress",
        created: "2026-08-01T00:00:00Z",
        updated: "2026-08-01T00:00:00Z",
      }),
      "utf8",
    );
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      writes.push(
        writeFile(
          join(dir, "characters", `char-${i}.md`),
          `---\nid: char-${i}\ntype: character\nname: Character ${i}\nversion: 1\nstatus: locked\ncanonRules: []\nlinks: []\ncreated: "2026-08-01"\nupdated: "2026-08-01"\n---\n\n## Essence\nCharacter number ${i}.\n`,
          "utf8",
        ),
      );
    }
    for (let i = 1; i <= 200; i++) {
      writes.push(
        writeFile(
          join(dir, "canon", `CANON-${String(i).padStart(3, "0")}.md`),
          `---\nid: CANON-${String(i).padStart(3, "0")}\ntype: lore\ntitle: Entry ${i}\nstatus: settled\nintroducedAt: 1\nsettledAt: 1\nlinks: []\n---\n\nStatement ${i}.\n`,
          "utf8",
        ),
      );
    }
    await Promise.all(writes);
    const takeWrites: Promise<void>[] = [];
    for (let i = 0; i < 500; i++) {
      const id = `tk_01J8A${String(i).padStart(21, "0")}`;
      takeWrites.push(
        mkdir(join(takeDirBase, id), { recursive: true }).then(() =>
          writeFile(
            join(takeDirBase, id, "take.json"),
            JSON.stringify({
              id,
              jobId: "jb_01J8E0000000000000000000J1",
              coversShots: ["sh_1"],
              kind: "clip",
              provider: "fal",
              model: "bench",
              provenance: { canonRevision: 1, sheets: {} },
              references: [],
              params: {},
              cost: { estimatedMicroUsd: 1000, actualMicroUsd: null },
              dispatchedAt: "2026-08-01T00:00:00Z",
            }),
            "utf8",
          ),
        ),
      );
    }
    await Promise.all(takeWrites);

    const started = performance.now();
    const { bundle, problems } = await scanWorld(dir);
    const elapsed = performance.now() - started;

    assert.deepEqual(problems, []);
    assert.equal(bundle.sheets.length, 50);
    assert.equal(bundle.canon.length, 200);
    assert.equal(bundle.productions[0]!.takes.length, 500);
    assert.ok(elapsed < 10_000, `cold scan took ${Math.round(elapsed)}ms — budget is 10s`);
  });
});

describe("archiving a world", () => {
  it("moves the folder whole, and the library stops listing it", async () => {
    const { root } = await makeTempRoot();
    const provider = new FsWorldProvider(root, { clock: CLOCK });
    const [world] = await provider.listWorlds();
    assert.ok(world);

    const { folder } = await provider.archiveWorld(world.worldId);
    assert.equal(folder, join(root, "archive", "the-undersong"));
    // Whole means whole: the journal and the world file travel with it, so putting it back is
    // a move rather than a restore from anything.
    assert.ok(JSON.parse(await readFile(join(folder, "world.json"), "utf8")).worldId === world.worldId);
    await stat(join(folder, "changes.jsonl"));
    await assert.rejects(stat(join(root, "worlds", "the-undersong")), "and it is no longer in the library");
    assert.deepEqual(await provider.listWorlds(), []);
    await provider.close();
  });

  it("archives an open world by closing it first", async () => {
    // Windows will not move a directory holding an open index, and the error it gives for that
    // reads as a permissions problem — so the close is part of archiving, not the caller's job.
    const { root } = await makeTempRoot();
    const provider = new FsWorldProvider(root, { clock: CLOCK });
    const [world] = await provider.listWorlds();
    assert.ok(world);
    await provider.loadWorld(world.worldId);

    const { folder } = await provider.archiveWorld(world.worldId);
    await stat(join(folder, "world.json"));
    assert.equal(provider.openStore(), null, "the world is no longer open");
    await provider.close();
  });

  it("keeps the first archive when a world of the same name is archived again", async () => {
    const { root } = await makeTempRoot();
    const provider = new FsWorldProvider(root, { clock: CLOCK });
    const first = (await provider.listWorlds())[0]!;
    await provider.archiveWorld(first.worldId);

    // A second world under the same slug — archived, it must not overwrite the first.
    const { worldId } = await provider.createWorld({ name: "The Undersong" });
    const { folder } = await provider.archiveWorld(worldId);
    assert.notEqual(folder, join(root, "archive", "the-undersong"));
    await stat(join(root, "archive", "the-undersong", "world.json"));
    await stat(join(folder, "world.json"));
    await provider.close();
  });
});
