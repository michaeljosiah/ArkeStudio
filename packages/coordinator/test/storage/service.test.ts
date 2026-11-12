import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { StorageHealthSnapshotSchema, type StorageHealthSnapshot } from "@arke-studio/contracts";
import { AppStorageService, type StorageNativePort } from "../../src/storage/service.js";
import { tempDir } from "../tmp.js";

function fixture(root: string) {
  let now = 600_000, registered: readonly { rootId: string; path: string }[] = [], stopped = false;
  const native: StorageNativePort = {
    setRoots: roots => { registered = roots; },
    probe: async (rootId, _signal, after) => {
      if (after !== undefined) now = Math.max(now, after + 1);
      return { state: "measured", source: "host-provided", limitations: [], capacity: {
        volumeId: "volume-a", mappingRevision: rootId, measuredAt: now, availableBytes: 20 * 1024 ** 3, totalBytes: 500 * 1024 ** 3,
      } };
    },
    stop: async () => { stopped = true; },
  };
  const service = new AppStorageService({ appRoot: root, native, now: () => now, store: { load: async () => ({ version: 2, records: [], consumed: [] }), save: async () => {} } });
  return { service, roots: () => registered, stopped: () => stopped, advance: (ms: number) => { now += ms; } };
}

describe("application storage ownership", () => {
  it("counts relocated managed model subfolders once and releases their observations when deselected", async () => {
    const base = await tempDir("arke-storage-models-"), app = join(base, "app"), selected = join(base, "selected"), { service, roots } = fixture(app);
    const blobs = join(selected, "blobs"), manifests = join(selected, "manifests");
    await mkdir(blobs, { recursive: true }); await mkdir(manifests, { recursive: true });
    await writeFile(join(blobs, "model"), Buffer.alloc(17)); await writeFile(join(manifests, "model"), Buffer.alloc(3));
    await writeFile(join(selected, "personal-file"), Buffer.alloc(91));
    service.setManagedModelRoots([blobs, manifests]);
    const measured = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error("Managed inventory did not finish.")); }, 5_000);
      const off = service.subscribe(state => {
        if (state.inventory?.categories.find(row => row.category === "models")?.logicalBytes === 20) { clearTimeout(timer); off(); resolve(); }
      });
    });
    try {
      await service.start(); await measured;
      assert(roots().some(root => root.path === blobs));
      assert(!roots().some(root => root.path === selected));
      assert.doesNotMatch(JSON.stringify(service.snapshot()), /personal-file|selected|arke-storage-models-/);
      service.setManagedModelRoots([]);
      assert(!roots().some(root => root.path === blobs || root.path === manifests));
      assert.equal(service.snapshot().inventory!.categories.find(row => row.category === "models")!.logicalBytes, null);
      service.closeAdmission(); service.setManagedModelRoots([blobs]);
      assert(!roots().some(root => root.path === blobs));
    } finally { await service.stop(); }
  });

  it("does not double-count the default model store when its nested destinations are registered", async () => {
    const app = await tempDir("arke-storage-default-models-"), blobs = join(app, "models", "ollama", "blobs"), { service } = fixture(app);
    await mkdir(blobs, { recursive: true }); await writeFile(join(blobs, "model"), Buffer.alloc(23));
    service.setManagedModelRoots([blobs]);
    const measured = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error("Nested inventory did not finish.")); }, 5_000);
      const off = service.subscribe(state => {
        const models = state.inventory?.categories.find(row => row.category === "models");
        if (models?.state === "measured") { clearTimeout(timer); off(); assert.equal(models.logicalBytes, 23); resolve(); }
      });
    });
    try { await service.start(); await measured; } finally { await service.stop(); }
  });

  it("publishes bounded anonymous shortfall checks without retaining paths, inventing work status or reserving failed attempts", async () => {
    const root = await tempDir("arke-storage-checks-"), { service, roots, advance } = fixture(root), gib = 1024 ** 3;
    await service.start();
    const media = service.acquireRoot(join(root, "private-world"), "generated-media"), scratch = service.acquireRoot(join(root, "private-scratch"), "working-files");
    advance(1001); await service.refresh();
    try {
      const owner = { kind: "export" as const, id: "private-export-name" };
      assert.equal((await service.reservations.reserve({ id: "other", owner: { kind: "job", id: "private-job" }, demands: [{ rootId: service.snapshot().roots[0]!.rootId, remainingBytes: 8 * gib }] })).status, "reserved");
      const request = { id: "refused", owner, demands: [{ rootId: media.rootId, remainingBytes: 16 * gib }, { rootId: scratch.rootId, remainingBytes: 4 * gib }] };
      assert.equal((await service.reservations.reserve(request)).status, "held");
      const snapshot = StorageHealthSnapshotSchema.parse(service.snapshot()), check = snapshot.spaceChecks![0]!;
      assert.equal(snapshot.admission!.reservations, 1); assert.equal(check.purpose, "export");
      // An unchanged destination can retain its earlier, still-fresh sample across root churn.
      const measuredAt = check.volumes[0]!.measuredAt;
      assert.ok(measuredAt === 600_000 || measuredAt === 601_001, "the check retains the sample used for admission, even if collection advances afterward");
      assert.deepEqual(check.volumes, [{ volumeId: "volume-a", measuredAt, roles: ["generated-media", "working-files"], status: "held",
        availableBytes: 20 * gib, reservedBytes: 8 * gib, peakBytes: 20 * gib, reserveBytes: gib, deficitBytes: 9 * gib }]);
      assert.doesNotMatch(JSON.stringify(snapshot), /private-|arke-storage-checks-|waiting|owner/);
      assert.equal((await service.reservations.reserve({ ...request, demands: [{ rootId: media.rootId, remainingBytes: gib }] })).status, "reserved");
      assert.equal(service.snapshot().spaceChecks!.length, 0, "a later fitting check from this owner replaces its failed check without claiming operation completion");
      await service.reservations.settle("refused", owner);
      for (let index = 0; index < 18; index++) await service.reservations.reserve({ ...request, owner: { ...owner, id: `private-${index}` } });
      assert.equal(service.snapshot().spaceChecks!.length, 16);
      media.release(); scratch.release(); assert(!roots().some(value => value.path.endsWith("private-world")));
      assert.equal(service.snapshot().spaceChecks!.length, 16, "historical checks do not retain destination roots");
      advance(15 * 60_000 + 1); assert.equal(service.snapshot().spaceChecks!.length, 0);
    } finally { media.release(); scratch.release(); await service.stop(); }
  });

  it("starts without a model and publishes opaque facts for the app and active world", async () => {
    const root = await tempDir("arke-storage-service-"), { service, roots, stopped } = fixture(root);
    const received: StorageHealthSnapshot[] = []; const off = service.subscribe(snapshot => received.push(snapshot));
    assert.equal(received[0]!.admission!.state, "starting");
    service.setWorld(join(root, "worlds", "private-world")); await service.start();
    const state = service.snapshot(); assert.equal(state.roots.length, 2); assert.equal(state.admission!.state, "available");
    assert(state.roots.every(value => value.state === "measured"));
    assert.equal(roots().length, 2); assert(!JSON.stringify(state).includes(root)); assert(!JSON.stringify(state).includes("private-world"));
    off(); await service.stop(); assert(stopped());
  });

  it("retains only leased background destinations when the active world changes", async () => {
    const root = await tempDir("arke-storage-roots-"), { service, roots } = fixture(root);
    const first = join(root, "first"), second = join(root, "second");
    service.setWorld(first); const work = service.acquireRoot(first, "generated-media");
    service.setWorld(second); assert.equal(roots().length, 3);
    work.release(); work.release(); assert.deepEqual(roots().map(value => value.path).sort(), [root, second].sort());
    service.setWorld(null); assert.equal(roots().length, 1); await service.stop();
  });

  it("shares write activity without one writer stopping another's sampling", async () => {
    const root = await tempDir("arke-storage-writers-"), { service } = fixture(root);
    const one = service.beginWrite(), two = service.beginWrite(); assert(service.snapshot().writing);
    one(); one(); assert(service.snapshot().writing);
    service.setWriting(true); two(); assert(service.snapshot().writing);
    service.setWriting(false); assert.equal(service.snapshot().writing, false); await service.stop();
  });

  it("keeps an operation's root registered until its reservation actually settles", async () => {
    const root = await tempDir("arke-storage-root-reservation-"), { service, roots } = fixture(root);
    await service.start(); const destination = join(root, "background-export"), hold = service.acquireRoot(destination, "exports");
    await service.refresh();
    const owner = { kind: "export" as const, id: "export-a" };
    assert.equal((await service.reservations.reserve({ id: "reserve-a", owner, demands: [{ rootId: hold.rootId, remainingBytes: 1024 }] })).status, "reserved");
    hold.release(); assert(roots().some(value => value.path === destination));
    assert.equal(await service.reservations.settle("reserve-a", owner), true);
    assert(!roots().some(value => value.path === destination)); await service.stop();
  });

  it("keeps collection available when admission control cannot be read", async () => {
    const root = await tempDir("arke-storage-audit-"), base = fixture(root);
    await base.service.stop();
    const service = new AppStorageService({ appRoot: root, platform: "unsupported-test", store: { load: async () => { throw new Error("unreadable"); }, save: async () => {} } });
    await service.start();
    assert.equal(service.snapshot().admission!.state, "unavailable");
    assert.equal(service.snapshot().roots[0]!.state, "unsupported");
    assert.equal((await service.reservations.reserve({ id: "new", owner: { kind: "job", id: "job-a" }, demands: [{ rootId: service.snapshot().roots[0]!.rootId, remainingBytes: 1 }] })).status, "held");
    await service.stop();
  });

  it("reports a limited scope instead of failing a world open at the root bound", async () => {
    const root = await tempDir("arke-storage-bound-"), { service } = fixture(root);
    const holds = Array.from({ length: 127 }, (_, i) => service.acquireRoot(join(root, `job-${i}`), "exports"));
    service.setWorld(join(root, "current-world"));
    assert.equal(service.snapshot().roots.length, 128); assert.equal(service.snapshot().limited, true);
    holds[0]!.release(); assert.equal(service.snapshot().limited, false);
    assert(service.snapshot().roots.some(value => value.role === "generated-media"));
    for (const hold of holds) hold.release(); await service.stop();
  });

  it("closes admission and suppresses late observer publication during shutdown", async () => {
    const root = await tempDir("arke-storage-stop-"), { service } = fixture(root);
    let notifications = 0; service.subscribe(() => { notifications++; });
    await service.start(); service.closeAdmission(); const count = notifications;
    service.setWorld(join(root, "late-world")); await service.wake(); await service.refresh(); await service.stop();
    assert.equal(notifications, count); assert.throws(() => service.beginWrite(), /stopping/);
    assert.throws(() => service.acquireRoot(root, "exports"), /stopping/);
  });
});
