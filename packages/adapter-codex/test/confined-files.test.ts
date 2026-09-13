import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureRootIdentity, ConfinedFiles, fileConfinementUnavailable, resolveRoot, WindowsFiles } from "../src/confined-files.js";
import { mutateJunction } from "./fixtures/reparse-point.js";

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "arke-file-pins-"));
  const root = join(base, "proposal"); const outside = join(base, "outside");
  await mkdir(join(root, "nested"), { recursive: true }); await mkdir(outside);
  await writeFile(join(root, "nested", "draft.txt"), "inside");
  await writeFile(join(outside, "draft.txt"), "SECRET_MUST_NOT_LEAK");
  const canonical = await resolveRoot(root);
  return { base, root: canonical, outside, identity: await captureRootIdentity(canonical) };
}

test("a parent swapped after validation cannot redirect reads, search enumeration or writes", async t => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  const files = await ConfinedFiles.create(f.root, f.identity, new AbortController().signal);
  try {
    // This is the deterministic check/use boundary: the parent has been validated and
    // pinned, but no leaf has yet been opened, enumerated or replaced.
    await files.pinDirectory("nested");
    const nested = join(f.root, "nested"); const moved = join(f.root, "original");
    if (process.platform === "win32") {
      // Real Windows handles deny replacement of the parent AND every ancestor.
      await assert.rejects(rename(nested, moved), /EPERM|EACCES|EBUSY/);
      await assert.rejects(rename(f.root, join(f.base, "moved-root")), /EPERM|EACCES|EBUSY/);
      await assert.rejects(rename(f.base, f.base + "-moved"), /EPERM|EACCES|EBUSY/);
    } else {
      await rename(nested, moved); await symlink(f.outside, nested, "dir");
    }
    assert.equal((await files.read("nested/draft.txt")).toString(), "inside");
    assert.deepEqual(await files.list("nested"), [{ name: "draft.txt", directory: false }]);
    await files.write("nested/draft.txt", "updated inside");
    await files.write("nested/new/deeper.txt", "new inside");
    assert.equal(await readFile(join(f.outside, "draft.txt"), "utf8"), "SECRET_MUST_NOT_LEAK");
    assert.equal(await readFile(join(process.platform === "win32" ? nested : moved, "draft.txt"), "utf8"), "updated inside");
    await assert.rejects(readFile(join(f.outside, "new/deeper.txt")));
  } finally { await files.close(); }
  // Awaited disposal releases even ancestor handles; cleanup never races an orphan broker.
  await rename(f.root, join(f.base, "released"));
});

test("a root directory replaced after session creation is refused by captured identity", async t => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await rename(f.root, join(f.base, "old-root")); await rename(f.outside, f.root);
  await assert.rejects(ConfinedFiles.create(f.root, f.identity, new AbortController().signal), /confinement/);
  assert.equal(await readFile(join(f.root, "draft.txt"), "utf8"), "SECRET_MUST_NOT_LEAK");
});

test("linked parents are refused before the first pin and cancellation releases pinned ancestors", async t => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await symlink(f.outside, join(f.root, "linked"), process.platform === "win32" ? "junction" : "dir");
  const abort = new AbortController(); const files = await ConfinedFiles.create(f.root, f.identity, abort.signal);
  try {
    await assert.rejects(files.read("linked/draft.txt"), /confinement/);
    await assert.rejects(files.write("linked/draft.txt", "bad"), /confinement/);
    await files.pinDirectory("nested"); abort.abort();
    await assert.rejects(files.write("nested/draft.txt", "cancelled"));
  } finally { await files.close(); }
  assert.equal(await readFile(join(f.root, "nested/draft.txt"), "utf8"), "inside");
  await rename(f.root, join(f.base, "released"));
});

test("Unicode paths and large binary reads survive the private helper protocol", async t => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0x93); const name = "café-日本.png";
  await writeFile(join(f.root, name), bytes);
  const files = await ConfinedFiles.create(f.root, f.identity, new AbortController().signal);
  try {
    assert.deepEqual(await files.read(name), bytes);
    await files.write("nested/日本.txt", "héllo 日本");
    assert.equal((await files.read("nested/日本.txt")).toString(), "héllo 日本");
    await assert.rejects(files.read(name, 1024), /session read limit/);
  } finally { await files.close(); }
});

test("unsupported platforms fail closed with an availability reason", async () => {
  assert.match((await fileConfinementUnavailable("darwin"))!, /require Windows or Linux/);
});

test("directory pin limits bound a search's native resources and disposal releases them", async t => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await Promise.all(Array.from({ length: 256 }, (_, i) => mkdir(join(f.root, `d${i}`))));
  const files = await ConfinedFiles.create(f.root, f.identity, new AbortController().signal);
  try {
    await assert.rejects(async () => { for (let i = 0; i < 256; i++) await files.pinDirectory(`d${i}`); }, /directory handle limit/);
  } finally { await files.close(); }
  await rename(f.root, join(f.base, "released"));
});

test("helper spawn failure settles readiness even when no process exit event is emitted", { timeout: 5000 }, async () => {
  const helper = new WindowsFiles(new AbortController().signal, join(tmpdir(), "arke-missing-file-helper-executable"), []);
  try { await assert.rejects(helper.request("pin", "."), /unavailable|stopped/); }
  finally { await helper.close(); }
});

test("helper startup failures report only the fixed startup phase and release the process", { timeout: 5000 }, async () => {
  const source = 'process.stdin.resume(); process.stderr.write("SENSITIVE_NATIVE_EXCEPTION"); process.stdout.write(JSON.stringify({startup:"source"})+"\\n"+JSON.stringify({startupError:true,category:"encoding"})+"\\n"); setInterval(()=>{}, 30000);';
  const helper = new WindowsFiles(new AbortController().signal, process.execPath, ["-e", source]);
  try {
    await assert.rejects(helper.request("pin", "."), error => {
      assert.match(String(error), /failed during source startup/);
      assert.match(String(error), /encoding error/);
      assert.doesNotMatch(String(error), /SENSITIVE_NATIVE_EXCEPTION/);
      return true;
    });
  } finally { await helper.close(); }
});

test("unexpected startup output is identified without exposing its contents", { timeout: 5000 }, async () => {
  const source = 'process.stdin.resume(); process.stdout.write("SENSITIVE_INVALID_FRAME\\n"); setInterval(()=>{}, 30000);';
  const helper = new WindowsFiles(new AbortController().signal, process.execPath, ["-e", source]);
  try {
    await assert.rejects(helper.request("pin", "."), error => {
      assert.match(String(error), /launch startup \(invalid output\)/);
      assert.doesNotMatch(String(error), /SENSITIVE_INVALID_FRAME/);
      return true;
    });
  } finally { await helper.close(); }
});

test("in-place Windows reparse mutation cannot redirect a pinned directory capability", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  const empty = join(f.root, "empty"); await mkdir(empty);
  const files = await ConfinedFiles.create(f.root, f.identity, new AbortController().signal);
  let mutated = false;
  try {
    await files.pinDirectory("empty");
    await mutateJunction(empty, f.outside); mutated = true;
    // A normal pathname really does follow the new junction. The pinned native lookup
    // must still address the original empty directory, or refuse, before returning bytes.
    assert.equal(await readFile(join(empty, "draft.txt"), "utf8"), "SECRET_MUST_NOT_LEAK");
    await assert.rejects(files.read("empty/draft.txt"), /confinement/);
    assert.deepEqual(await files.list("empty"), []);
    let wrote = false;
    try { await files.write("empty/new.txt", "original directory"); wrote = true; }
    catch (error) { assert.match(String(error), /confinement/); }
    await assert.rejects(readFile(join(f.outside, "new.txt")));
    assert.equal(await readFile(join(f.outside, "draft.txt"), "utf8"), "SECRET_MUST_NOT_LEAK");
    await mutateJunction(empty, f.outside, true); mutated = false;
    if (wrote) assert.equal(await readFile(join(empty, "new.txt"), "utf8"), "original directory");
  } finally {
    try { if (mutated) await mutateJunction(empty, f.outside, true); }
    finally { await files.close(); }
  }
});

test("cancellation before helper readiness settles the caller and closes the child", { timeout: 5000 }, async () => {
  const abort = new AbortController();
  const helper = new WindowsFiles(abort.signal, process.execPath, ["-e", "process.stdin.resume(); setTimeout(() => {}, 30000)"]);
  const request = helper.request("pin", "."); abort.abort();
  try { await assert.rejects(request, /cancelled/); }
  finally { await helper.close(); }
});
