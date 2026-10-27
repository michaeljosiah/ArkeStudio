import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync, renameSync } from "node:fs";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { executableContentMatches } from "../../src/harness/executable-content.js";
import { tempDir } from "../tmp.js";

const bytes = Buffer.alloc(256 * 1024, 65), pin = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
it("qualifies exact executable content through one bounded descriptor and refuses wrong bytes or size", async () => {
  const root = await tempDir("arke-executable-pin-"), path = join(root, "writer.exe"), signal = new AbortController().signal; await writeFile(path, bytes);
  assert(await executableContentMatches(path, pin, signal, () => true));
  assert(!await executableContentMatches(path, { ...pin, sha256: "0".repeat(64) }, signal, () => true));
  assert(!await executableContentMatches(path, { ...pin, bytes: pin.bytes - 1 }, signal, () => true));
  assert(!await executableContentMatches(path, { ...pin, bytes: 1024 ** 3 }, signal, () => true));
  assert(!await executableContentMatches(join(root, "missing.exe"), pin, signal, () => true));
  assert(!await executableContentMatches("relative.exe", pin, signal, () => true));
  await rename(path, path + ".closed"); assert.deepEqual(await readFile(path + ".closed"), bytes);
});
for (const change of ["bytes", "identity", "owner", "cancel"] as const) it(`refuses ${change} changes during verification and closes the original descriptor`, async () => {
  const root = await tempDir("arke-executable-changing-"), path = join(root, "writer.exe"), controller = new AbortController(); await writeFile(path, bytes);
  let calls = 0;
  const result = await executableContentMatches(path, pin, controller.signal, () => {
    if (++calls === 4) {
      if (change === "bytes") writeFileSync(path, Buffer.alloc(bytes.length, 66));
      if (change === "identity") { renameSync(path, path + ".original"); writeFileSync(path, bytes); }
      if (change === "cancel") controller.abort();
    }
    return change !== "owner" || calls < 4;
  });
  assert.equal(result, false); await rename(path, path + ".closed");
  assert.equal((await readFile(path + ".closed")).length, bytes.length);
});
it("refuses a parent directory alias instead of treating a redirected path as its captured executable", async () => {
  const root = await tempDir("arke-executable-alias-"), actual = join(root, "actual"), alias = join(root, "alias"); await mkdir(actual);
  await writeFile(join(actual, "writer.exe"), bytes); await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
  assert(!await executableContentMatches(join(alias, "writer.exe"), pin, new AbortController().signal, () => true));
});
it("later caller mutation cannot replace the captured expected digest", async () => {
  const root = await tempDir("arke-executable-expected-"), path = join(root, "writer.exe"), expected = { ...pin, sha256: "0".repeat(64) }; await writeFile(path, bytes);
  let calls = 0;
  assert(!await executableContentMatches(path, expected, new AbortController().signal, () => { if (++calls === 4) expected.sha256 = pin.sha256; return true; }));
});
