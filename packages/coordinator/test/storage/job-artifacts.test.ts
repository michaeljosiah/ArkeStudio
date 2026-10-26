import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { AppStorageService } from "../../src/storage/service.js";
import { ArtifactStorageHeld, JobArtifactStorage } from "../../src/storage/job-artifacts.js";
import { tempDir } from "../tmp.js";

const GiB = 1024 ** 3, MiB = 1024 ** 2;
function fixture(root: string, separate = false) {
  let clock = Date.now(), available = GiB + 3 * MiB, roots: readonly { rootId: string; path: string }[] = [];
  const storage = new AppStorageService({ appRoot: root, now: () => clock, native: {
    setRoots(value) { roots = value; }, async stop() {}, async probe(rootId) {
      const media = roots.find(value => value.rootId === rootId)!.path.endsWith('media');
      return { state: 'measured', source: 'host-provided', limitations: [], capacity: { volumeId: separate && media ? 'media-volume' : 'app-volume',
        mappingRevision: rootId, measuredAt: ++clock, availableBytes: media || !separate ? available : 100 * GiB, totalBytes: 200 * GiB } };
    },
  } });
  return { storage, space: new JobArtifactStorage(storage), advance: () => { clock += 5001; }, full: () => { available = 0; clock += 5001; }, roomy: () => { available = 100 * GiB; clock += 5001; } };
}
it("shares finite artifact admission with competing owners and charges consumed bytes against cached capacity", async () => {
  const root = await tempDir('arke-result-space-'), h = fixture(root), directory = join(root, 'media');
  let lease: Awaited<ReturnType<JobArtifactStorage['reserve']>> | undefined;
  try {
    lease = await h.space.reserve('job_one', [{ directory, role: 'generated-media', remainingBytes: 2 * MiB }], new AbortController().signal);
    await assert.rejects(h.space.reserve('job_two', [{ directory, role: 'generated-media', remainingBytes: 2 * MiB }], new AbortController().signal), ArtifactStorageHeld);
    await lease.consumed(directory, 2 * MiB);
    await assert.rejects(h.space.reserve('job_two', [{ directory, role: 'generated-media', remainingBytes: 2 * MiB }], new AbortController().signal), ArtifactStorageHeld);
    await lease.settle(); h.advance();
    const next = await h.space.reserve('job_two', [{ directory, role: 'generated-media', remainingBytes: 2 * MiB }], new AbortController().signal); await next.settle();
    assert.equal(h.storage.reservations.snapshot().records.length, 0);
    assert(!JSON.stringify(h.storage.snapshot()).includes(root));
  } finally { await lease?.settle(); await h.storage.stop(); }
});

it("reconciles only known idle host-file leases after restart, never a live lease or an unknown job", async () => {
  const root = await tempDir('arke-result-reconcile-'), old = fixture(root), directory = join(root, 'media'), signal = new AbortController().signal;
  let fresh: ReturnType<typeof fixture> | undefined;
  try {
    await old.space.reserve('job_known', [{ directory, role: 'generated-media', remainingBytes: MiB }], signal);
    await old.space.reserve('job_unknown', [{ directory, role: 'generated-media', remainingBytes: MiB }], signal);
    await new JobArtifactStorage(old.storage).reconcileIdleJobs(new Set(['job_known']));
    assert.equal(old.storage.reservations.snapshot().records.length, 2, 'The same host still owns both admitted file handles');
    await writeFile(join(directory, 'retained.bin'), new Uint8Array([4, 2]));
    await old.storage.stop(); fresh = fixture(root);
    await fresh.space.reconcileIdleJobs(new Set(['job_known']));
    assert.deepEqual(fresh.storage.reservations.snapshot().records.map(value => value.owner.id), ['artifact_job_unknown']);
    assert.deepEqual([...await readFile(join(directory, 'retained.bin'))], [4, 2], 'Accounting reconciliation never deletes result bytes');
  } finally { await old.storage.stop(); await fresh?.storage.stop(); }
});
it("a roomy app volume cannot mask a full result destination and rename admission rejects different proven volumes", async () => {
  const root = await tempDir('arke-result-volumes-'), h = fixture(root, true), signal = new AbortController().signal;
  try {
    h.full();
    await assert.rejects(h.space.reserve('job_full', [{ directory: join(root, 'media'), role: 'generated-media', remainingBytes: 1 }], signal), ArtifactStorageHeld);
    h.roomy();
    await assert.rejects(h.space.reserve('job_rename', [
      { directory: join(root, 'app-stage'), role: 'working-files', remainingBytes: 1 },
      { directory: join(root, 'media'), role: 'generated-media', remainingBytes: 0 },
    ], signal, true), error => error instanceof ArtifactStorageHeld && error.differentVolumes);
    assert.equal(h.storage.reservations.snapshot().records.length, 0);
  } finally { await h.storage.stop(); }
});
