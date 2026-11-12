import assert from "node:assert/strict";
import { it } from "node:test";
import { basename, join } from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { ArtifactCheckpointInvalid, ArtifactResultFiles, artifactFileMatches, ARTIFACT_FILE_OVERHEAD } from "../../src/queue/artifact-files.js";
import { atomicWriteFile } from "../../src/world/atomic.js";
import type { ArtifactWriteSpace } from "../../src/storage/job-artifacts.js";
import { tempDir } from "../tmp.js";

const job = { id: "job_result", attempt: 1, provider: "synthetic", providerJobId: "accepted-1", resultReceiptId: "01J8F3K2QW9VZX4N7M0RTYB6HC" };
const artifacts = [1, 2].map(value => ({ name: `${value}.png`, contentType: "image/png", data: new Uint8Array([value, value + 2]) }));
const signal = () => new AbortController().signal;

it("treats ordinary different-sized landing files as misses without relaxing private receipt validation", async () => {
  const root = await tempDir('arke-artifact-size-'), path = join(root, 'existing.bin');
  await writeFile(path, new Uint8Array(1024 * 1024)); assert.equal(await artifactFileMatches(path, new Uint8Array([1]), signal()), false);
  await writeFile(path, new Uint8Array([1])); assert.equal(await artifactFileMatches(path, new Uint8Array([1, 2]), signal()), false);
  assert.equal(await artifactFileMatches(path, new Uint8Array([1]), signal()), true);
  await mkdir(join(root, 'directory')); await assert.rejects(artifactFileMatches(join(root, 'directory'), new Uint8Array(), signal()), ArtifactCheckpointInvalid);
});

it("retains complete blobs after ENOSPC and retries only missing bytes before publishing its receipt", async () => {
  const root = await tempDir("arke-result-prefix-"), plans: number[] = [], paths: string[] = []; let failed = false, settled = 0;
  const space: ArtifactWriteSpace = { async reserve(_id, demands) { plans.push(demands[0]!.remainingBytes); return { async consumed() {}, writeFailed() {}, async settle() { settled++; } }; } };
  const files = new ArtifactResultFiles(join(root, "jobs.jsonl"), space, async (path, bytes) => {
    paths.push(path); if (!failed && basename(path).startsWith('1-')) { failed = true; throw Object.assign(new Error("synthetic full disk"), { code: "ENOSPC" }); }
    await atomicWriteFile(path, bytes);
  });
  await assert.rejects(files.save(job, artifacts, signal()), { code: "ENOSPC" });
  const original = (await readdir(files.directory(job))).find(name => name.startsWith("0-"))!;
  assert.deepEqual([...await readFile(join(files.directory(job), original))], [1, 3]);
  assert.equal(await files.read(job), null, "Incomplete metadata is not a complete result, and does not delete its blobs");
  await files.save(job, artifacts, signal());
  assert.equal((await files.read({ ...job, attempt: job.attempt + 2 }))?.remoteId, job.providerJobId, 'Conservative history folding cannot change the flushed response nonce');
  assert.equal(paths.filter(path => path.endsWith(original)).length, 1, "Already verified bytes are not rewritten");
  assert.equal(plans[0]! - plans[1]!, artifacts[0]!.data.length + ARTIFACT_FILE_OVERHEAD);
  assert.equal(settled, 2); assert.deepEqual((await files.read(job))?.artifacts.map(value => [...value.data]), [[1, 3], [2, 4]]);
});

it("yields and cancels during large-buffer hashing before opening a file or acquiring disk space", async () => {
  const root = await tempDir('arke-result-hash-cancel-'), abort = new AbortController(); let admitted = 0;
  const files = new ArtifactResultFiles(join(root, 'jobs.jsonl'), { async reserve() { admitted++; throw new Error('Must not reach file admission'); } });
  const pending = files.save(job, [{ name: 'large.bin', contentType: 'application/octet-stream', data: new Uint8Array(16 * 1024 ** 2) }], abort.signal);
  queueMicrotask(() => abort.abort()); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(admitted, 0);
});

it("rejects tampering and changed accepted identity without deleting valid or invalid retained bytes", async () => {
  const root = await tempDir("arke-result-identity-"), files = new ArtifactResultFiles(join(root, "jobs.jsonl"));
  await files.save(job, artifacts, signal()); const directory = files.directory(job), names = await readdir(directory);
  const blob = names.find(name => name.startsWith('0-'))!; await writeFile(join(directory, blob), new Uint8Array([9, 9]));
  await assert.rejects(files.read(job), ArtifactCheckpointInvalid);
  await assert.rejects(files.save(job, artifacts, signal()), ArtifactCheckpointInvalid);
  await assert.rejects(files.read({ ...job, providerJobId: 'accepted-other' }), ArtifactCheckpointInvalid);
  assert.deepEqual(await readdir(directory), names); assert.deepEqual([...await readFile(join(directory, blob))], [9, 9]);
  await files.save({ ...job, attempt: 2, providerJobId: 'accepted-2', resultReceiptId: "01J8F3K2QW9VZX4N7M0RTYB6HD" }, artifacts, signal());
  assert.deepEqual(await readdir(directory), names, 'A newly authorized attempt does not replace its predecessor');
});

it("cancellation waits for the admitted file handle before settling, and keeps the completed prefix", async () => {
  const root = await tempDir("arke-result-cancel-"), abort = new AbortController(); let finish!: () => void, entered!: () => void, settled = false;
  const started = new Promise<void>(resolve => { entered = resolve; }), pending = new Promise<void>(resolve => { finish = resolve; });
  const files = new ArtifactResultFiles(join(root, 'jobs.jsonl'), { async reserve() { return { async consumed() {}, writeFailed() {}, async settle() { settled = true; } }; } },
    async (path, bytes) => { entered(); await pending; await atomicWriteFile(path, bytes); });
  const save = files.save(job, artifacts, abort.signal); await started; abort.abort(); await Promise.resolve(); assert.equal(settled, false);
  finish(); await assert.rejects(save, { name: 'AbortError' }); assert.equal(settled, true);
  assert.equal((await readdir(files.directory(job))).filter(name => name.endsWith('.bin')).length, 1);
  assert.equal(await files.read(job), null);
});

it("reads exact legacy accepted receipts conservatively and bounds malformed metadata", async () => {
  const root = await tempDir("arke-result-legacy-"), files = new ArtifactResultFiles(join(root, 'jobs.jsonl'));
  const directory = join(root, 'inline-artifacts', job.id); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ remoteId: job.providerJobId, artifacts: [{ name: 'old.png', contentType: 'image/png' }] }));
  await writeFile(join(directory, '0.bin'), new Uint8Array([7]));
  assert.deepEqual([...(await files.read({ ...job, resultReceiptId: undefined }))!.artifacts[0]!.data], [7]);
  await assert.rejects(files.read({ ...job, resultReceiptId: undefined, providerJobId: 'other' }), ArtifactCheckpointInvalid);
  await writeFile(join(directory, 'manifest.json'), ' '.repeat(128 * 1024 + 1));
  await assert.rejects(files.read({ ...job, resultReceiptId: undefined }), ArtifactCheckpointInvalid);
  assert.deepEqual([...await readFile(join(directory, '0.bin'))], [7]);
});
