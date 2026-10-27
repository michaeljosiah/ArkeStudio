import assert from "node:assert/strict";
import { it } from "node:test";
import { FindingSchema } from "../src/diagnostics.js";
import { deriveStorageFindings } from "../src/storage-diagnostics.js";
import type { StorageHealthSnapshot, StorageRootHealth } from "../src/storage-health.js";
import type { RecoveryCacheScope } from "../src/recovery-actions.js";

const now = "2026-10-26T14:00:00.000Z", epoch = Date.parse(now), GiB = 1024 ** 3;
const root = (rootId = "media", availableBytes = 20 * GiB): StorageRootHealth => ({ rootId, role: "generated-media", state: "measured", source: "host-provided", limitations: [], pressure: null, forecast: null,
  capacity: { volumeId: "volume-a", mappingRevision: "mount-a", measuredAt: epoch, availableBytes, totalBytes: 500 * GiB } });
const health = (...roots: StorageRootHealth[]): StorageHealthSnapshot => ({ at: epoch, writing: false, roots });
const scope: RecoveryCacheScope = { revision: "a".repeat(64), volumeId: "volume-a", mappingRevision: "mount-a", measuredAt: epoch,
  inventoryAt: epoch, candidateFiles: 1, recordedBytes: 60 };

it("states no storage fault for absent hosts or fresh sufficient capacity", () => {
  assert.deepEqual(deriveStorageFindings(undefined, now), []);
  assert.deepEqual(deriveStorageFindings(health(root()), now), []);
});

it("groups measured aliases under one volume without inventing affected jobs or deletion", () => {
  const findings = deriveStorageFindings(health(root("media", 6 * GiB), root("exports", 8 * GiB)), now);
  assert.equal(findings.length, 1); const finding = findings[0]!;
  assert.equal(finding.kind, "storage-pressure"); assert.equal(finding.occurrence, "volume-a"); assert.equal(finding.remedy, null);
  assert.equal(finding.facts.find(f => f.name === "available-bytes")!.value, 6 * GiB);
  assert.equal(finding.facts.find(f => f.name === "destinations")!.value, 2);
  assert(!finding.facts.some(f => f.name.includes("job")));
  FindingSchema.parse({ ...finding, firstSeen: now });
});

it("keeps predictive warnings explicit estimates above the static warning floor", () => {
  const value = root(); value.forecast = { method: "median-positive-consumption", from: epoch - 360_000, to: epoch, netLossBytes: 6 * GiB,
    bytesPerMs: GiB / 60_000, timeToReserveMs: 19 * 60_000, warning: true };
  const finding = deriveStorageFindings(health(value), now)[0]!;
  assert.equal(finding.kind, "storage-pressure"); assert.match(finding.cause.statement, /estimates/);
  assert.equal(finding.facts.find(f => f.name === "estimated-time-to-reserve-ms")!.value, 19 * 60_000);
});

it("cannot report fresh risk or recovery from stale, future or unavailable measurements", () => {
  for (const patch of [{ measuredAt: epoch - 60_001 }, { measuredAt: epoch + 1 }, { availableBytes: null }]) {
    const value = root("media", GiB); value.capacity = { ...value.capacity!, ...patch };
    const findings = deriveStorageFindings(health(value), now);
    assert.equal(findings.length, 1); assert.equal(findings[0]!.kind, "storage-capacity-unknown"); assert.equal(findings[0]!.severity, "unknown");
  }
});

it("distinguishes not-yet-measured, failed and unsupported collection", () => {
  for (const state of ["unmeasured", "unavailable", "unsupported"] as const) {
    const value = root(); value.state = state; value.capacity = null;
    const finding = deriveStorageFindings(health(value), now)[0]!;
    assert.equal(finding.severity, state === "unmeasured" ? "unmeasured" : "unknown");
    assert.equal(finding.remedy?.control ?? null, state === "unsupported" ? null : "storage-refresh");
  }
});

it("reports admission audit/reconciliation and limited scope without granting repairs", () => {
  const input = { ...health(root()), limited: true, admission: { state: "reconciling" as const, reservations: 1, uncertain: 1 } };
  const findings = deriveStorageFindings(input, now);
  assert(findings.some(f => f.kind === "storage-control-unavailable" && f.remedy === null));
  assert(findings.some(f => f.kind === "storage-capacity-unknown" && f.occurrence === "scope"));
});

it("retains the collector's measured recovery latch rather than clearing on one high sample", () => {
  const value = root(); value.pressure = { volumeId: "volume-a", mappingRevision: "mount-a", warning: true, critical: true,
    warningClearSince: epoch, criticalClearSince: epoch, lastMeasuredAt: epoch };
  const finding = deriveStorageFindings(health(value), now)[0]!;
  assert.equal(finding.kind, "storage-pressure"); assert.equal(finding.severity, "degraded");
});

it("carries a typed control-store failure without exposing filesystem error text", () => {
  for (const [reason, clause] of [["invalid", /corrupt/], ["permission", /access/], ["disk-full", /space/], ["read-failed", /read/], ["write-failed", /save/]] as const) {
    const input: StorageHealthSnapshot = { ...health(root()), admission: { state: "unavailable", reason, reservations: 0, uncertain: 0 } };
    const finding = deriveStorageFindings(input, now)[0]!;
    assert.equal(finding.kind, "storage-control-unavailable"); assert.match(finding.cause.statement, clause);
    assert.equal(finding.remedy, null); FindingSchema.parse({ ...finding, firstSeen: now });
  }
});

it("offers a scoped review only for fresh receipt candidates on the warning's measured volume", () => {
  const finding = deriveStorageFindings(health(root("media", 4 * GiB)), now, { available: true, pending: false, scope })[0]!;
  assert.deepEqual(finding.remedy, { control: "local-preview-cleanup-review", target: scope.revision });
  assert.deepEqual(finding.facts.find(f => f.name === "reviewable-previews"), { name: "reviewable-previews", value: 1,
    source: "app.recoveryPolicy.cleanup.scope", measuredAt: now });
  assert.match(finding.note!, /Needs your approval/); assert.match(finding.note!, /recoverable space is unknown/);
  FindingSchema.parse({ ...finding, firstSeen: now });
  const other = root("exports", 4 * GiB); other.capacity!.volumeId = "volume-b";
  const mixed = deriveStorageFindings(health(root("media", 4 * GiB), other), now, { available: true, pending: false, scope });
  assert.equal(mixed.find(f => f.occurrence === "volume-a")?.remedy?.target, scope.revision);
  assert.equal(mixed.find(f => f.occurrence === "volume-b")?.remedy, null);
});

it("withholds cleanup review for stale, future, changed or unavailable cache scope and restored headroom", () => {
  const input = health(root("media", 4 * GiB));
  for (const patch of [{ volumeId: "volume-b" }, { mappingRevision: "mount-b" }, { candidateFiles: 0 },
    { measuredAt: epoch - 60_001 }, { measuredAt: epoch + 1 }, { inventoryAt: epoch - 60_001 }, { inventoryAt: epoch + 1 }]) {
    const finding = deriveStorageFindings(input, now, { available: true, pending: false, scope: { ...scope, ...patch } })[0]!;
    assert.equal(finding.remedy, null); assert(!finding.facts.some(f => f.name === "reviewable-previews"));
    assert.match(finding.note!, /You need to free space/);
  }
  for (const patch of [{ available: false }, { pending: true }]) {
    assert.equal(deriveStorageFindings(input, now, { available: true, pending: false, scope, ...patch })[0]!.remedy, null);
  }
  const recovered = root("media", 20 * GiB);
  recovered.pressure = { volumeId: "volume-a", mappingRevision: "mount-a", warning: true, critical: false,
    warningClearSince: epoch, criticalClearSince: null, lastMeasuredAt: epoch };
  assert.equal(deriveStorageFindings(health(recovered), now, { available: true, pending: false, scope })[0]!.remedy, null);
});
