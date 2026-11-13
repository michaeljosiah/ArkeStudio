import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SetupArchiveManifest, inspectSetupArchive } from "../../src/setup/archive-manifest.js";
import { SetupProcessRunner } from "../../src/setup/process.js";
import { systemTar } from "../../src/setup/local-setup.js";
import { tempDir } from "../tmp.js";

it("counts numeric GNU/BSD file, directory and link estimates across split metadata chunks", () => {
  const reader = new SetupArchiveManifest();
  reader.feed("-rw-r--r-- 0/0 123 2026-10-26 10:00 arbitrary name\ndrwxr-xr-x 0 0 0 0 Oct 26 10:00 ");
  reader.feed("folder/\nlrwxrwxrwx 0 0 0 5 Oct 26 10:00 link -> file");
  assert.equal(reader.finish(), 3 * 8192 + 128);
});

it("refuses unknown listing shapes, oversized lines, device records and unsafe expansion arithmetic", () => {
  for (const text of ["unexpected metadata\n", "crw-rw-rw- 0/0 1,3 2026-10-26 10:00 device\n", "-rw-r--r-- 0/0 9007199254740991 2026-10-26 10:00 huge\n", "x".repeat(65537)]) {
    assert.throws(() => { const reader = new SetupArchiveManifest(); reader.feed(text); reader.finish(); }, /Archive/);
  }
});

it("reads a real native archive's expansion without extracting it", { timeout: 90000 }, async () => {
  const root = await tempDir("arke-archive-manifest-"), source = join(root, "source"), archive = join(root, "source.tar.gz");
  await mkdir(source); await writeFile(join(source, "file with spaces.txt"), "verified bytes");
  const runner = new SetupProcessRunner();
  try {
    assert.equal((await runner.run(systemTar(), ["-czf", archive, "-C", source, "."], new AbortController().signal)).code, 0);
    const estimate = await inspectSetupArchive(runner, systemTar(), archive, new AbortController().signal);
    assert.equal(estimate, 2 * 8192 + Buffer.byteLength("verified bytes"));
  } finally { await runner.dispose(); }
});
