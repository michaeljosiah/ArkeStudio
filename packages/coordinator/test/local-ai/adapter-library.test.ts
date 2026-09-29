import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterReleaseSchema, type AdapterBundle, type AdapterDecision } from "@arke-studio/contracts";
import { AdapterLibrary, type AdapterComplianceClient } from "../../src/local-ai/adapter-library.js";

const bytes = Buffer.from("neutral adapter test fixture");
const sha = createHash("sha256").update(bytes).digest("hex");
const release = AdapterReleaseSchema.parse({ id: "test-release", adapterId: "test", publisher: "Test", displayName: "Test adapter",
  source: { repository: "test/fixture", revision: "a".repeat(40), file: "test.safetensors", bytes: bytes.length, sha256: sha },
  license: { name: "Test fixture", url: "https://example.com/license" }, classification: "adult", baseFamily: "minimax-h3", supersedes: [],
  assessedAt: "2026-09-24T00:00:00.000Z", compatibility: [{ recipeId: "test-recipe", state: "verified", reason: "Test", evidence: "Fixture only",
    minStrength: 0, maxStrength: 1, minEngineVersion: "0.37.0", exercisedThroughVersion: "0.37.0",
    hardware: { minVramMb: 1, minFreeVramMb: 1, minMemMb: 1, minFreeMemMb: 1 } }] });
const selection = [{ releaseId: release.id, sha256: sha, strength: 0.5 }];
const acknowledgement = { adultAge: true, explicitChoice: true, rightsAndConsent: true } as const;
const allowed = (): AdapterDecision => ({ sha256: sha, decision: "allowed", reason: "Fixture approval", policyRevision: "test-1", assessedAt: new Date().toISOString() });

test("bundle admission checks every member's bytes and policy and rejects altered or unknown combinations", async t => {
  const f = await fixture(t);
  const otherBytes = Buffer.from("a different neutral fixture");
  const otherSha = createHash("sha256").update(otherBytes).digest("hex");
  const other = { ...release, id: "second-release", source: { ...release.source, sha256: otherSha, bytes: otherBytes.length } };
  const members = [...selection, { releaseId: other.id, sha256: otherSha, strength: 0.5 }];
  const bundle: AdapterBundle = { id: "fixture-bundle", displayName: "Fixture bundle", recipeId: "test-recipe", status: "experimental", description: "Not tested", selections: members };
  const bundled = new AdapterLibrary({ ...f.options, releases: [release, other], bundles: [bundle], scanner: {
    assess: async () => [allowed(), { ...allowed(), sha256: otherSha }],
  } });
  t.after(() => bundled.dispose());
  assert.deepEqual((await bundled.snapshot()).bundles, []);
  await bundled.handle({ action: "enable", acknowledgement });
  await bundled.handle({ action: "scan" });
  assert.deepEqual((await bundled.snapshot()).bundles, [bundle]);
  await writeFile(f.file, bytes);
  const otherFile = join(f.root, "models", "loras", "arke", `${otherSha}.safetensors`);
  await assert.rejects(bundled.guard("test-recipe", members), /not installed/);
  await writeFile(otherFile, otherBytes);
  await bundled.guard("test-recipe", members, true);
  await assert.rejects(bundled.guard("test-recipe", [...members].reverse()), /bundle/);
  await assert.rejects(f.library.guard("test-recipe", members), /bundle/);
  await writeFile(otherFile, Buffer.alloc(otherBytes.length));
  await assert.rejects(bundled.guard("test-recipe", members, true), /checksum/);
  await writeFile(otherFile, otherBytes);
  await bundled.handle({ action: "disable", releaseId: other.id });
  await assert.rejects(bundled.guard("test-recipe", members, true), /Disabled/);
  assert.ok(f.revocations.includes(otherSha));
  await bundled.handle({ action: "disable-content" });
  assert.deepEqual((await bundled.snapshot()).bundles, []);
  await assert.rejects(bundled.guard("test-recipe", members), /off/);
});

async function fixture(t: { after(fn: () => Promise<void>): void }, scanner: AdapterComplianceClient = { assess: async () => [allowed()] }) {
  const root = await mkdtemp(join(tmpdir(), "arke-adapter-"));
  const models = join(root, "models"), file = join(models, "loras", "arke", `${sha}.safetensors`);
  await mkdir(join(models, "loras", "arke"), { recursive: true });
  let busy = false, downloads = 0;
  const revocations: Array<string | undefined> = [];
  const options = { appRoot: root, releases: [release], modelsDir: () => models, local: () => true, scanner,
    install: async () => { downloads++; await writeFile(file, bytes); await library.recordInstalled("adapter-test-release", file); },
    active: () => busy, revoke: async (hash?: string) => { revocations.push(hash); }, changed: () => {} };
  const library = new AdapterLibrary(options);
  t.after(async () => { await library.dispose(); await rm(root, { recursive: true, force: true }); });
  const enable = async () => { await library.handle({ action: "enable", acknowledgement }); await library.handle({ action: "scan" }); };
  return { root, file, options, library, enable, revocations, busy: (value: boolean) => { busy = value; }, downloads: () => downloads };
}

test("access starts off, explicit acknowledgement and assessment precede download, restart retains authority", async t => {
  const f = await fixture(t);
  assert.equal((await f.library.snapshot()).entries.length, 0);
  await assert.rejects(f.library.handle({ action: "install", releaseIds: [release.id] }), /off/);
  assert.equal(f.downloads(), 0);
  await f.enable();
  await f.library.handle({ action: "install", releaseIds: [release.id] });
  await f.library.guard("test-recipe", selection, true);
  const restarted = new AdapterLibrary(f.options);
  await restarted.guard("test-recipe", selection, true);
  await restarted.dispose();
  await f.library.handle({ action: "disable-content" });
  await assert.rejects(f.library.guard("test-recipe", selection, true), /off/);
  assert.deepEqual(await readFile(f.file), bytes);
});

test("removal keeps unowned and active files, persists across aliases and refresh", async t => {
  const f = await fixture(t);
  await f.enable(); await writeFile(f.file, bytes);
  await assert.rejects(f.library.handle({ action: "remove", releaseId: release.id, deleteOwnedFile: true }), /user-managed/);
  assert.deepEqual(await readFile(f.file), bytes);
  const alias = new AdapterLibrary({ ...f.options, releases: [{ ...release, id: "renamed-release" }] });
  assert.ok((await alias.snapshot()).entries[0]!.reason);
  await alias.handle({ action: "scan" });
  await assert.rejects(alias.handle({ action: "install", releaseIds: ["renamed-release"] }), /Disabled|Removed/);
  await alias.dispose();
});

test("only a proven owned, idle, unchanged file is deleted", async t => {
  const f = await fixture(t);
  await f.enable(); await f.library.handle({ action: "install", releaseIds: [release.id] });
  f.busy(true);
  await assert.rejects(f.library.handle({ action: "remove", releaseId: release.id, deleteOwnedFile: true }), /in use/);
  f.busy(false);
  await writeFile(f.file, Buffer.alloc(bytes.length));
  await assert.rejects(f.library.handle({ action: "remove", releaseId: release.id, deleteOwnedFile: true }), /checksum/);
  await writeFile(f.file, bytes);
  await f.library.handle({ action: "remove", releaseId: release.id, deleteOwnedFile: true });
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
});

test("scanner errors retire previous approvals and late scans cannot undo a user decision", async t => {
  let assess: AdapterComplianceClient["assess"] = async () => [allowed()];
  const f = await fixture(t, { assess: (...args) => assess(...args) });
  await f.enable(); await writeFile(f.file, bytes);
  assess = async () => { throw new Error("Offline"); };
  await assert.rejects(f.library.handle({ action: "scan" }), /Offline/);
  await assert.rejects(f.library.guard("test-recipe", selection), /Awaiting/);
  let finish!: (rows: AdapterDecision[]) => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  assess = () => new Promise(resolve => { finish = resolve; started(); });
  const scan = f.library.handle({ action: "scan" });
  await entered;
  await f.library.handle({ action: "disable", releaseId: release.id });
  finish([allowed()]);
  await assert.rejects(scan, /changed during/);
  await assert.rejects(f.library.guard("test-recipe", selection), /Disabled/);
});

test("a damaged decision journal fails closed without overwriting it", async t => {
  const f = await fixture(t);
  await f.enable();
  const journal = join(f.root, "adapters", "decisions.jsonl");
  await writeFile(journal, "{torn", { flag: "a" });
  const before = await readFile(journal);
  assert.equal((await f.library.snapshot()).adultContent.enabled, false);
  await assert.rejects(f.library.handle({ action: "enable", acknowledgement }));
  assert.deepEqual(await readFile(journal), before);
});

test("shutdown interrupts even an agent that ignores cancellation", async t => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(t, { assess: () => { entered(); return new Promise(() => {}); } });
  const scan = f.library.handle({ action: "scan" });
  const rejection = assert.rejects(scan, /interrupted/);
  await started;
  await f.library.dispose();
  await rejection;
});
