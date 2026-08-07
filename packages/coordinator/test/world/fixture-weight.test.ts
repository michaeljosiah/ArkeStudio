import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { decodePng } from "../../src/references/png.js";
import { FIXTURE_WORLD } from "./helpers.js";

/**
 * The fixture world is not only a fixture. Much of this suite copies it into a temp directory
 * per test, and it is what a user installs from Settings · Sample world — so its weight is paid
 * thousands of times in CI and once in every installer.
 *
 * It was 31 MB, almost all of it a dozen full-resolution PNGs of painterly art stored in a
 * format that suits it badly. These two tests hold the ground that recovered: one stops a
 * single untrimmed image walking back in, the other stops the same weight arriving as a
 * hundred smaller files.
 */

/** Comfortably above the largest legitimate image, far below an untrimmed export. */
const LARGEST_FILE_BYTES = 1.5 * 1024 * 1024;

/** Room for the world to keep growing in content without room for it to grow in megabytes. */
const TOTAL_BYTES = 16 * 1024 * 1024;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

describe("the fixture world's weight", () => {
  it("carries no single file heavy enough to be an untrimmed export", async () => {
    const heavy: string[] = [];
    for (const file of await walk(FIXTURE_WORLD)) {
      const { size } = await stat(file);
      if (size > LARGEST_FILE_BYTES) {
        heavy.push(`${relative(FIXTURE_WORLD, file)} (${(size / 1048576).toFixed(2)} MB)`);
      }
    }
    assert.deepEqual(heavy, [], "downscale before committing — see the trim note in this file");
  });

  it("stays inside its total budget", async () => {
    let total = 0;
    for (const file of await walk(FIXTURE_WORLD)) total += (await stat(file)).size;
    assert.ok(
      total <= TOTAL_BYTES,
      `the fixture world is ${(total / 1048576).toFixed(1)} MB, over its ${TOTAL_BYTES / 1048576} MB budget`,
    );
  });
});

describe("the fixture world's images", () => {
  /**
   * Reference tiles and take media are read back by the app's own pure-JS codec — the model-sheet
   * compositor (references/kit.ts) and the contact sheet (productions/ops.ts). It handles 8-bit
   * non-interlaced greyscale, RGB and RGBA only, so a palette PNG or a 16-bit one saves bytes by
   * breaking both. Re-encoding is only safe if this still passes.
   */
  it("keep every reference tile and take frame readable by the compositors", async () => {
    const decodable = (await walk(FIXTURE_WORLD)).filter((file) => {
      const rel = relative(FIXTURE_WORLD, file).replace(/\\/g, "/");
      return rel.endsWith(".png") && (rel.startsWith("references/") || /^productions\/[^/]+\/takes\//.test(rel));
    });
    assert.ok(decodable.length > 0, "the fixture should still hold reference and take images");
    for (const file of decodable) {
      const bytes = await readFile(file);
      assert.doesNotThrow(
        () => decodePng(Uint8Array.from(bytes)),
        `${relative(FIXTURE_WORLD, file)} is a PNG the compositors cannot read`,
      );
    }
  });
});
