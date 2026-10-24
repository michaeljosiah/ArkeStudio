import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkWorldPackageZip, writeWorldPackageZip } from "../../src/productions/world-package.js";
import { tempDir } from "../tmp.js";

// SPEC-058 R-68 – R-70: a production package as Arke Player reads it back. Its world.json and music
// document are the shared fixtures arke_world reads too; the files here are a few bytes each, as the
// reader checks their lengths and digests, not their sound.
const fixtures = join(import.meta.dirname, "..", "..", "..", "contracts", "test", "fixtures", "world-package", "music");
const fixture = (name: string) => readFileSync(join(fixtures, name), "utf8");

async function pack(dir: string, musicText: string): Promise<string> {
  const world = JSON.parse(fixture("world-album.json")) as { assets: Record<string, { path: string; byteLength: number; sha256: string }> };
  const files = new Map<string, string>();
  const bytesOf = (path: string) => (path.endsWith("music.json") ? musicText : `bytes of ${path}`);
  for (const asset of Object.values(world.assets)) {
    const bytes = Buffer.from(bytesOf(asset.path), "utf8");
    const source = join(dir, asset.path.replaceAll("/", "_"));
    await writeFile(source, bytes);
    files.set(asset.path, source);
    asset.byteLength = bytes.length;
    asset.sha256 = createHash("sha256").update(bytes).digest("hex");
  }
  const zip = join(dir, "album.zip");
  await writeWorldPackageZip(JSON.stringify(world), files, zip);
  return zip;
}

describe("a production package read back (SPEC-058 R-68 – R-70)", () => {
  it("reads its music document, and every file it names is used", async () => {
    const checked = await checkWorldPackageZip(await pack(await tempDir("music-package-"), fixture("album.json")));
    if (!checked.ok) assert.fail(checked.problems.join("; "));
    assert.equal(checked.manifest.alone, true);
    assert.equal(checked.manifest.productions[0]!.music, "music");
  });

  it("a track nothing names is used by nothing", async () => {
    const checked = await checkWorldPackageZip(await pack(await tempDir("music-package-"), fixture("single.json")));
    assert.equal(checked.ok, false);
    if (!checked.ok) assert.ok(checked.problems.some((problem) => problem.endsWith("slack-water.m4a is used by nothing")), checked.problems.join("; "));
  });

  it("a music document that is not one is a problem", async () => {
    const checked = await checkWorldPackageZip(await pack(await tempDir("music-package-"), fixture("section-past-end.json")));
    assert.equal(checked.ok, false);
    if (!checked.ok) assert.ok(checked.problems.some((problem) => problem.startsWith("songs-of-the-drowned-quarter music:")), checked.problems.join("; "));
  });
});
