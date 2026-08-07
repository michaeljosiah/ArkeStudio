import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { installSampleWorld, SampleWorldUnavailable, sampleWorldAvailable } from "../../src/world/sample-world.js";
import { readWorldMeta, WorldOpenError } from "../../src/world/scan.js";
import { tempDir } from "../tmp.js";
import { FIXTURE_WORLD, WORLD_ID } from "./helpers.js";

/** An app root with the skeleton `installSampleWorld` expects to land in. */
async function makeRoot(): Promise<string> {
  const root = await tempDir("arke-sample-");
  await mkdir(join(root, "worlds"), { recursive: true });
  return root;
}

describe("installing the sample world", () => {
  it("copies it in under an identity of its own", async () => {
    const root = await makeRoot();
    const installed = await installSampleWorld({ sourceDir: FIXTURE_WORLD, appRoot: root });

    assert.equal(installed.slug, "the-undersong");
    assert.equal(installed.name, "The Undersong");
    assert.notEqual(installed.worldId, WORLD_ID, "a copy claiming the shipped id would shadow it");

    const meta = await readWorldMeta(join(root, "worlds", "the-undersong"));
    assert.equal(meta.worldId, installed.worldId);
    assert.equal(meta.slug, "the-undersong");
  });

  it("brings the world as authored, history and all", async () => {
    const root = await makeRoot();
    const { slug } = await installSampleWorld({ sourceDir: FIXTURE_WORLD, appRoot: root });
    const dir = join(root, "worlds", slug);

    // The document, not a re-enactment of someone making it: the change log, the art direction,
    // the proposal still waiting at the gate.
    const changes = await readFile(join(dir, "changes.jsonl"), "utf8");
    assert.ok(changes.trim().length > 0, "the world should arrive with its own history");
    await stat(join(dir, "art-direction", "art-direction.json"));
    const proposals = await readdir(join(dir, ".proposals"));
    assert.ok(proposals.length > 0, "the staged proposal is part of what makes it worth installing");

    // Timestamps are the world's, not today's — see the note in sample-world.ts.
    const source = await readWorldMeta(FIXTURE_WORLD);
    const meta = await readWorldMeta(dir);
    assert.equal(meta.created, source.created);
    assert.equal(meta.updated, source.updated);
  });

  it("makes the second install a world of its own rather than an overwrite", async () => {
    const root = await makeRoot();
    const first = await installSampleWorld({ sourceDir: FIXTURE_WORLD, appRoot: root });
    const second = await installSampleWorld({ sourceDir: FIXTURE_WORLD, appRoot: root });

    assert.equal(second.slug, "the-undersong-2");
    assert.notEqual(second.worldId, first.worldId);
    assert.equal((await readWorldMeta(join(root, "worlds", "the-undersong"))).worldId, first.worldId);
  });

  it("leaves the source exactly as it found it", async () => {
    const root = await makeRoot();
    const before = await readFile(join(FIXTURE_WORLD, "world.json"), "utf8");
    await installSampleWorld({ sourceDir: FIXTURE_WORLD, appRoot: root });
    assert.equal(await readFile(join(FIXTURE_WORLD, "world.json"), "utf8"), before);
  });

  it("makes no scratch directory in the app root", async () => {
    // The app root is a folder people open from Settings; a stray dot-directory in it is a
    // question they should never have to ask. Nothing is staged now, so nothing is left.
    const root = await makeRoot();
    await installSampleWorld({ sourceDir: FIXTURE_WORLD, appRoot: root });
    await assert.rejects(stat(join(root, ".installing")));
  });

  it("copies in place, and a world without its gate file is not a world", async () => {
    // The reason there is no rename: `world.json` is written last, and a directory lacking it
    // fails `readWorldMeta` as not-a-world — which listWorlds already skips. Copying in place is
    // therefore invisible until it is finished, and on Windows it avoids renaming a tree whose
    // files a scanner may still hold open (EPERM).
    const root = await makeRoot();
    const { slug } = await installSampleWorld({ sourceDir: FIXTURE_WORLD, appRoot: root });
    const dir = join(root, "worlds", slug);
    assert.equal((await readWorldMeta(dir)).slug, slug, "the finished world opens");

    await rm(join(dir, "world.json"));
    await assert.rejects(readWorldMeta(dir), (err: unknown) => {
      assert.ok(err instanceof WorldOpenError);
      assert.equal(err.reason, "not-a-world", "an unfinished copy is skipped, not reported as damage");
      return true;
    });
  });

  it("does not carry the application's own scratch files across", async () => {
    // A source that has been opened by the app has an index and a lock beside the world. Neither
    // belongs to the document, and a copied lock would be a lock over nothing.
    const source = join(await tempDir("arke-sample-src-"), "the-undersong");
    const root = await makeRoot();
    await mkdir(join(source, ".cache"), { recursive: true });
    await writeFile(join(source, "world.json"), await readFile(join(FIXTURE_WORLD, "world.json")));
    await writeFile(join(source, ".lock"), "held");
    await writeFile(join(source, "index.db"), "sqlite");
    await writeFile(join(source, ".cache", "scratch"), "x");

    const { slug } = await installSampleWorld({ sourceDir: source, appRoot: root });
    const landed = await readdir(join(root, "worlds", slug));
    assert.deepEqual(landed, ["world.json"]);
  });

  it("says why when this build carries no sample world", async () => {
    const root = await makeRoot();
    await assert.rejects(
      installSampleWorld({ sourceDir: join(root, "nothing-here"), appRoot: root }),
      (err: unknown) => {
        assert.ok(err instanceof SampleWorldUnavailable);
        assert.match(err.message, /does not carry/);
        return true;
      },
    );
  });

  it("says why when what it points at is not a world", async () => {
    const root = await makeRoot();
    const notAWorld = await tempDir("arke-sample-empty-");
    await assert.rejects(
      installSampleWorld({ sourceDir: notAWorld, appRoot: root }),
      (err: unknown) => {
        assert.ok(err instanceof SampleWorldUnavailable);
        assert.match(err.message, /could not be opened/);
        return true;
      },
    );
  });
});

describe("asking whether there is a sample world", () => {
  it("answers for the shipped one, a build without one, and a folder that is not a world", async () => {
    assert.equal(await sampleWorldAvailable(FIXTURE_WORLD), true);
    assert.equal(await sampleWorldAvailable(null), false);
    assert.equal(await sampleWorldAvailable(await tempDir("arke-sample-none-")), false);
  });
});
