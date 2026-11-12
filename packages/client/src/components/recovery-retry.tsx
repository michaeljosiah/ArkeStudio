import { useEffect, useRef, useState } from "react";
import type { RecoveryRetryPlan } from "@arke-studio/contracts";
import { reviewRecoveryAction, useStore } from "../lib/store.js";
import { isRemoteSession } from "../lib/remote-session.js";
import { Button } from "./ui.js";

const SERVICE = { ollama: "Ollama", comfyui: "ComfyUI", harness: "Writing service", voice: "Local voice", ming: "Ming" };
/** Opening a review never retries a service. The host must accept this exact one-use plan;
 * neither reconnection nor an observation timeout resubmits an uncertain request. */
export function RecoveryRetryControls() {
  const { state, connection, recoveryActionResults } = useStore(), policy = state?.app.recoveryPolicy;
  const [request, setRequest] = useState<string | null>(null), [plan, setPlan] = useState<RecoveryRetryPlan | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const submitting = useRef(false);
  const result = request ? recoveryActionResults[request] : undefined;
  const remote = isRemoteSession(), available = !remote && connection === "open" && policy?.accepting;
  useEffect(() => {
    if (!request) return;
    if (connection !== "open") { submitting.current = false; setRequest(null); setPlan(null); setBusy(false); setMessage("Connection lost. Check current Diagnostics before retrying; the request will not be sent again."); return; }
    if (result?.status === "preview") { submitting.current = false; setPlan(result.plan ?? null); setBusy(false); setRequest(null); setMessage(""); return; }
    if (result && result.status !== "accepted") {
      submitting.current = false; setBusy(false); setPlan(null); setRequest(null);
      setMessage(result.status === "verified" ? "Service readiness was verified. Submitted jobs keep their existing outcome."
        : result.status === "failed" ? "The retry failed. Review the current incident and recovery outcome."
        : result.status === "unknown" ? "The retry outcome is unconfirmed. Its owner retains any unresolved work. Check Diagnostics."
        : result.reason === "busy" ? "A recovery is still in progress. Wait for its current outcome."
        : "The review is no longer applicable. Refresh Diagnostics and review a new retry.");
      return;
    }
    if (result?.status === "accepted") { setPlan(result.plan ?? null); setMessage("Retry admitted. Waiting for the existing service owner and verification…"); }
    const timer = setTimeout(() => setMessage("The retry is unconfirmed. Check current Diagnostics; this request will not be sent again."), 30_000);
    return () => clearTimeout(timer);
  }, [request, result, connection]);
  useEffect(() => {
    if (!plan || busy) return;
    const timer = setTimeout(() => { setPlan(null); setMessage("The review expired. Review the current service before retrying."); }, Math.max(0, plan.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [plan, busy]);
  const send = (command: Parameters<typeof reviewRecoveryAction>[0]) => {
    if (submitting.current) return; submitting.current = true;
    const id = reviewRecoveryAction(command); submitting.current = id !== null; setRequest(id); setBusy(id !== null);
    if (!id) setMessage("The request could not be sent. Reconnect and check Diagnostics.");
  };
  const targets = policy?.targets.filter(target => target.retryAvailable) ?? [];
  if (!targets.length && !plan && !message) return null;
  return <section aria-label="Review managed service retry">
    {targets.map(target => <div key={target.key} className="fy-set__row">
      <div className="fy-set__name fy-set__name--wide"><div className="fy-set__title">{SERVICE[target.service]} retry</div>
        <div className="fy-set__caps">Arke-managed process exit is confirmed. Review before starting it again.</div></div>
      <Button disabled={!available || busy} onClick={() => send({ action: "preview-retry", resourceKey: target.key })}>Review retry…</Button>
    </div>)}
    {plan && <div className="fy-set__row fy-set__row--stack">
      <div className="fy-set__title">Retry {SERVICE[plan.service]}</div>
      <p className="fy-diag__meta">Start this stopped managed service once and verify readiness. It waits for Arke’s admitted work. No active Arke work is interrupted, and no download, runtime replacement or job replay is included. Startup may write logs or cache; extra space is unknown. Normal recovery policy still applies afterward.</p>
      {!busy ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button disabled={!available} onClick={() => send({ action: "approve-retry", planId: plan.id })}>Approve this retry</Button>
        <Button disabled={!available} onClick={() => { reviewRecoveryAction({ action: "cancel", planId: plan.id }); setPlan(null); }}>Cancel review</Button>
      </div> : result?.status === "accepted" ? <Button disabled={!available} onClick={() => {
        const id = reviewRecoveryAction({ action: "cancel", planId: plan.id });
        setMessage(id ? "Cancellation requested. An already started service may still finish verification." : "Cancellation is unconfirmed. Check current Diagnostics.");
      }}>Cancel waiting retry</Button> : <p className="fy-diag__meta">Waiting for the host receipt…</p>}
    </div>}
    {message && <p className="fy-diag__meta" role="status">{message}</p>}
  </section>;
}
