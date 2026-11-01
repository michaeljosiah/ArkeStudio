import { useEffect, useRef, useState } from "react";
import type { RecoveryCachePlan } from "@arke-studio/contracts";
import { reviewRecoveryAction, useStore } from "../lib/store.js";
import { isRemoteSession } from "../lib/remote-session.js";
import { Button } from "./ui.js";

const bytes = (value: number | null) => value === null ? "unknown" : `${value.toLocaleString()} bytes`;

export function RecoveryCacheCleanupControls({ scope, id = "recovery-cache-cleanup", focusOnScope = true }: { scope?: string; id?: string; focusOnScope?: boolean } = {}) {
  const { state, connection, recoveryActionResults } = useStore(), policy = state?.app.recoveryPolicy;
  const [request, setRequest] = useState<string | null>(null), [plan, setPlan] = useState<RecoveryCachePlan | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [cancelled, setCancelled] = useState(false);
  const [checking, setChecking] = useState(false);
  const submitting = useRef(false), result = request ? recoveryActionResults[request] : undefined;
  const focused = useRef<string | null>(null);
  const previousScope = useRef(scope);
  const available = !isRemoteSession() && connection === "open" && policy?.accepting;
  const scopeCurrent = scope === undefined || /^[a-f0-9]{64}$/.test(scope) && policy?.cleanup?.scope?.revision === scope;
  useEffect(() => {
    if (previousScope.current === scope) return;
    previousScope.current = scope;
    // An approval already sent retains its original target. A pending review grants no
    // authority and its late reply must not populate a different warning's dialog.
    if (busy && (plan || checking)) return;
    if (plan && available) reviewRecoveryAction({ action: "cancel", planId: plan.id });
    setPlan(null); setRequest(null); setBusy(false); submitting.current = false; setMessage("");
  }, [scope]);
  useEffect(() => {
    if (!focusOnScope || !scope || focused.current === scope) return;
    const section = document.getElementById(id);
    if (section) { section.scrollIntoView?.({ block: "center" }); section.focus?.({ preventScroll: true }); focused.current = scope; }
  }, [scope, Boolean(policy?.cleanup), id, focusOnScope]);
  useEffect(() => {
    if (!request) return;
    if (connection !== "open") {
      submitting.current = false; setRequest(null); setPlan(null); setBusy(false);
      setMessage("Connection lost. Cleanup is unconfirmed; check Diagnostics. This request will not be sent again."); return;
    }
    if (result?.status === "preview" && result.cleanupPlan) {
      submitting.current = false; setPlan(result.cleanupPlan); setRequest(null); setBusy(false); setMessage(""); return;
    }
    if (result?.status === "accepted") { setPlan(result.cleanupPlan ?? null); setMessage(checking ? "Checking the original cleanup worker and file. No deletion will be repeated…" : "Cleanup admitted. Waiting for its owner’s verified outcome…"); }
    else if (result) {
      submitting.current = false; setRequest(null); setPlan(null); setBusy(false);
      const confirmed = result.cleanup ? `Confirmed removals: ${result.cleanup.removedFiles}. Available before: ${bytes(result.cleanup.availableBefore)}; after: ${bytes(result.cleanup.availableAfter)}. Space attributable to cleanup is unknown.` : "";
      setMessage(result.reconciliation ? (result.reconciliation.outcome === "removed" ? "The original audition is no longer present. Its cleanup hold is settled. "
        : result.reconciliation.outcome === "retained" ? "The original audition is intact. Its cleanup hold is settled; nothing was deleted by this check. "
        : "Cleanup remains unconfirmed. The original worker or file could not be verified; its hold remains. ") + `Available space: ${bytes(result.reconciliation.availableBytes)}. No deletion was repeated.`
        : (result.status === "verified" ? "The approved cleanup finished. "
        : result.status === "unknown" ? "Cleanup is unconfirmed. Its durable intent remains held; check Diagnostics before further cleanup. "
        : result.status === "cancelled" ? "Cleanup stopped between admitted steps. Completed deletions cannot be undone. "
        : "No current cleanup plan is available. Files may be too recent, in use or unverified; review Diagnostics. ") + confirmed);
      return;
    }
    const timer = setTimeout(() => setMessage("Cleanup is unconfirmed. Check Diagnostics; this request will not be sent again."), 30_000);
    return () => clearTimeout(timer);
  }, [request, result, connection, checking]);
  useEffect(() => {
    if (!plan || busy) return;
    const timer = setTimeout(() => { setPlan(null); setMessage("The cleanup review expired. Review current files again."); }, Math.max(0, plan.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [plan, busy]);
  const send = (command: Parameters<typeof reviewRecoveryAction>[0]) => {
    if (submitting.current || !available) return;
    submitting.current = true; const id = reviewRecoveryAction(command);
    setChecking(command.action === "reconcile-cleanup");
    submitting.current = id !== null; setRequest(id); setBusy(id !== null); setCancelled(false);
    if (!id) setMessage("The request could not be sent. Reconnect and check Diagnostics.");
  };
  if (!policy?.cleanup && !plan && !message) return null;
  return <section aria-label="Review local preview cleanup" id={id} tabIndex={-1}>
    <div className="fy-set__row">
      <div className="fy-set__name fy-set__name--wide"><div className="fy-set__title">Expired local preset previews</div>
        <div className="fy-set__caps">Saved audition previews · New or active previews are kept.</div></div>
      <Button disabled={!available || busy || !policy?.cleanup?.available || !scopeCurrent} onClick={() => send({ action: "preview-cleanup", ...(scope !== undefined ? { scope } : {}) })}>Review previews…</Button>
    </div>
    {scope !== undefined && !plan && !busy && <p className="fy-diag__meta">{scopeCurrent ? "Reviewing previews on the volume named by the storage warning. Opening this review approves no deletion." : "This storage review target is no longer current. Refresh Diagnostics before reviewing cleanup."}</p>}
    {policy?.cleanup?.pending && <p className="fy-diag__meta" role="status">An earlier cleanup has an unconfirmed outcome. Its intent is retained and further cleanup is held.</p>}
    {policy?.cleanup?.pending && <Button disabled={!available || busy} onClick={() => send({ action: "reconcile-cleanup" })}>Check cleanup outcome</Button>}
    {policy?.cleanup?.audit === "unavailable" && <p className="fy-diag__meta" role="status">Cleanup control is unavailable. {policy.cleanup.reason === "disk-full" ? "Disk space is needed to record cleanup safely." : policy.cleanup.reason === "permission" ? "The host cannot access its cleanup record." : "Its saved record needs attention."} Cleanup stays held.</p>}
    {policy?.cleanup?.reason === "unsupported" && <p className="fy-diag__meta">Native preview cleanup is unavailable on this host.</p>}
    {plan && <div className="fy-set__row fy-set__row--stack">
      <div className="fy-set__title">Delete {plan.files} expired local preset {plan.files === 1 ? "preview" : "previews"}?</div>
      {plan.scope && <p className="fy-diag__meta">This plan is bound to the storage warning’s cache root and volume.</p>}
      <p className="fy-diag__meta">Recorded size: {bytes(plan.logicalBytes)}. Observed allocation: {bytes(plan.allocatedBytes)}. Recovered space may differ. These fixed auditions are at least seven days old and can be generated again. Deletion cannot be undone.</p>
      <ul className="fy-diag__meta">{plan.targets.map((target, index) => <li key={target.resourceKey}>Local audition {index + 1} · {new Date(target.createdAt).toLocaleDateString()} · {bytes(target.logicalBytes)}</li>)}</ul>
      {plan.stopAtAvailableBytes !== null && <p className="fy-diag__meta">Stops early if measured available space reaches {bytes(plan.stopAtAvailableBytes)}. Waiting work still needs its own fresh admission.</p>}
      {!busy ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button disabled={!available} onClick={() => send({ action: "approve-cleanup", planId: plan.id })}>Approve this cleanup</Button>
        <Button disabled={!available} onClick={() => { reviewRecoveryAction({ action: "cancel", planId: plan.id }); setPlan(null); }}>Keep previews</Button>
      </div> : result?.status === "accepted" ? <Button disabled={!available || cancelled} onClick={() => {
        setCancelled(true); const id = reviewRecoveryAction({ action: "cancel", planId: plan.id });
        setMessage(id ? "Cancellation requested. An admitted file step may still finish; completed deletions cannot be undone." : "Cancellation is unconfirmed. Check Diagnostics.");
      }}>Cancel remaining cleanup</Button> : <p className="fy-diag__meta">Waiting for the host receipt…</p>}
    </div>}
    {message && <p className="fy-diag__meta" role="status">{message}</p>}
  </section>;
}
