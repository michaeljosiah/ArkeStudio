import type { Finding } from "./diagnostics.js";
import type { MingCleanupSnapshot } from "./recovery-actions.js";

/** The GPU owner reports a retained original lease, not a guessed Python/service health. */
export function mingCleanupFindings(source: MingCleanupSnapshot | undefined, now: string): Omit<Finding, "firstSeen">[] {
  if (!source || !source.scope || !["held", "checking"].includes(source.state)) return [];
  const at = Date.parse(now), fresh = Number.isSafeInteger(at) && source.measuredAt <= at && at - source.measuredAt <= 60_000;
  const measuredAt = fresh ? new Date(source.measuredAt).toISOString() : now;
  return [{ kind: "ming-cleanup-unconfirmed", occurrence: source.scope, severity: fresh ? "degraded" : "unknown", title: "Ming cleanup needs attention",
    facts: [{ name: "uncertain-reservations", value: fresh ? 1 : null, source: "app.recoveryPolicy.mingCleanup", measuredAt },
      { name: "waiting", value: fresh ? source.waiting : null, source: "app.recoveryPolicy.mingCleanup.waiting", measuredAt },
      { name: "cleanup-checking", value: fresh ? Number(source.state === "checking") : null, source: "app.recoveryPolicy.mingCleanup.state", measuredAt }],
    cause: { statement: fresh ? "Ming's original worker cleanup has not been confirmed; its graphics-card reservation is retained"
      : "the current Ming cleanup observation is unavailable or stale" },
    remedy: !fresh ? { control: "ming-cleanup-refresh" } : source.state === "held" && source.available ? { control: "ming-cleanup-review", target: source.scope } : null,
    consequences: [], note: !fresh ? "Refresh Diagnostics before taking action. An old observation cannot establish that the reservation was released."
      : source.state === "checking" ? "Arke is checking the original worker's cleanup. Submitted narration is not repeated."
      : source.available ? "Needs your approval · Review a retry of the original owned cleanup. It starts no inference and releases memory only after confirmed exit."
      : source.authority === "original-worker" ? "Another recovery is busy. Wait for its outcome, then refresh Diagnostics."
      : "Original cleanup authority is unavailable. Let Arke finish shutdown and run its owned-process checks on next start.",
  }];
}
