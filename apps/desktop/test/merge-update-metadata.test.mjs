import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse, stringify } from "yaml";
import { mergeUpdateMetadata } from "../scripts/merge-update-metadata.mjs";

describe("Windows update metadata", () => {
  it("retains x64 and arm64 installers from sequential builder passes", async () => {
    const root = join(tmpdir(), `arke-update-${Date.now()}`);
    const x64 = `${root}-x64.yml`;
    const arm64 = `${root}-arm64.yml`;
    const output = `${root}-latest.yml`;
    await writeFile(x64, stringify({ version: "1.0.0", files: [{ url: "Arke-x64.exe", sha512: "x", size: 1 }] }));
    await writeFile(arm64, stringify({ version: "1.0.0", files: [{ url: "Arke-arm64.exe", sha512: "a", size: 1 }] }));
    try {
      mergeUpdateMetadata(x64, arm64, output);
      const merged = parse(await readFile(output, "utf8"));
      assert.deepEqual(merged.files.map((file) => file.url), ["Arke-x64.exe", "Arke-arm64.exe"]);
      assert.equal(merged.path, "Arke-x64.exe");
    } finally {
      await Promise.all([x64, arm64, output].map((path) => rm(path, { force: true })));
    }
  });
});
