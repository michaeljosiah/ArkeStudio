import { useEffect, useRef, useState } from "react";
import type { RecoveryMingCleanupPlan } from "@arke-studio/contracts";
import { reviewRecoveryAction, useStore } from "../lib/store.js";
import { isRemoteSession } from "../lib/remote-session.js";
import { Button } from "./ui.js";

/** This continues an original worker's cleanup; it cannot submit another reading. */
export function RecoveryMingCleanupControls({ scope }: { scope?: string } = {}) {
  const { state, connection, recoveryActionResults } = useStore(), source = state?.app.recoveryPolicy?.mingCleanup;
  const [request, setRequest] = useState<string | null>(null), [plan, setPlan] = useState<RecoveryMingCleanupPlan | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [cancelled, setCancelled] = useState(false);
  const submitting = useRef(false), previousScope = useRef(scope), focused = useRef<string | null>(null);
  const requestedScope = useRef<string | null>(null), approved = useRef(false);
  const result = request ? recoveryActionResults[request] : undefined;
  // Protective cleanup of the already-authorized original worker remains available if
  // general recovery audit writes are held. The host checks its original durable authority.
  const connectedOwner = !isRemoteSession() && connection === "open";
  const scopeCurrent = scope === undefined || /^[a-f0-9]{64}$/.test(scope) && source?.scope === scope;
  useEffect(() => {
    if (previousScope.current === scope) return;
    previousScope.current = scope;
    if (approved.current && busy) return;
    if (plan && connectedOwner) reviewRecoveryAction({ action: "cancel", planId: plan.id });
    setPlan(null); setRequest(null); setBusy(false); submitting.current = false; setMessage("");
  }, [scope]);
  useEffect(() => {
    if (!scope || focused.current === scope) return;
    const section = document.getElementById("recovery-ming-cleanup");
    if (section) { section.scrollIntoView?.({ block: "center" }); section.focus?.({ preventScroll: true }); focused.current = scope; }
  }, [scope, source?.state]);
  useEffect(() => {
    if (!request) return;
    if (!connectedOwner) {
      submitting.current = false; setRequest(null); setPlan(null); setBusy(false);
      setMessage("Connection lost. Ming cleanup is unconfirmed; check Diagnostics. This request will not be sent again."); return;
    }
    if (result?.status === "preview" && result.mingPlan) {
      submitting.current = false; setRequest(null); setBusy(false);
      if (result.mingPlan.scope !== requestedScope.current || result.mingPlan.scope !== source?.scope || !scopeCurrent) {
        reviewRecoveryAction({ action: "cancel", planId: result.mingPlan.id }); setPlan(null);
        setMessage("The original cleanup target changed. Refresh Diagnostics before reviewing again."); return;
      }
      setPlan(result.mingPlan); setMessage(""); return;
    }
    if (result?.status === "accepted") { setPlan(result.mingPlan ?? plan); setMessage("Checking the original worker’s exit. The graphics card stays reserved until cleanup is confirmed…"); }
    else if (result) {
      submitting.current = false; setRequest(null); setPlan(null); setBusy(false);
      setMessage(result.status === "verified" ? "Original Ming cleanup confirmed. Its graphics-card hold is settled. Submitted narration keeps its original outcome."
        : result.status === "unknown" ? "Ming cleanup remains unconfirmed. Its graphics-card hold stays in place; check Diagnostics."
        : result.status === "cancelled" ? "Cancellation requested. An admitted original cleanup may still finish; check Diagnostics for confirmation."
        : "The cleanup review is no longer current. Refresh Diagnostics before reviewing again."); return;
    }
    const timer = setTimeout(() => setMessage("Ming cleanup is unconfirmed. Check Diagnostics; this request will not be sent again."), 30_000);
    return () => clearTimeout(timer);
  }, [request, result, connectedOwner, source?.scope, scopeCurrent]);
  useEffect(() => {
    if (!plan || busy) return;
    const timer = setTimeout(() => { setPlan(null); setMessage("The Ming cleanup review expired. Review the current hold again."); }, Math.max(0, plan.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [plan, busy]);
  const send = (command: Parameters<typeof reviewRecoveryAction>[0]) => {
    if (submitting.current || !connectedOwner) return;
    submitting.current = true; approved.current = command.action === "approve-ming-cleanup";
    if (command.action === "preview-ming-cleanup") requestedScope.current = command.scope;
    const id = reviewRecoveryAction(command);
    submitting.current = id !== null; setRequest(id); setBusy(id !== null); setCancelled(false);
    if (!id) setMessage("The request could not be sent. Reconnect and check Diagnostics.");
  };
  const held = source?.state === "held" || source?.state === "checking";
  if (!held && scope === undefined && !plan && !message) return null;
  return <section aria-label="Review Ming cleanup" id="recovery-ming-cleanup" tabIndex={-1}>
    <div className="fy-set__row">
      <div className="fy-set__name fy-set__name--wide"><div className="fy-set__title">Ming graphics-card hold</div>
        <div className="fy-set__caps">Original worker cleanup is unconfirmed. Narration will not be repeated.</div></div>
      <Button disabled={!connectedOwner || busy || !source?.available || !scopeCurrent} onClick={() => source?.scope && send({ action: "preview-ming-cleanup", scope: source.scope })}>Review Ming cleanup…</Button>
    </div>
    {scope !== undefined && !plan && !busy && <p className="fy-diag__meta">{scopeCurrent ? "Opening this review starts no cleanup." : "This Ming cleanup target is no longer current. Refresh Diagnostics."}</p>}
    {held && source?.authority === "unavailable" && <p className="fy-diag__meta">Original cleanup authority is unavailable. Let Arke finish shutdown and check its owned processes on next start.</p>}
    {source?.state === "checking" && <p className="fy-diag__meta">Checking the original worker. The graphics card remains reserved.</p>}
    {plan && <div className="fy-set__row fy-set__row--stack">
      <div className="fy-set__title">Retry the original Ming worker’s cleanup?</div>
      <p className="fy-diag__meta">May terminate remaining processes owned by that worker. Starts no inference, changes no model and repeats no narration. The graphics-card reservation is released only after confirmed exit. Already-authorized waiting work still needs its own admission.</p>
      {!busy ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button disabled={!connectedOwner || !scopeCurrent || source?.scope !== plan.scope} onClick={() => send({ action: "approve-ming-cleanup", planId: plan.id })}>Approve Ming cleanup</Button>
        <Button disabled={!connectedOwner} onClick={() => { reviewRecoveryAction({ action: "cancel", planId: plan.id }); setPlan(null); }}>Keep hold</Button>
      </div> : result?.status === "accepted" ? <Button disabled={!connectedOwner || cancelled} onClick={() => {
        setCancelled(true); const id = reviewRecoveryAction({ action: "cancel", planId: plan.id });
        setMessage(id ? "Cancellation requested. Original cleanup already admitted may still finish; its outcome requires confirmation." : "Cancellation is unconfirmed. Check Diagnostics.");
      }}>Stop waiting for cleanup</Button> : <p className="fy-diag__meta">Waiting for the host receipt…</p>}
    </div>}
    {message && <p className="fy-diag__meta" role="status">{message}</p>}
  </section>;
}
