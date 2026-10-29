import { useEffect, useRef, useState } from "react";
import { CACHE_MAINTENANCE_POLICY } from "@arke-studio/contracts";
import { reviewRecoveryAction, useStore } from "../lib/store.js";
import { isRemoteSession } from "../lib/remote-session.js";
import { Button } from "./ui.js";

export function RecoveryCacheMaintenanceControls() {
  const { state, connection, recoveryActionResults } = useStore(), policy = state?.app.recoveryPolicy;
  const cleanup = policy?.cleanup, maintenance = cleanup?.maintenance;
  const [reviewing, setReviewing] = useState(false), [request, setRequest] = useState<string | null>(null), [message, setMessage] = useState("");
  const pendingValue = useRef<boolean | null>(null), result = request ? recoveryActionResults[request] : undefined;
  const connected = !isRemoteSession() && connection === "open";
  useEffect(() => {
    if (!request) return;
    if (connection !== "open") {
      pendingValue.current = null; setRequest(null); setReviewing(false);
      setMessage("Connection lost. The maintenance setting is unconfirmed; check its saved value after reconnecting. This request will not be sent again."); return;
    }
    if (result) {
      pendingValue.current = null; setRequest(null); setReviewing(false);
      setMessage(result.status === "verified" && result.maintenanceSaved !== undefined
        ? result.maintenanceSaved ? "Automatic preset preview cleanup is enabled on this PC." : "Automatic preset preview cleanup is disabled. An admitted file step may still finish."
        : "The maintenance setting could not be confirmed. Check the saved policy and Diagnostics.");
      return;
    }
    const timer = setTimeout(() => setMessage("The maintenance setting is unconfirmed. Check its saved value; this request will not be sent again."), 30_000);
    return () => clearTimeout(timer);
  }, [request, result, connection]);
  const send = (enabled: boolean) => {
    // Withdrawal may overtake this component's pending enable; duplicate withdrawals cannot.
    if (!connected || pendingValue.current !== null && (enabled || pendingValue.current === false)) return;
    const id = reviewRecoveryAction({ action: "set-cleanup-maintenance", enabled });
    pendingValue.current = id ? enabled : null; setRequest(id);
    setMessage(id ? "Saving maintenance policy…" : "The setting could not be sent. Check Diagnostics before trying again.");
  };
  if (!maintenance) return null;
  return <section aria-label="Automatic preset preview maintenance">
    <div className="fy-set__row">
      <div className="fy-set__name fy-set__name--wide"><div className="fy-set__title">Automatic preset preview cleanup</div>
        <div className="fy-set__caps">{maintenance.enabled ? "Enabled" : "Off"} · Arke’s fixed local preset preview cache on this PC.</div></div>
      {maintenance.enabled
        ? <Button disabled={!connected || pendingValue.current === false} onClick={() => send(false)}>Disable automatic cleanup</Button>
        : <Button disabled={!connected || !!request || !policy?.accepting || cleanup?.audit !== "available" || !cleanup.available} onClick={() => setReviewing(true)}>Review automatic cleanup…</Button>}
    </div>
    {reviewing && !maintenance.enabled && <div className="fy-set__row fy-set__row--stack">
      <div className="fy-set__title">Allow automatic cleanup of fixed local preset previews?</div>
      <p className="fy-diag__meta">Only verified, unused auditions in Arke’s local preset preview cache, at least {maintenance.minAgeMs / 86_400_000} days old. Up to {maintenance.maxFiles} files and {maintenance.maxBytes / 1024 ** 3} GiB per run; individual auditions remain limited to 12 MiB. At most once every {CACHE_MAINTENANCE_POLICY.intervalMs / 60_000} minutes, while Automatic recovery is enabled and that cache’s volume is low on space.</p>
      <p className="fy-diag__meta">Stops when measured headroom is restored. Completed deletions cannot be undone; fixed auditions can be generated again. Artifacts, cloned recordings and model files stay protected. Disabling prevents further admissions; an admitted step may finish.</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button disabled={!connected || !!request || !policy?.accepting || cleanup?.audit !== "available"} onClick={() => send(true)}>Enable automatic cleanup</Button>
        <Button disabled={!!request} onClick={() => setReviewing(false)}>Keep automatic cleanup off</Button>
      </div>
    </div>}
    {maintenance.enabled && policy?.mode === "suggest-only" && <p className="fy-diag__meta">Suggest only holds automatic cleanup. Your standing cache policy is retained.</p>}
    {maintenance.lastRun && <p className="fy-diag__meta">Last automatic run · {new Date(maintenance.lastRun.at).toLocaleString()} · {{ verified: "Finished", refused: "No verified cleanup available", unknown: "Outcome unconfirmed", cancelled: "Stopped" }[maintenance.lastRun.status]}. Confirmed removals: {maintenance.lastRun.cleanup.removedFiles}. Available space after: {maintenance.lastRun.cleanup.availableAfter === null ? "unknown" : `${maintenance.lastRun.cleanup.availableAfter.toLocaleString()} bytes`}. Space attributable to cleanup is unknown.</p>}
    {maintenance.lastRun?.status === "unknown" && !cleanup?.pending && <p className="fy-diag__meta">The original file hold has since been settled. The recorded attempt outcome remains separate from current storage health.</p>}
    {message && <p className="fy-diag__meta" role="status">{message}</p>}
  </section>;
}
