import type { Finding } from "./diagnostics.js";
import { STORAGE_POLICY, storageWarningFloor, recentStorageShortfalls, type StorageHealthSnapshot, type StorageRootHealth } from "./storage-health.js";
import type { RecoveryPolicySnapshot } from "./recovery-settings.js";

type Draft = Omit<Finding, "firstSeen">;
const refresh = { control: "storage-refresh" as const };
const auditReasons = {
  invalid: "the saved storage status is corrupt", permission: "Arke cannot access its saved storage status",
  "disk-full": "the disk reported insufficient space for storage status", "read-failed": "Arke could not read its storage status", "write-failed": "Arke could not save its storage status",
};

/** SPEC-062 measurements enter SPEC-032's single finding model. No I/O, world data or guessed job
 * correlation: an observed volume risk is not proof that a particular provider result failed. */
export function deriveStorageFindings(health: StorageHealthSnapshot | null | undefined, now: string,
  cleanup?: Pick<NonNullable<RecoveryPolicySnapshot["cleanup"]>, "available" | "pending" | "scope">): Draft[] {
  if (!health) return [];
  const findings: Draft[] = [], at = Date.parse(now);
  const unknown = (occurrence: string, roots: readonly StorageRootHealth[], statement: string, remeasure = true): Draft => ({
    kind: "storage-capacity-unknown", occurrence, severity: roots.length > 0 && roots.every(root => root.state === "unmeasured") ? "unmeasured" : "unknown", title: "Storage capacity is unknown",
    facts: [{ name: "destinations", value: roots.length, source: "app.storageHealth.roots", measuredAt: now }],
    cause: { statement }, remedy: remeasure ? refresh : null, consequences: [],
  });
  if (health.limited) findings.push(unknown("scope", [], "some active destinations exceed this host's measurement scope"));
  if (health.admission?.state === "unavailable" || health.admission?.state === "reconciling") findings.push({
    kind: "storage-control-unavailable", occurrence: "host", severity: "unknown", title: "Storage admission needs attention",
    facts: [{ name: "state", value: health.admission.state, source: "app.storageHealth.admission", measuredAt: now },
      { name: "uncertain-reservations", value: health.admission.uncertain, source: "app.storageHealth.admission", measuredAt: now }],
    cause: { statement: health.admission.state === "reconciling" ? "earlier storage work is waiting for verification" : health.admission.reason ? auditReasons[health.admission.reason] : "the saved storage status is unavailable",
      ...(health.admission.state === "unavailable" && !health.admission.reason ? { upstreamGeneric: "SPEC-062 requires a typed storage audit failure reason" } : {}),
    },
    remedy: null, consequences: [], note: "Saved work is kept.",
  });
  const volumes = new Map<string, StorageRootHealth[]>();
  const shortfalls = new Map<string, ReturnType<typeof recentStorageShortfalls>[number]>();
  for (const item of recentStorageShortfalls(health, at)) {
    if (!shortfalls.has(item.volume.volumeId) || shortfalls.get(item.volume.volumeId)!.check.checkedAt < item.check.checkedAt) shortfalls.set(item.volume.volumeId, item);
    volumes.set(item.volume.volumeId, []);
  }
  for (const root of health.roots) {
    if (!root.capacity) {
      findings.push(unknown(root.rootId, [root], root.state === "unmeasured" ? "the destination has not been measured yet" : root.state === "unsupported" ? "this host does not support measurement of this destination" : "the destination could not be measured", root.state !== "unsupported"));
    } else {
      const group = volumes.get(root.capacity.volumeId) ?? []; group.push(root); volumes.set(root.capacity.volumeId, group);
    }
  }
  for (const [volumeId, roots] of volumes) {
    const shortfall = shortfalls.get(volumeId)?.volume;
    const fresh = roots.filter(root => root.state === "measured" && root.capacity!.availableBytes !== null &&
      root.capacity!.measuredAt <= at && at - root.capacity!.measuredAt <= STORAGE_POLICY.forecastMaxAgeMs);
    if (fresh.length !== roots.length) findings.push(unknown(volumeId, roots, "one or more destination measurements are unavailable or stale"));
    if (!fresh.length && !shortfall) continue;
    fresh.sort((a, b) => a.capacity!.availableBytes! - b.capacity!.availableBytes!);
    const capacity = fresh[0]?.capacity ?? { volumeId, measuredAt: shortfall!.measuredAt, availableBytes: shortfall!.availableBytes, totalBytes: null };
    const floor = storageWarningFloor(capacity.totalBytes);
    const latched = fresh.filter(root => root.pressure?.volumeId === volumeId && root.pressure.mappingRevision === root.capacity!.mappingRevision);
    const critical = capacity.availableBytes! <= STORAGE_POLICY.reserveBytes || latched.some(root => root.pressure!.critical);
    const forecast = fresh.map(root => root.forecast).find(value => value?.warning && value.to <= at && at - value.to <= STORAGE_POLICY.forecastMaxAgeMs);
    if (!shortfall && !critical && capacity.availableBytes! >= floor && !latched.some(root => root.pressure!.warning) && !forecast) continue;
    const measuredAt = new Date(shortfall?.measuredAt ?? capacity.measuredAt).toISOString();
    const scope = cleanup?.scope;
    const review = cleanup?.available && !cleanup.pending && scope && scope.candidateFiles > 0 && scope.volumeId === volumeId &&
      scope.measuredAt <= at && at - scope.measuredAt <= STORAGE_POLICY.forecastMaxAgeMs && scope.inventoryAt <= at && at - scope.inventoryAt <= STORAGE_POLICY.forecastMaxAgeMs &&
      fresh.some(root => root.capacity!.mappingRevision === scope.mappingRevision) && (shortfall || capacity.availableBytes! < floor + STORAGE_POLICY.clearMarginBytes)
      ? scope : null;
    findings.push({ kind: "storage-pressure", occurrence: volumeId,
      // Specific work holds require the owning operation's causal evidence; this measured risk
      // alone does not invent an affected job count or claim a paid result failed.
      severity: shortfall || critical ? "degraded" : "advisory", title: shortfall ? "A recent storage check could not fit" : "Storage is running low",
      facts: [
        { name: "available-bytes", value: shortfall?.availableBytes ?? capacity.availableBytes, source: shortfall ? "app.storageHealth.spaceChecks" : "app.storageHealth.roots.capacity", measuredAt },
        { name: "reserve-bytes", value: shortfall?.reserveBytes ?? STORAGE_POLICY.reserveBytes, source: shortfall ? "app.storageHealth.spaceChecks" : "storage-policy", measuredAt: shortfall ? measuredAt : now },
        ...(shortfall ? [
          { name: "reserved-bytes", value: shortfall.reservedBytes, source: "app.storageHealth.spaceChecks", measuredAt },
          { name: "remaining-peak-bytes", value: shortfall.peakBytes, source: "app.storageHealth.spaceChecks", measuredAt },
          { name: "deficit-bytes", value: shortfall.deficitBytes, source: "app.storageHealth.spaceChecks", measuredAt },
        ] : []),
        { name: "warning-floor-bytes", value: floor, source: "storage-policy", measuredAt: now },
        { name: "destinations", value: fresh.length, source: "app.storageHealth.roots", measuredAt: now },
        ...(review ? [{ name: "reviewable-previews", value: review.candidateFiles, source: "app.recoveryPolicy.cleanup.scope", measuredAt: new Date(review.inventoryAt).toISOString() }] : []),
        ...(forecast ? [
          { name: "forecast-window-ms", value: forecast.to - forecast.from, source: "app.storageHealth.roots.forecast", measuredAt: new Date(forecast.to).toISOString() },
          { name: "estimated-time-to-reserve-ms", value: forecast.timeToReserveMs, source: "app.storageHealth.roots.forecast", measuredAt: new Date(forecast.to).toISOString() },
        ] : []),
      ],
      cause: { statement: shortfall ? "the recorded operation check could not fit its planned writes, existing commitments and reserve; the operation's current status remains with its own controls" : critical ? "available space has reached the operational reserve or is awaiting confirmed recovery" : capacity.availableBytes! < floor ? "available space is below the warning threshold" : forecast ? "recent volume-wide usage estimates reaching the reserve within thirty minutes" : "free space has improved but recovery still needs two separated fresh readings" },
      remedy: review ? { control: "local-preview-cleanup-review", target: review.revision } : null, consequences: [],
      note: review ? "Needs your approval · Review older local preset previews on this volume. File eligibility is verified before approval; recoverable space is unknown. Creative media is retained."
        : "You need to free space on the affected drive, then refresh. Creative media is retained.",
    });
  }
  return findings;
}
