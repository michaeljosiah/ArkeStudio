import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { emptyRecoveryHistory, RecoveryHistorySchema, type RecoveryHistory, type RecoveryObservation, type RecoveryNotice, type DiagnosticsSnapshot } from "@arke-studio/contracts";
import { RecoveryHistoryService } from "../../src/recovery/history.js";
import { FileRecoveryHistoryStore } from "../../src/recovery/history-file.js";
import { FileRecoveryControlStore } from "../../src/recovery/control-file.js";
import { createHash } from "node:crypto";
import type { ClientState, StorageHealthSnapshot } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";

const key = "a".repeat(64), revision = "b".repeat(64), now = 2_000_000;
const observation = (patch: Partial<RecoveryObservation> = {}): RecoveryObservation => ({ key, kind: "storage-pressure", evidenceRevision: revision,
  observedAt: now, severity: "advisory", phase: "needs-user", evidence: "fresh", facts: [{ name: "available-bytes", value: 2 * 1024 ** 3, measuredAt: now }], ...patch });
function harness(options: { disk?: RecoveryHistory; save?: (value: RecoveryHistory) => Promise<void> } = {}) {
  let disk = structuredClone(options.disk ?? emptyRecoveryHistory()), at = now, ids = 0, writes = 0;
  const notices: RecoveryNotice[] = [];
  const store = { load: async () => structuredClone(disk), save: async (value: RecoveryHistory) => { writes++; await options.save?.(value); disk = structuredClone(value); } };
  const service = new RecoveryHistoryService({ store, now: () => at, id: () => (++ids).toString(16).padStart(64, "0"), saveDelayMs: 10000, onNotice: value => notices.push(value) });
  return { service, store, notices, disk: () => structuredClone(disk), writes: () => writes, advance: (ms: number) => { at += ms; } };
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

it("flushes the notice budget before delivery and deduplicates repeated probes across restart", async () => {
  const entered = deferred(), finish = deferred(), h = harness({ save: async () => { entered.resolve(); await finish.promise; } }); await h.service.open();
  try {
    h.service.observe([observation()]); const saving = h.service.flush(); await entered.promise; assert.equal(h.notices.length, 0);
    finish.resolve(); await saving; assert.equal(h.notices.length, 1); assert.equal(h.disk().incidents[0]!.delivery.lastAt, now);
    h.service.observe([observation()]); await h.service.flush(); assert.equal(h.notices.length, 1); assert.equal(h.writes(), 1);
    await h.service.stop(); const notices: RecoveryNotice[] = [];
    const restarted = new RecoveryHistoryService({ store: h.store, now: () => now + 1000, onNotice: value => notices.push(value) });
    await restarted.open(); assert.equal(restarted.snapshot().incidents[0]!.evidence, "unavailable");
    restarted.observe([observation({ observedAt: now + 1000 })]); await restarted.flush(); assert.equal(notices.length, 0); await restarted.stop();
  } finally { finish.resolve(); await h.service.stop(); }
});

it("coalesces a probe burst into one bounded save and retains a newer observation during a save", async () => {
  const entered = deferred(), finish = deferred(); let saves = 0;
  const h = harness({ save: async () => { if (++saves === 1) { entered.resolve(); await finish.promise; } } }); await h.service.open();
  try {
    for (let i = 0; i < 100; i++) h.service.observe([observation({ facts: [{ name: "available-bytes", value: 200 - i, measuredAt: now }] })]);
    const saving = h.service.flush(); await entered.promise;
    h.advance(1); h.service.observe([observation({ observedAt: now + 1, severity: "blocking", evidenceRevision: "c".repeat(64) })]);
    finish.resolve(); await saving;
    assert.equal(h.writes(), 2); assert.equal(h.disk().incidents.length, 1); assert.equal(h.disk().incidents[0]!.severity, "blocking");
    assert.equal(h.notices.length, 1); assert.equal(h.notices[0]!.reason, "severity-escalated", "a stale advisory was not delivered after escalation");
  } finally { finish.resolve(); await h.service.stop(); }
});

it("keeps bounded in-memory findings after ENOSPC and never retries a diagnostic write recursively", async () => {
  const h = harness({ save: async () => { throw Object.assign(new Error("private path and secret"), { code: "ENOSPC" }); } }); await h.service.open();
  h.service.observe([observation()]); await h.service.flush(); assert.equal(h.service.snapshot().audit, "unavailable"); assert.equal(h.service.snapshot().reason, "disk-full");
  for (let i = 0; i < 100; i++) h.service.observe([observation({ severity: "blocking" })]);
  await h.service.stop(); assert.equal(h.writes(), 1); assert.equal(h.notices.length, 0); assert.equal(h.service.snapshot().activeCount, 1);
  assert(!JSON.stringify(h.service.snapshot()).includes("secret"));
});

it("missing diagnostics cannot report recovery and free text never enters the saved summary", async () => {
  const h = harness(); await h.service.open();
  const snapshot: DiagnosticsSnapshot = { derivedAt: new Date(now).toISOString(), checked: ["storage"], sources: [{ name: "storage", state: "read" }], findings: [{
    kind: "storage-pressure", occurrence: "C:/private/world-name", severity: "advisory", title: "private title", cause: { statement: "raw prompt and logs" }, remedy: null,
    firstSeen: new Date(now).toISOString(), consequences: [], facts: [{ name: "available-bytes", value: 42, source: "private raw path", measuredAt: new Date(now).toISOString() }],
  }] };
  h.service.observeDiagnostics(snapshot); await h.service.flush();
  const body = JSON.stringify(h.disk()); assert(!body.includes("private")); assert(!body.includes("prompt")); assert.equal(h.notices.length, 1);
  h.advance(1000); h.service.observeDiagnostics({ ...snapshot, derivedAt: new Date(now + 1000).toISOString(), findings: [] }); await h.service.flush();
  assert.equal(h.service.snapshot().incidents[0]!.phase, "unresolved"); assert.equal(h.service.snapshot().incidents[0]!.evidence, "unavailable"); assert.equal(h.notices.length, 1);
  await h.service.stop();
});

it("mute, acknowledgement and advisory snooze preserve the fault and persist without a repair grant", async () => {
  const h = harness(); await h.service.open(); h.service.observe([observation()]); await h.service.flush(); const id = h.service.snapshot().incidents[0]!.id;
  assert(await h.service.acknowledge(id)); assert(await h.service.snooze(id, "one-hour")); assert(await h.service.setPreferences({ transientMuted: true }));
  h.advance(86400_000); h.service.observe([observation({ observedAt: now + 86400_000, severity: "blocking" })]); await h.service.flush();
  assert.equal(h.notices.length, 1); assert.equal(h.service.snapshot().incidents[0]!.phase, "needs-user"); assert.equal(h.service.snapshot().activeCount, 1);
  assert.equal(await h.service.snooze(id, "session"), false, "critical incidents cannot be newly snoozed"); await h.service.stop();
  assert(h.disk().preferences.transientMuted); assert.equal(h.disk().incidents[0]!.acknowledgedAt, now);
});

it("clears only resolved presentation history while the separate control file remains unchanged", async () => {
  const root = await tempDir("incident-clear-"), controlPath = join(root, "control.json"), historyPath = join(root, "history.json");
  const control = { version: 1, policyRevision: 1, mode: "suggest-only", targets: [] } as const; await new FileRecoveryControlStore(controlPath).save({ ...control, targets: [] });
  const before = await readFile(controlPath, "utf8"), service = new RecoveryHistoryService({ store: new FileRecoveryHistoryStore(historyPath), now: () => now });
  await service.open(); service.observe([observation(), observation({ key: "c".repeat(64) })]);
  service.observe([observation({ phase: "recovered", resolution: "verified-capacity" })]); assert(await service.clearResolved()); await service.stop();
  assert.equal((await new FileRecoveryHistoryStore(historyPath).load() as RecoveryHistory).incidents.length, 1); assert.equal(await readFile(controlPath, "utf8"), before);
});

it("shutdown drains saved state without late delivery, work, or publication", async () => {
  const entered = deferred(), finish = deferred(), h = harness({ save: async () => { entered.resolve(); await finish.promise; } }); await h.service.open();
  let published = 0; h.service.subscribe(() => { published++; }); h.service.observe([observation()]);
  const saving = h.service.flush(); await entered.promise; const stopping = h.service.stop(), before = published;
  h.service.observe([observation({ severity: "blocking" })]); finish.resolve(); await Promise.all([saving, stopping]);
  assert.equal(h.notices.length, 0); assert.equal(published, before); assert.equal(h.writes(), 1); assert.equal(await h.service.clearResolved(), false);
});

it("a corrupt or oversized history fails closed without overwriting the original file", async () => {
  const path = join(await tempDir("incident-invalid-"), "history.json");
  for (const body of ["{", " ".repeat(10 * 1024 ** 2 + 1)]) {
    await writeFile(path, body); const service = new RecoveryHistoryService({ store: new FileRecoveryHistoryStore(path) }); await service.open();
    assert.equal(service.snapshot().audit, "unavailable"); assert.equal(service.snapshot().reason, "invalid"); await service.stop(); assert.equal(await readFile(path, "utf8"), body);
  }
});

it("caps the snapshot independently of retained history, marks overflow, and rejects arbitrary facts", async () => {
  const h = harness(); await h.service.open();
  h.service.observe(Array.from({ length: 1001 }, (_, index) => observation({ key: (index + 1).toString(16).padStart(64, "0") })));
  assert.equal(h.service.snapshot().incidents.length, 100); assert.equal(h.service.snapshot().activeCount, 1000); assert(h.service.snapshot().limited); assert(h.service.snapshot().overflow.lostDetail);
  await h.service.flush(); assert.equal(RecoveryHistorySchema.parse(h.disk()).incidents.length, 1000); await h.service.stop();
});

it("requires separated fresh capacity readings, resets changed mappings, and never treats lost scope as recovery", async () => {
  const h = harness(), key = createHash("sha256").update("storage-pressure:volume-a").digest("hex"); await h.service.open();
  h.service.observe([observation({ key })]); await h.service.flush();
  const health = (at: number, mapping = "mount-a"): StorageHealthSnapshot => ({ at, writing: false, roots: [{ rootId: "media", role: "generated-media", state: "measured", source: "host-provided", limitations: [],
    capacity: { volumeId: "volume-a", mappingRevision: mapping, measuredAt: at, availableBytes: 20 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 }, pressure: null, forecast: null }] });
  h.service.observeAvailability({ storageHealth: health(now), comfyui: null });
  h.advance(30000); h.service.observeAvailability({ storageHealth: health(now + 30000, "mount-b"), comfyui: null });
  assert.equal(h.service.snapshot().resolvedCount, 0, "a remount restarts qualification");
  h.service.observeAvailability({ storageHealth: { at: now + 30000, writing: false, roots: [] }, comfyui: null });
  h.advance(30000); h.service.observeAvailability({ storageHealth: health(now + 60000, "mount-b"), comfyui: null });
  assert.equal(h.service.snapshot().resolvedCount, 0, "returning scope needs its first known high reading");
  h.service.observeAvailability({ storageHealth: health(now + 60000, "mount-b"), comfyui: null }); assert.equal(h.service.snapshot().resolvedCount, 0, "cached samples are not separated readings");
  h.advance(30000); h.service.observeAvailability({ storageHealth: health(now + 90000, "mount-b"), comfyui: null });
  assert.equal(h.service.snapshot().resolvedCount, 1); assert.equal(h.service.snapshot().incidents[0]!.resolution, "verified-capacity"); await h.service.stop();
});

it("a current ready engine resolves only its own incident with fresh readiness evidence", async () => {
  const h = harness(), key = createHash("sha256").update("comfyui-engine-unavailable:engine-a").digest("hex"); await h.service.open();
  h.service.observe([observation({ key, kind: "comfyui-engine-unavailable" })]);
  const comfy = (id: string, checkedAt: number): NonNullable<ClientState["app"]["comfyui"]> => ({ engine: { state: "ready", source: "managed", version: "0.37.0", locality: "local", location: "Arke-managed", instanceId: id, detail: null, detected: [] }, recipes: [], checkedAt: new Date(checkedAt).toISOString() });
  h.service.observeAvailability({ comfyui: comfy("engine-b", now), storageHealth: null }); assert.equal(h.service.snapshot().resolvedCount, 0);
  h.service.observeAvailability({ comfyui: comfy("engine-a", now - 60001), storageHealth: null }); assert.equal(h.service.snapshot().resolvedCount, 0);
  h.service.observeAvailability({ comfyui: comfy("engine-a", now), storageHealth: null }); assert.equal(h.service.snapshot().resolvedCount, 1);
  assert.equal(h.service.snapshot().incidents[0]!.resolution, "verified-readiness"); await h.service.stop();
});

it("ages resolved records out at startup even when the live diagnostics are quiet", async () => {
  const h = harness(); await h.service.open(); h.service.observe([observation()]); h.service.observe([observation({ phase: "recovered", resolution: "verified-capacity" })]);
  await h.service.stop();
  const service = new RecoveryHistoryService({ store: h.store, now: () => now + 31 * 86400_000 });
  await service.open(); assert.equal(service.snapshot().resolvedCount, 0); await service.stop(); assert.equal(h.disk().incidents.length, 0);
});

it("closing admission from a delivery callback suppresses the rest of the notice batch", async () => {
  let delivered = 0; const service = new RecoveryHistoryService({ now: () => now, store: { load: async () => emptyRecoveryHistory(), save: async () => {} },
    onNotice: () => { delivered++; service.closeAdmission(); } });
  await service.open(); service.observe([observation(), observation({ key: "c".repeat(64) })]); await service.flush();
  assert.equal(delivered, 1); await service.stop();
});

it("rechecks mute and snooze selected while a notice's budget is being flushed", async () => {
  for (const choice of ["mute", "snooze"] as const) {
    const entered = deferred(), finish = deferred(); let writes = 0;
    const h = harness({ save: async () => { if (++writes === 1) { entered.resolve(); await finish.promise; } } }); await h.service.open();
    try {
      h.service.observe([observation()]); const saving = h.service.flush(); await entered.promise;
      const changing = choice === "mute" ? h.service.setPreferences({ transientMuted: true }) : h.service.snooze(h.service.snapshot().incidents[0]!.id, "one-hour");
      await new Promise<void>(resolve => setImmediate(resolve));
      assert(choice === "mute" ? h.service.snapshot().preferences.transientMuted : h.service.snapshot().incidents[0]!.delivery.snoozedUntil !== null);
      finish.resolve(); await Promise.all([saving, changing]); assert.equal(h.notices.length, 0); assert.equal(h.service.snapshot().activeCount, 1);
    } finally { finish.resolve(); await h.service.stop(); }
  }
});

it("bounds shutdown waiting on nonessential history I/O and suppresses late continuations", async () => {
  for (const blocked of ["read", "write"] as const) {
    const entered = deferred(), finish = deferred(); let writes = 0, delivered = 0, published = 0;
    const service = new RecoveryHistoryService({ now: () => now, stopTimeoutMs: 5, store: {
      load: async () => { if (blocked === "read") { entered.resolve(); await finish.promise; } return emptyRecoveryHistory(); },
      save: async () => { writes++; if (blocked === "write") { entered.resolve(); await finish.promise; } },
    }, onNotice: () => { delivered++; } });
    service.subscribe(() => { published++; }); const opening = service.open();
    let saving: Promise<void> | undefined;
    if (blocked === "write") { await opening; service.observe([observation()]); saving = service.flush(); }
    await entered.promise; await service.stop(); const before = published;
    assert.equal(service.snapshot().audit, "unavailable"); assert.equal(service.snapshot().reason, blocked === "read" ? "read-failed" : "write-failed");
    finish.resolve(); await opening; await saving; service.observe([observation()]); await service.flush();
    assert.equal(writes, blocked === "write" ? 1 : 0); assert.equal(delivered, 0); assert.equal(published, before);
  }
});
