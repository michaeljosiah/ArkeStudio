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

  it("records a look chosen at genesis as world look v1, accepted, with no history", async () => {
    const root = await tempDir("arke-create-look-");
    const provider = new FsWorldProvider(root, { clock: CLOCK });
    const { worldId } = await provider.createWorld({
      name: "The Undersong",
      tone: "quiet dread",
      artDirection: "Weathered realism with visible brushwork.",
    });
    const bundle = await provider.loadWorld(worldId);
    assert.equal(bundle.artDirection.version, 1);
    assert.equal(bundle.artDirection.description, "Weathered realism with visible brushwork.");
    // Chosen, not derived — the screen shows those differently, and a world born with a look
    // must not claim its words came from tone and genre.
    assert.equal(bundle.artDirection.derived, false);
    assert.deepEqual(bundle.artDirection.history, []);
    await provider.close();
  });

  it("reads the world's cloned voices, keeping what parses (SPEC-022 §2.3)", async () => {
    const root = await tempDir("arke-cloned-voices-");
    const provider = new FsWorldProvider(root, { clock: CLOCK });
    const { worldId, slug } = await provider.createWorld({ name: "The Undersong" });
    const dir = join(root, "worlds", slug);
    await mkdir(toExtendedLength(join(dir, "voices")), { recursive: true });
    await writeFile(
      toExtendedLength(join(dir, "voices", "voices.json")),
      JSON.stringify({
        voices: [
          {
            id: "harbour-glass",
            name: "Harbour glass",
            clip: "voices/harbour-glass.wav",
            description: "Low, dry, unhurried. Coastal.",
            attributes: ["low", "dry", "unhurried", "coastal"],
            consent: true,
            created: "2026-08-18T10:00:00.000Z",
          },
          // Malformed: no id. It costs itself, never the voice beside it — the same posture the
          // sheet scan takes, and the reason a hand-edit cannot empty a world's library.
          { name: "broken", clip: "voices/broken.wav" },
        ],
      }),
      "utf8",
    );
    const bundle = await provider.loadWorld(worldId);
    assert.deepEqual(
      bundle.clonedVoices.map((v) => v.id),
      ["harbour-glass"],
    );
    assert.equal(bundle.clonedVoices[0]?.clip, "voices/harbour-glass.wav");
    await provider.close();
  });

  it("a world with no voices file has no cloned voices, which is not a problem", async () => {
    const root = await tempDir("arke-no-voices-");
    const provider = new FsWorldProvider(root, { clock: CLOCK });
    const { worldId } = await provider.createWorld({ name: "The Undersong" });
    const bundle = await provider.loadWorld(worldId);
    assert.deepEqual(bundle.clonedVoices, []);
    assert.deepEqual(
      bundle.problems.filter((p) => p.path.includes("voices")),
      [],
      "an absent library is the normal state, never a reported failure",
    );
    await provider.close();
  });

  it("leaves no record when the look was deferred, so it still resolves from tone and genre", async () => {
    const root = await tempDir("arke-create-nolook-");
    const provider = new FsWorldProvider(root, { clock: CLOCK });
    const { worldId } = await provider.createWorld({ name: "The Undersong", tone: "quiet dread" });
    const bundle = await provider.loadWorld(worldId);
    assert.equal(bundle.artDirection.derived, true);
    assert.equal(
      await stat(join(root, "worlds", "the-undersong", "art-direction")).then(
        () => true,
        () => false,
      ),
      false,
      "no folder at all — an empty one would read as a look that was set and then emptied",
    );
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
    await writeFile(join(mediaDir, "voice.flac"), "flac");
    const provider = new FsWorldProvider(root, { clock: CLOCK });

    assert.equal(
      (await provider.serveMedia("the-undersong", "references/maren-kest/takes/tk_formats/portrait.jpg"))?.contentType,
      "image/jpeg",
    );
    assert.equal(
      (await provider.serveMedia("the-undersong", "references/maren-kest/takes/tk_formats/portrait.webp"))?.contentType,
      "image/webp",
    );
    assert.equal(
      (await provider.serveMedia("the-undersong", "references/maren-kest/takes/tk_formats/voice.flac"))?.contentType,
      "audio/flac",
    );
    await provider.close();
  });

  /*
   * The one resolver behind both reading a picture and saving one (issue 478).
   *
   * The desktop host answers a save by asking this the same question the HTTP side asks, so a
   * path the renderer could not fetch is a path it cannot write out either. What that turns on
   * is that this refuses rather than clamps: a traversal, a slug that is not a slug, and a file
   * type nobody displays all come back as nothing at all.
   */
  it("refuses anything that is not a media file inside the named world", async () => {
    const { root } = await makeTempRoot();
    await writeFile(join(root, "settings.json"), "{}");
    const mediaDir = join(root, "worlds", "the-undersong", "artifacts");
    await mkdir(mediaDir, { recursive: true });
    await writeFile(join(mediaDir, "key-art.png"), "png");
    await writeFile(join(mediaDir, "notes.txt"), "not media");
    const provider = new FsWorldProvider(root, { clock: CLOCK });

    assert.ok(await provider.serveMedia("the-undersong", "artifacts/key-art.png"), "the picture itself resolves");
    assert.equal(
      (await provider.serveMedia("the-undersong", "artifacts/key-art.png"))?.contentType,
      "image/png",
    );
    for (const refused of [
      "../settings.json",
      "artifacts/../../settings.json",
      "artifacts\\..\\..\\settings.json",
      "./artifacts/key-art.png",
      "artifacts//key-art.png",
      "artifacts/notes.txt",
      "artifacts",
      "artifacts/missing.png",
    ]) {
      assert.equal(await provider.serveMedia("the-undersong", refused), null, `served ${refused}`);
    }
    for (const slug of ["../worlds/the-undersong", "The-Undersong", "", "the undersong"]) {
      assert.equal(await provider.serveMedia(slug, "artifacts/key-art.png"), null, `served world ${slug}`);
    }
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
  it("scans a 50-sheet, 200-entry, 500-take world in under ten seconds", async (t) => {
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
    const corpusStarted = performance.now();
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
    // Reported next to the scan, not asserted against — the note below says why.
    const wrote = performance.now() - corpusStarted;

    /*
     * Three scans, and the best one is the answer.
     *
     * SPEC-002 §2.13 and SPEC-003 R-21 both want the same thing: a cold full scan of this world —
     * 50 sheets, 200 entries, 500 takes, which is why the corpus above is that size and not a
     * larger one — inside ten seconds, so that the index rebuild budget holds. That is a floor:
     * a claim about the time this work can be done in on hardware a user would recognise. So the
     * run that got a fair share of the machine is the one that answers it, and a runner that
     * descheduled us mid-scan has said nothing about the scan.
     *
     * Re-scanning measures the same thing each time. `scanWorld` reads and never writes, it keeps
     * nothing between calls — cold means no warm index (SPEC-003), and every pass is that — and
     * the corpus was in page cache from being written moments ago, so the third pass is no warmer
     * than the first.
     */
    const scans: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = performance.now();
      const { bundle, problems } = await scanWorld(dir);
      scans.push(performance.now() - started);

      assert.deepEqual(problems, []);
      assert.equal(bundle.sheets.length, 50);
      assert.equal(bundle.canon.length, 200);
      assert.equal(bundle.productions[0]!.takes.length, 500);
    }
    const best = Math.min(...scans);
    const attempts = scans.map((ms) => Math.round(ms)).join(", ");

    /*
     * Why the corpus write is printed rather than divided by.
     *
     * It used to be the denominator of a ratio budget — scan against write, on the reasoning that
     * writing the same 750 files on the same disk moments earlier moves with the hardware the way
     * the scan does, and so survives a slow runner where a wall-clock assertion would not.
     *
     * It does not move with it. Nothing here is fsynced, so the write measures what it costs to
     * create 750 files and hand their contents to the kernel, while the scan is readdir, parse,
     * validate and hash over data already in cache. Different costs, and the platform decides how
     * different: run alone on GitHub's runners, the same corpus and the same code write in 53–60ms
     * on ubuntu-latest and 563–2112ms on windows-latest, against scans of 203–260ms and 303–518ms.
     * The scan moves by less than a factor of two between them; the write moves by ten to forty,
     * and so the ratio moves by ten — about 4x on Linux, about 0.5x on Windows — because the
     * denominator is reporting the cost of creating a file on NTFS, not the speed of the machine.
     * A budget of 8x was therefore a ceiling of roughly 450ms on Linux and of several seconds on
     * Windows: the ten-second obligation rewritten as half a second on the runner least able to
     * keep it, and left vacuous on the platform we ship.
     *
     * And this test does not run alone. `node --test` runs test files in parallel, so the scan
     * competes with the rest of the suite for the runner's four CPUs — which costs the scan more
     * than the write, the scan being the CPU-bound half. In twelve full-suite runs on ubuntu-latest
     * the write came in at 68–112ms and the first scan at 290–783ms, putting the old ratio at
     * 3.5–7.0x against its budget of 8. The worst of those was 113ms of margin from failing, on a
     * run that passed. That is the shape of the flake: a branch whose only diff was six markdown
     * files went red at 8.9x on a 544ms scan, which is not an outlier but the same distribution one
     * notch out. The figure is still worth reading, because a scan that suddenly costs many times
     * its own corpus write is worth a look, but it is a reading and not a gate.
     */
    t.diagnostic(
      `cold scan ${Math.round(best)}ms, best of [${attempts}]ms; corpus write ${Math.round(wrote)}ms ` +
        `(scan is ${(best / wrote).toFixed(1)}x the write)`,
    );

    assert.ok(
      best < 10_000,
      `cold scan took ${Math.round(best)}ms, the best of [${attempts}]ms — the budget is 10s`,
    );
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
