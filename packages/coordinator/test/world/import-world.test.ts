import assert from "node:assert/strict";
import { it } from "node:test";
import { cp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkWorldImport } from "../../src/world/import-world.js";
import { installSampleWorld } from "../../src/world/sample-world.js";
import { tempDir } from "../tmp.js";
import { FIXTURE_WORLD, makeTempWorld } from "./helpers.js";
import { WorldStore } from "../../src/world/store.js";

it("imports a checked world as a new identity and preserves its source", async () => {
  const root = await tempDir("arke-import-dest-");
  const original = await readFile(join(FIXTURE_WORLD, "world.json"), "utf8");
  const source = await checkWorldImport(FIXTURE_WORLD, root, new AbortController().signal);
  assert.equal(source, await realpath(FIXTURE_WORLD));
  const result = await installSampleWorld({ appRoot: root, sourceDir: source });
  assert.notEqual(result.worldId, JSON.parse(original).worldId);
  assert.equal(await readFile(join(FIXTURE_WORLD, "world.json"), "utf8"), original);
});

it("refuses an open world and a source enclosing the destination", async () => {
  const root = await tempDir("arke-import-busy-");
  const source = join(root, "source"); await cp(FIXTURE_WORLD, source, { recursive: true });
  await writeFile(join(source, "world.lock"), "owner");
  await assert.rejects(checkWorldImport(source, root, new AbortController().signal), /Close this world/);
  const nested = join(source, "library"); await mkdir(nested);
  await assert.rejects(checkWorldImport(source, nested, new AbortController().signal), /containing your Arke library/);
});

it("imports a saved and closed world without changing its empty commit staging directory", async () => {
  const root = await tempDir("arke-import-saved-");
  const source = await makeTempWorld();
  const store = await WorldStore.open(source);
  try { await store.renameWorld("Saved world"); } finally { await store.close(); }
  assert.deepEqual(await readdir(join(source, ".commit")), ["staging"]);
  assert.equal(await checkWorldImport(source, root, new AbortController().signal), await realpath(source));
  const result = await installSampleWorld({ appRoot: root, sourceDir: source });
  assert.ok(result.worldId);
  assert.deepEqual(await readdir(join(source, ".commit", "staging")), []);
});

for (const pending of ["journal.json", "staging/unfinished/payload", "unexpected"]) {
  it(`refuses pending commit content ${pending} without modifying the source`, async () => {
    const root = await tempDir("arke-import-pending-");
    const source = await makeTempWorld();
    const file = join(source, ".commit", pending);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "retained pending work");
    await assert.rejects(checkWorldImport(source, root, new AbortController().signal), /pending save/);
    assert.equal(await readFile(file, "utf8"), "retained pending work");
  });
}

it("cancelled import never publishes a partial world", async () => {
  const root = await tempDir("arke-import-cancel-");
  const abort = new AbortController(); abort.abort();
  await assert.rejects(installSampleWorld({ sourceDir: FIXTURE_WORLD, appRoot: root, signal: abort.signal }));
  assert.deepEqual(await readdir(join(root, "worlds")), []);
});
