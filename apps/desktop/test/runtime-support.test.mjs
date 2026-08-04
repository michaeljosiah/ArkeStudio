import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertPeArchitecture, manifestFor, peArchitecture, verifyManifest } from "../scripts/runtime-support.mjs";

async function pe(machine) {
  const path = join(tmpdir(), `arke-pe-${machine}-${Date.now()}.exe`);
  const bytes = Buffer.alloc(128);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write("PE\0\0", 64, "ascii");
  bytes.writeUInt16LE(machine, 68);
  await writeFile(path, bytes);
  return path;
}

describe("runtime preparation primitives", () => {
  it("recognises x64 and arm64 PE files and rejects mismatches", async () => {
    const x64 = await pe(0x8664);
    const arm64 = await pe(0xaa64);
    try {
      assert.equal(peArchitecture(x64), "x64");
      assert.equal(peArchitecture(arm64), "arm64");
      assert.throws(() => assertPeArchitecture(x64, "arm64"), /expected arm64/);
    } finally {
      await rm(x64, { force: true });
      await rm(arm64, { force: true });
    }
  });

  it("creates a stable target-only checksum manifest", async () => {
    const root = join(tmpdir(), `arke-runtime-${Date.now()}`);
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "voxa.exe"), "one");
    await writeFile(join(root, "nested", "runtime.dll"), "two");
    try {
      const manifest = manifestFor(root, { component: "voxa", arch: "x64" });
      await writeFile(join(root, "runtime-manifest.json"), JSON.stringify(manifest));
      assert.deepEqual(manifest.files.map((file) => file.path), ["nested/runtime.dll", "voxa.exe"]);
      assert.equal(manifest.files.every((file) => /^[A-F0-9]{64}$/.test(file.sha256)), true);
      assert.equal(verifyManifest(root).component, "voxa");
      await writeFile(join(root, "unlisted.dll"), "three");
      assert.throws(() => verifyManifest(root), /every staged file/);
      await rm(join(root, "unlisted.dll"));
      await writeFile(join(root, "voxa.exe"), "changed");
      assert.throws(() => verifyManifest(root), /manifest|checksum|size/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
