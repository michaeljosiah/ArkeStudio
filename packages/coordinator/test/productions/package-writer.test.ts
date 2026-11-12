import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { hashFile, PackageWriter } from "../../src/productions/package-writer.js";
import { tempDir } from "../tmp.js";

/**
 * The one way a package is staged (issue 2803): a copy is hashed while it streams, and the
 * read-back takes that hash only while the staged file is still the one written.
 */

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

it("copies a file in byte for byte, hashing what it wrote, and lists files as a manifest does", async () => {
  const root = await tempDir("package-writer-");
  const source = join(root, "take.wav"), big = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
  await writeFile(source, big);
  await writeFile(join(root, "cover.png"), "cover");
  const writer = await PackageWriter.stage(join(root, "staging"));
  const copied = await writer.copyIn(source, "media/chapter-01/0001.wav");
  await writer.copyIn(join(root, "cover.png"), "media/pictures/p001.png");
  assert.deepEqual(copied, { file: "media/chapter-01/0001.wav", sha256: sha256(big), bytes: big.length });
  assert.deepEqual(await readFile(join(writer.dir, "media/chapter-01/0001.wav")), big);
  assert.deepEqual(writer.files().map((entry) => entry.file), ["media/chapter-01/0001.wav", "media/pictures/p001.png"]);
  assert.deepEqual(await hashFile(source), { sha256: sha256(big), bytes: big.length });
});

it("adopts what an encoder wrote into staging, and keeps a page out of the file list", async () => {
  const root = await tempDir("package-writer-");
  const writer = await PackageWriter.stage(join(root, "staging"));
  await mkdir(join(writer.dir, "media"), { recursive: true });
  await writeFile(join(writer.dir, "media", "chapter-01.m4a"), "encoded");
  assert.deepEqual(await writer.adopt("media/chapter-01.m4a"), { file: "media/chapter-01.m4a", sha256: sha256(Buffer.from("encoded")), bytes: 7 });
  assert.equal(await writer.writeText("player.html", "<p>é</p>"), 9, "its size in bytes, not characters");
  assert.deepEqual(writer.files().map((entry) => entry.file), ["media/chapter-01.m4a"]);
});

it("takes the written hash while a file is unchanged, and reads it again once it is not", async () => {
  const root = await tempDir("package-writer-");
  await writeFile(join(root, "a.wav"), "first");
  const writer = await PackageWriter.stage(join(root, "staging"));
  const { sha256: written } = await writer.copyIn(join(root, "a.wav"), "media/a.wav");
  assert.equal(await writer.currentSha256("media/a.wav"), written);
  // Same length, so only the identity says it changed.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(join(writer.dir, "media/a.wav"), "FIRST");
  assert.equal(await writer.currentSha256("media/a.wav"), sha256(Buffer.from("FIRST")), "a changed file is read, not trusted");
  await assert.rejects(writer.currentSha256("media/missing.wav"));
});

it("stages into an empty folder and moves the package into place whole", async () => {
  const root = await tempDir("package-writer-");
  const staging = join(root, "staging");
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, "left-by-a-crash.wav"), "stale");
  await writeFile(join(root, "a.wav"), "audio");
  const writer = await PackageWriter.stage(staging);
  await writer.copyIn(join(root, "a.wav"), "media/a.wav");
  await writer.commit(join(root, "exports", "audiobook-x"));
  assert.equal(await readFile(join(root, "exports", "audiobook-x", "media", "a.wav"), "utf8"), "audio");
  await assert.rejects(readFile(join(root, "exports", "audiobook-x", "left-by-a-crash.wav")), "an earlier attempt's files are not this package's");
});
