import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { splitStoryArchive } from "../../../../scripts/story-release-parts.mjs";
import { tempDir } from "../tmp.js";

const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");

it("splits one immutable archive into ordered pinned parts without changing its bytes", async () => {
  const root = await tempDir("story-release-parts-"), file = join(root, "story.zip"), data = Buffer.from("a complete logical archive");
  await writeFile(file, data);
  const parts = await splitStoryArchive(file, { bytes: data.length, sha256: hash(data) }, 7);
  assert.deepEqual(parts.map(p => p.file), ["story.zip.part-001", "story.zip.part-002", "story.zip.part-003", "story.zip.part-004"]);
  const joined: Buffer[] = [];
  for (const part of parts) {
    const bytes = await readFile(join(root, part.file)); joined.push(bytes);
    assert.ok(part.bytes <= 7); assert.equal(part.bytes, bytes.length); assert.equal(part.sha256, hash(bytes));
  }
  assert.deepEqual(Buffer.concat(joined), data); assert.deepEqual(await readFile(file), data);
  await assert.rejects(splitStoryArchive(file, { bytes: data.length, sha256: hash(data) }, 7), /EEXIST/);
  assert.deepEqual(await readFile(join(root, parts[0]!.file)), joined[0]);
});

it("refuses unsafe part sizing and mismatched archive identity", async () => {
  const root = await tempDir("story-release-parts-invalid-"), file = join(root, "story.zip"), data = Buffer.from("archive");
  await writeFile(file, data);
  for (const size of [0, -1, 1.5, 1024 ** 3 + 1]) await assert.rejects(splitStoryArchive(file, { bytes: data.length, sha256: hash(data) }, size), /configuration/);
  await assert.rejects(splitStoryArchive(file, { bytes: 1001, sha256: hash(data) }, 1), /configuration/);
  await assert.rejects(splitStoryArchive(file, { bytes: data.length + 1, sha256: hash(data) }), /changed/);
  assert.deepEqual(await readdir(root), ["story.zip"]);
  await assert.rejects(splitStoryArchive(file, { bytes: data.length, sha256: "0".repeat(64) }), /changed/);
});
