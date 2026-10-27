import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { link, lstat, mkdir, open, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { windowsCacheFiles, type WindowsCacheProof } from "../../src/storage/windows-cache-file.js";
import { leashStorageReaderToParent } from "../../src/job-leash.js";
import { tempDir } from "../tmp.js";

const key = "a".repeat(64), hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const native = { skip: process.platform !== "win32", timeout: 30_000 };
const signal = () => new AbortController().signal;
async function metadataReader(path: string): Promise<() => Promise<void>> {
  const program = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
$asm=[AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName('CacheFixture')),[Reflection.Emit.AssemblyBuilderAccess]::Run)
$type=$asm.DefineDynamicModule('CacheFixtureModule',$false).DefineType('CacheFixture','Public, Class')
$ctor=[Runtime.InteropServices.DllImportAttribute].GetConstructor([string])
$fields=[Reflection.FieldInfo[]]@([Runtime.InteropServices.DllImportAttribute].GetField('SetLastError'),[Runtime.InteropServices.DllImportAttribute].GetField('CharSet'))
foreach($sig in @(@('CreateFileW',[IntPtr],@([string],[uint32],[uint32],[IntPtr],[uint32],[uint32],[IntPtr])),@('CloseHandle',[bool],@([IntPtr])))) {
 $m=$type.DefineMethod($sig[0],'Public, Static, PinvokeImpl',$sig[1],$sig[2])
 $m.SetCustomAttribute((New-Object Reflection.Emit.CustomAttributeBuilder($ctor,@('kernel32.dll'),$fields,@($true,[Runtime.InteropServices.CharSet]::Unicode))))
}
$k=$type.CreateType();$path=ConvertFrom-Json -InputObject ([Console]::In.ReadLine())
$handle=$k::CreateFileW($path,0,7,[IntPtr]::Zero,3,0,[IntPtr]::Zero)
if($handle -eq [IntPtr](-1)){throw 'fixture open'}
try {[Console]::Out.WriteLine('ready');[Console]::Out.Flush();$null=[Console]::In.ReadLine()}
finally {if(-not $k::CloseHandle($handle)){throw 'fixture close'}}
`;
  const ended = new AbortController(); let finish!: (code: number | null) => void;
  const done = new Promise<number | null>(resolve => { finish = resolve; });
  const child = execFile(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(program, "utf16le").toString("base64")],
    { windowsHide: true, timeout: 20_000, maxBuffer: 4096 }, () => {});
  child.stdin?.on("error", () => {});
  let ready!: () => void, fail!: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; }); void started.catch(() => {});
  child.stdout?.on("data", chunk => { if (String(chunk).includes("ready")) ready(); });
  child.once("error", () => fail(new Error("Metadata reader fixture unavailable.")));
  child.once("close", code => { ended.abort(); finish(code); fail(new Error("Metadata reader fixture closed.")); });
  try {
    const leash = child.pid ? await leashStorageReaderToParent(child.pid, process.pid, ended.signal) : { ok: false };
    if (!leash.ok) throw Error("Metadata reader fixture lacks parent ownership.");
    child.stdin?.write(JSON.stringify(path) + "\n"); await started;
    return async () => { child.stdin?.end("\n"); assert.equal(await done, 0); };
  } catch (error) { child.kill("SIGKILL"); await done; throw error; }
}
async function fixture() {
  const parent = await tempDir("arke-cache-removal-"); const root = join(parent, "cache"); await mkdir(root);
  const path = join(root, `${key}.wav`);
  const bytes = Buffer.from("generated exact-handle deletion fixture"); await writeFile(path, bytes);
  const row = (await windowsCacheFiles({ root, mode: "inspect", items: [{ key }] }, signal()))[0]!;
  assert.equal(row.state, "measured", JSON.stringify(row));
  if (row.state !== "measured") throw Error("Native proof unavailable");
  return { root, path, bytes, proof: row.proof };
}

it("qualifies the real Windows identity/hash/allocation observation and receipt binding", { skip: process.platform !== "win32", timeout: 30_000 }, async () => {
  const root = await tempDir("arke-cache-native-"); const bytes = Buffer.from("generated disposable native fixture");
  const path = join(root, `${key}.wav`); await writeFile(path, bytes);
  const rows = await windowsCacheFiles({ root, mode: "inspect", items: [{ key }] }, new AbortController().signal);
  assert.equal(rows.length, 1); const row = rows[0]!; assert.equal(row.state, "measured", JSON.stringify(row));
  if (row.state !== "measured") return;
  const file = await lstat(path, { bigint: true }), directory = await lstat(root, { bigint: true });
  assert.equal(row.proof.bytes, bytes.length); assert.equal(row.proof.contentHash, hash(bytes));
  assert(row.proof.allocatedBytes >= bytes.length); assert(Number.isSafeInteger(row.proof.observedAt));
  assert.equal(row.proof.nodeFileIdentity, hash(JSON.stringify([String(file.dev), String(file.ino), String(file.birthtimeNs)])));
  assert.equal(row.proof.nodeRootIdentity, hash(JSON.stringify([(await realpath(root)).toLowerCase(), String(directory.dev), String(directory.ino), String(directory.birthtimeNs)])));
  assert.equal(row.proof.modifiedNs, String(file.mtimeNs));
  assert.deepEqual(await readFile(path), bytes, "inspection preserves the generated fixture");
});

it("removes only the exact approved generated file and does not claim reclaimed capacity", native, async () => {
  const h = await fixture(); const protectedPath = join(h.root, "retained-creative-record.txt");
  await writeFile(protectedPath, "protected fixture");
  const row = (await windowsCacheFiles({ root: h.root, mode: "remove", items: [{ key, expected: h.proof }] }, signal()))[0]!;
  assert.equal(row.state, "removed", JSON.stringify(row));
  if (row.state !== "removed") return;
  assert.equal(row.proof.fileIdentity, h.proof.fileIdentity); assert.equal(row.proof.allocatedBytes, h.proof.allocatedBytes);
  assert.equal("reclaimedBytes" in row, false);
  await assert.rejects(readFile(h.path), { code: "ENOENT" });
  assert.equal(await readFile(protectedPath, "utf8"), "protected fixture");
});

it("refuses changed content, a replacement identity and changed approved allocation without deleting them", native, async () => {
  for (const change of ["bytes", "replacement", "approval"] as const) {
    const h = await fixture();
    if (change === "bytes") await writeFile(h.path, "different generated fixture bytes");
    if (change === "replacement") { await rename(h.path, join(h.root, "retained-original.wav")); await writeFile(h.path, h.bytes); }
    const before = await readFile(h.path);
    const expected = change === "approval" ? { ...h.proof, allocatedBytes: h.proof.allocatedBytes + 1 } : h.proof;
    const row = (await windowsCacheFiles({ root: h.root, mode: "remove", items: [{ key, expected }] }, signal()))[0]!;
    assert.equal(row.state, "refused", JSON.stringify(row)); assert.deepEqual(await readFile(h.path), before);
    if (change === "replacement") assert.deepEqual(await readFile(join(h.root, "retained-original.wav")), h.bytes);
  }
});

it("refuses open native readers and new hard links while keeping all entries intact", native, async () => {
  const h = await fixture(); const reader = await open(h.path, "r");
  try {
    for (const mode of ["inspect", "remove"] as const) {
      const row = (await windowsCacheFiles({ root: h.root, mode, items: [{ key, ...(mode === "remove" ? { expected: h.proof } : {}) }] }, signal()))[0]!;
      assert.equal(row.state, "refused", JSON.stringify(row));
      if (row.state === "refused") assert.equal(row.reason, "busy");
    }
  } finally { await reader.close(); }
  const alias = join(h.root, "protected-linked.wav"); await link(h.path, alias);
  const row = (await windowsCacheFiles({ root: h.root, mode: "remove", items: [{ key, expected: h.proof }] }, signal()))[0]!;
  assert.equal(row.state, "refused"); if (row.state === "refused") assert.equal(row.reason, "links");
  assert.deepEqual(await readFile(h.path), h.bytes); assert.deepEqual(await readFile(alias), h.bytes);
});

it("reports deletion as unknown while a metadata-only handle keeps it pending", native, async () => {
  const h = await fixture(); const close = await metadataReader(h.path);
  try {
    const row = (await windowsCacheFiles({ root: h.root, mode: "remove", items: [{ key, expected: h.proof }] }, signal()))[0]!;
    assert.equal(row.state, "unknown", JSON.stringify(row));
  } finally { await close(); }
  await assert.rejects(readFile(h.path), { code: "ENOENT" });
});

it("refuses a replaced root, root junction and leaf directory reparse point", native, async () => {
  const h = await fixture(); const retained = h.root + "-retained";
  // Both targets are disposable fixture directories under the known temporary parent.
  const parent = await realpath(join(h.root, ".."));
  assert.equal(join(retained, "..").toLowerCase(), parent.toLowerCase());
  await rename(h.root, retained); await mkdir(h.root); await writeFile(h.path, h.bytes);
  let row = (await windowsCacheFiles({ root: h.root, mode: "remove", items: [{ key, expected: h.proof }] }, signal()))[0]!;
  assert.equal(row.state, "refused"); assert.deepEqual(await readFile(h.path), h.bytes);
  assert.deepEqual(await readFile(join(retained, `${key}.wav`)), h.bytes);
  // Junction fixtures stay inside their own tracked temporary parents too.
  const outside = await tempDir("arke-cache-outside-");
  const root = await tempDir("arke-cache-reparse-");
  const junction = join(root, "root-junction"); await symlink(outside, junction, "junction");
  await writeFile(join(outside, `${key}.wav`), h.bytes);
  row = (await windowsCacheFiles({ root: junction, mode: "inspect", items: [{ key }] }, signal()))[0]!;
  assert.equal(row.state, "refused");
  await symlink(outside, join(root, `${key}.wav`), "junction");
  row = (await windowsCacheFiles({ root, mode: "inspect", items: [{ key }] }, signal()))[0]!;
  assert.equal(row.state, "refused"); assert.deepEqual(await readFile(join(outside, `${key}.wav`)), h.bytes);
});

it("keeps path punctuation as stdin data and returns no host path in its proof", native, async () => {
  const parent = await tempDir("arke-cache-stdin-"); const root = join(parent, "cache-é';&$value[]");
  await mkdir(root); await writeFile(join(root, `${key}.wav`), "generated punctuation fixture");
  const row = (await windowsCacheFiles({ root, mode: "inspect", items: [{ key }] }, signal()))[0]!;
  assert.equal(row.state, "measured", JSON.stringify(row));
  assert(!JSON.stringify(row).includes(parent)); assert(!JSON.stringify(row).includes("cache-é"));
});

it("bounds inspection batches and refuses oversized native files before hashing/removal", native, async () => {
  const h = await fixture(), absent = "b".repeat(64);
  const rows = await windowsCacheFiles({ root: h.root, mode: "inspect", items: [{ key }, { key: absent }] }, signal());
  assert.equal(rows[0]?.state, "measured");
  assert.deepEqual(rows[1], { key: absent, state: "refused", reason: "missing" });
  const file = await open(h.path, "r+");
  try { await file.truncate(12 * 1024 * 1024 + 1); } finally { await file.close(); }
  const row = (await windowsCacheFiles({ root: h.root, mode: "remove", items: [{ key, expected: h.proof }] }, signal()))[0]!;
  assert.equal(row.state, "refused"); assert.equal((await lstat(h.path)).size, 12 * 1024 * 1024 + 1);
});

it("refuses pre-cancelled removal and drains a cancelled inspection before another probe", native, async () => {
  const h = await fixture(), cancelled = new AbortController(); cancelled.abort();
  const row = (await windowsCacheFiles({ root: h.root, mode: "remove", items: [{ key, expected: h.proof }] }, cancelled.signal))[0]!;
  assert.deepEqual(row, { key, state: "refused", reason: "cancelled" }); assert.deepEqual(await readFile(h.path), h.bytes);
  const control = new AbortController(), timer = setTimeout(() => control.abort(), 20);
  try {
    const stopped = await windowsCacheFiles({ root: h.root, mode: "inspect", items: [{ key }] }, control.signal);
    assert.equal(stopped[0]?.state, "refused");
  } finally { clearTimeout(timer); }
  const next = await windowsCacheFiles({ root: h.root, mode: "inspect", items: [{ key }] }, signal());
  assert.equal(next[0]?.state, "measured");
});

it("rejects unbounded, duplicate, traversal and unapproved mutation input before native work", async () => {
  const expected = { rootIdentity: key, fileIdentity: key, contentHash: key, nodeRootIdentity: key, nodeFileIdentity: key,
    bytes: 1, allocatedBytes: 1, modifiedNs: "1", writeTicks: "1", observedAt: 1 } satisfies WindowsCacheProof;
  for (const input of [
    { root: "C:\\cache", mode: "remove", items: [{ key }] },
    { root: "C:\\cache", mode: "remove", items: [{ key, expected }, { key: "b".repeat(64), expected }] },
    { root: "C:\\cache", mode: "inspect", items: [{ key: "../world.json" }] },
    { root: "C:\\cache", mode: "inspect", items: [{ key }, { key }] },
    { root: "relative", mode: "inspect", items: [{ key }] },
    { root: "\\drive-relative", mode: "inspect", items: [{ key }] },
    { root: "C:\\cache", mode: "inspect", items: Array.from({ length: 9 }, (_, i) => ({ key: i.toString(16).repeat(64) })) },
  ]) await assert.rejects(windowsCacheFiles(input as Parameters<typeof windowsCacheFiles>[0], signal()));
  if (process.platform !== "win32") assert.deepEqual(await windowsCacheFiles({ root: "C:\\cache", mode: "inspect", items: [{ key }] }, signal()),
    [{ key, state: "refused", reason: "unsupported" }]);
});
