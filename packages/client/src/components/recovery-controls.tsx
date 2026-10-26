import { useEffect, useState } from "react";
import type { RecoveryMode } from "@arke-studio/contracts";
import { Button, Select } from "./ui.js";
import { controlRecoveryHistory, setRecoveryMode, setRecoveryPreferences, useStore } from "../lib/store.js";
import { isRemoteSession } from "../lib/remote-session.js";

/** Application policy stays on the host. These controls never approve a repair. */
export function RecoveryControls() {
  const { state, connection, recoveryCommandResults } = useStore(), policy = state?.app.recoveryPolicy, history = state?.app.recoveryHistory;
  const [pending, setPending] = useState<string | null>(null), [message, setMessage] = useState(""), [clearing, setClearing] = useState(false);
  const result = pending ? recoveryCommandResults[pending] : undefined;
  useEffect(() => {
    if (!pending) return;
    if (result) { setPending(null); setMessage(result.status === "saved" ? "Saved on this PC." : result.reason === "not-applicable" ? "That incident is no longer eligible for this change." : "The change could not be confirmed. Check current Diagnostics before trying again."); return; }
    if (connection !== "open") { setPending(null); setMessage("Connection lost. The change is unconfirmed; check the saved setting after reconnecting."); return; }
    const timer = setTimeout(() => { setPending(null); setMessage("The save is unconfirmed. Refresh Diagnostics to check the current setting."); }, 30_000);
    return () => clearTimeout(timer);
  }, [pending, result, connection]);
  if (!policy && !history) return null;
  const remote = isRemoteSession(), unavailable = remote || connection !== "open" || pending !== null;
  const request = (id: string | null) => { setPending(id); setMessage(id ? "Saving…" : "The command could not be sent. Reconnect before trying again."); };
  return <section aria-label="Recovery controls">
    <div className="fy-set__eyebrow">RECOVERY</div>
    {remote && <p className="fy-diag__meta">Change recovery settings on your PC.</p>}
    <div className="fy-set__row">
      <div className="fy-set__name fy-set__name--wide"><div className="fy-set__title">Recovery mode</div><div className="fy-set__caps">Automatic recovery can restart idle Arke-managed services after failure. Active work keeps its own controls.</div></div>
      <Select label="Recovery mode" value={policy?.mode ?? "automatic"} disabled={unavailable || !policy?.accepting}
        onChange={event => request(setRecoveryMode(event.target.value as RecoveryMode))}>
        <option value="automatic">Automatic recovery</option><option value="suggest-only">Suggest only</option>
      </Select>
    </div>
    {policy?.audit === "unavailable" && <p role="status" className="fy-diag__meta">Recovery control is unavailable. Automatic repairs are held.</p>}
    {history && <>
      <div className="fy-set__row">
        <div className="fy-set__name fy-set__name--wide"><div className="fy-set__title">In-app recovery alerts</div><div className="fy-set__caps">Incidents remain visible in Activity and Diagnostics when alerts are muted.</div></div>
        <Select label="In-app recovery alerts" value={history.preferences.transientMuted ? "muted" : "enabled"} disabled={unavailable || history.audit !== "available"}
          onChange={event => request(setRecoveryPreferences({ transientMuted: event.target.value === "muted" }))}>
          <option value="enabled">Enabled</option><option value="muted">Muted</option>
        </Select>
      </div>
      <div className="fy-set__row">
        <div className="fy-set__name fy-set__name--wide"><div className="fy-set__title">Recovery desktop notifications</div><div className="fy-set__caps">Generic Windows alerts while Arke is in the background. Background notifications must also be enabled.</div></div>
        <Select label="Recovery desktop notifications" value={history.preferences.desktopOptIn ? "enabled" : "off"} disabled={unavailable || history.audit !== "available"}
          onChange={event => request(setRecoveryPreferences({ desktopOptIn: event.target.value === "enabled" }))}>
          <option value="off">Off</option><option value="enabled">Enabled</option>
        </Select>
      </div>
      {history.resolvedCount > 0 && <div className="fy-set__row">
        <div className="fy-set__name fy-set__name--wide"><div className="fy-set__title">Resolved history</div><div className="fy-set__caps">Remove resolved summaries from this PC. Retry budgets, active incidents and creative files are kept.</div></div>
        {!clearing ? <Button disabled={unavailable || history.audit !== "available"} onClick={() => setClearing(true)}>Clear resolved…</Button>
          : <><Button disabled={unavailable || history.audit !== "available"} onClick={() => { setClearing(false); request(controlRecoveryHistory({ action: "clear-resolved" })); }}>Confirm clear</Button><Button onClick={() => setClearing(false)}>Keep history</Button></>}
      </div>}
    </>}
    {policy && policy.targets.some(target => target.circuitOpen || target.stoppedByUser || target.pendingOutcome) && <p className="fy-diag__meta">Some services remain held by a stop, exhausted retry budget or unconfirmed outcome. Changing mode does not release those holds.</p>}
    {message && <p role="status" className="fy-diag__meta">{message}</p>}
  </section>;
}
