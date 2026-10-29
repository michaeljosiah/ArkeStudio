import assert from "node:assert/strict";
import { it } from "node:test";
import { cp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkWorldImport } from "../../src/world/import-world.js";
import { installSampleWorld } from "../../src/world/sample-world.js";
import { tempDir } from "../tmp.js";
import { FIXTURE_WORLD } from "./helpers.js";

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

it("cancelled import never publishes a partial world", async () => {
  const root = await tempDir("arke-import-cancel-");
  const abort = new AbortController(); abort.abort();
  await assert.rejects(installSampleWorld({ sourceDir: FIXTURE_WORLD, appRoot: root, signal: abort.signal }));
  assert.deepEqual(await readdir(join(root, "worlds")), []);
});
