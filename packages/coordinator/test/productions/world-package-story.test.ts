import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkWorldPackageZip, writeWorldPackageZip } from "../../src/productions/world-package.js";
import { tempDir } from "../tmp.js";

// SPEC-058 R-79, R-80: a story package as Arke Player reads it back. Its world.json and story
// document are the shared fixtures arke_world reads too; the clips here are a few bytes each, as the
// reader checks their lengths and digests, not their pictures.
const fixtures = join(import.meta.dirname, "..", "..", "..", "contracts", "test", "fixtures", "world-package", "story");
const fixture = (name: string) => readFileSync(join(fixtures, name), "utf8");

async function pack(dir: string, storyText: string): Promise<string> {
  const world = JSON.parse(fixture("world-story.json")) as { assets: Record<string, { path: string; byteLength: number; sha256: string }> };
  const files = new Map<string, string>();
  for (const asset of Object.values(world.assets)) {
    const bytes = Buffer.from(asset.path.endsWith("story.json") ? storyText : `bytes of ${asset.path}`, "utf8");
    const source = join(dir, asset.path.replaceAll("/", "_"));
    await writeFile(source, bytes);
    files.set(asset.path, source);
    asset.byteLength = bytes.length;
    asset.sha256 = createHash("sha256").update(bytes).digest("hex");
  }
  const zip = join(dir, "ring-once.zip");
  await writeWorldPackageZip(JSON.stringify(world), files, zip);
  return zip;
}

describe("a story package read back (SPEC-058 R-79, R-80)", () => {
  it("reads its story document, and every clip it names is used", async () => {
    const checked = await checkWorldPackageZip(await pack(await tempDir("story-package-"), fixture("synthetic.json")));
    if (!checked.ok) assert.fail(checked.problems.join("; "));
    assert.equal(checked.manifest.alone, true);
    assert.equal(checked.manifest.productions[0]!.story, "story");
    assert.equal(checked.manifest.productions[0]!.tall, "cover-tall");
  });

  it("a clip nothing names is used by nothing", async () => {
    const story = JSON.parse(fixture("synthetic.json")) as { scenes: Array<{ id: string; clips: Array<{ asset: string }> }> };
    story.scenes.find((scene) => scene.id === "sc_vault")!.clips[0]!.asset = "ro-bell";
    const checked = await checkWorldPackageZip(await pack(await tempDir("story-package-"), JSON.stringify(story)));
    assert.equal(checked.ok, false);
    if (!checked.ok) assert.ok(checked.problems.some((problem) => problem.endsWith("sc_vault.mp4 is used by nothing")), checked.problems.join("; "));
  });

  it("a story document that is not one is a problem", async () => {
    const checked = await checkWorldPackageZip(await pack(await tempDir("story-package-"), fixture("ending-with-choice.json")));
    assert.equal(checked.ok, false);
    if (!checked.ok) assert.ok(checked.problems.some((problem) => problem.startsWith("ring-once story:")), checked.problems.join("; "));
  });
});
