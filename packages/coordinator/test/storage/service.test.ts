import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import type { StorageHealthSnapshot } from "@arke-studio/contracts";
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
  return { service, roots: () => registered, stopped: () => stopped };
}

describe("application storage ownership", () => {
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
