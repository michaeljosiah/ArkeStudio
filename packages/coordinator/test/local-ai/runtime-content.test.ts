import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { RuntimeContentVerifier, type RuntimeContentPin } from "../../src/local-ai/runtime-content.js";
import pin from "../../src/local-ai/ollama-private-pin-x64.json" with { type: "json" };
import { OLLAMA_VERSION, SETUP_CATALOGUE } from "../../src/setup/catalogue.js";
import { tempDir } from "../tmp.js";

const signal = () => new AbortController().signal;
async function fixture() {
  const root = await realpath(await tempDir("arke-runtime-content-")), contents = { "ollama.exe": "PINNED_SYNTHETIC_EXECUTABLE", "lib/child.dll": "PINNED_SYNTHETIC_LIBRARY", "lib/libc++.dll": "PINNED_CPP_LIBRARY" };
  await mkdir(join(root, "lib"));
  for (const [path, value] of Object.entries(contents)) await writeFile(join(root, path), value);
  const expected: RuntimeContentPin = { version: "test", arch: "x64", archiveSha256: "a".repeat(64),
    files: Object.entries(contents).map(([path, value]) => ({ path, bytes: Buffer.byteLength(value), sha256: createHash("sha256").update(value).digest("hex") })) };
  return { root, contents, expected, verifier: new RuntimeContentVerifier(root, expected) };
}
it("binds the complete private runtime pin to the catalogue's verified x64 archive", () => {
  const spec = SETUP_CATALOGUE.find(row => row.id === "ollama-runtime")!.spec; assert.equal(spec.kind, "tree"); if (spec.kind !== "tree") return;
  assert.equal(pin.version, OLLAMA_VERSION); assert.equal(pin.archiveSha256, spec.file.sha256); assert.equal(pin.arch, "x64");
  assert(pin.files.some(file => file.path === "ollama.exe")); assert(pin.files.some(file => file.path.endsWith(".dll")));
  assert.equal(pin.files.length, 75); assert(pin.files.reduce((sum, file) => sum + file.bytes, 0) <= 4 * 1024 ** 3);
  assert.doesNotThrow(() => new RuntimeContentVerifier(join(import.meta.dirname, "pin-shape-check"), pin));
});
it("qualifies fixed executable and library bytes, permits only bounded app metadata and rechecks cached evidence", async () => {
  const h = await fixture(); assert(await h.verifier.verify(signal(), () => true)); assert(await h.verifier.verify(signal(), () => true));
  await writeFile(join(h.root, ".arke-runtime.json"), "{}"); assert(await h.verifier.verify(signal(), () => true));
  await writeFile(join(h.root, "lib/child.dll"), "OTHER_SYNTHETIC_LIBRARY"); assert(!await h.verifier.verify(signal(), () => true));
  assert.equal(await readFile(join(h.root, "lib/child.dll"), "utf8"), "OTHER_SYNTHETIC_LIBRARY");
  await writeFile(join(h.root, "lib/child.dll"), h.contents["lib/child.dll"]); assert(await h.verifier.verify(signal(), () => true));
});
it("refuses unexpected code or a missing fixed file even after a cache hit", async () => {
  const h = await fixture(); assert(await h.verifier.verify(signal(), () => true));
  await writeFile(join(h.root, "lib/unapproved.dll"), "KEEP_UNKNOWN_BYTES"); assert(!await h.verifier.verify(signal(), () => true));
  assert.equal(await readFile(join(h.root, "lib/unapproved.dll"), "utf8"), "KEEP_UNKNOWN_BYTES"); await unlink(join(h.root, "lib/unapproved.dll"));
  await rename(join(h.root, "ollama.exe"), join(h.root, "original.exe")); assert(!await h.verifier.verify(signal(), () => true));
});
it("refuses directory aliases and leaves their original library intact", async () => {
  const h = await fixture(); await rename(join(h.root, "lib"), join(h.root, "held"));
  await symlink(join(h.root, "held"), join(h.root, "lib"), process.platform === "win32" ? "junction" : "dir");
  assert(!await h.verifier.verify(signal(), () => true)); assert.equal(await readFile(join(h.root, "held/child.dll"), "utf8"), h.contents["lib/child.dll"]);
});
it("owner loss, cancellation and overlapping verification cannot grant runtime qualification", async () => {
  const h = await fixture(), abort = new AbortController(); abort.abort();
  assert(!await h.verifier.verify(abort.signal, () => true)); assert(!await h.verifier.verify(signal(), () => false));
  let nested: Promise<boolean> | undefined;
  assert(await h.verifier.verify(signal(), () => { nested ??= h.verifier.verify(signal(), () => true); return true; })); assert.equal(await nested, false);
  let calls = 0; assert(!await h.verifier.verify(signal(), () => ++calls < 3));
});
it("invalid or escaping runtime pins refuse before any file verification", async () => {
  const h = await fixture();
  for (const path of ["../outside.exe", "lib/../../outside.exe", "C:/outside.exe", "/outside.exe", "lib\\outside.exe"]) {
    assert.throws(() => new RuntimeContentVerifier(h.root, { ...h.expected, files: [{ ...h.expected.files[0]!, path }] }), /Invalid runtime/);
  }
});
