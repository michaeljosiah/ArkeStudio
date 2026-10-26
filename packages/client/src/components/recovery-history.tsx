import { useEffect, useRef, useState } from "react";
import { recoveryIncidentSummary, type RecoveryHistoryPage, type RecoveryHistoryQuery, type RecoveryHistorySnapshot } from "@arke-studio/contracts";
import { controlRecoveryHistory, readRecoveryHistory, useStore } from "../lib/store.js";
import { isRemoteSession } from "../lib/remote-session.js";
import { Button, Select } from "./ui.js";

const PHASE = { observing: "Observing", "action-available": "Action available", recovering: "Recovering", verifying: "Verifying", recovered: "Recovered", "needs-user": "Needs you", unresolved: "Unresolved" };
/** Retained history is a read-only revision. Presentation commands still go to the host and
 * wait for their own receipt; no incident button starts, resumes or approves creative work. */
export function RecoveryHistoryBrowser({ history }: { history: RecoveryHistorySnapshot | null | undefined }) {
  const { connection, recoveryHistoryPages, recoveryCommandResults } = useStore();
  const [filter, setFilter] = useState<RecoveryHistoryQuery["filter"]>("all"), [requestId, setRequestId] = useState<string | null>(null);
  const [page, setPage] = useState<RecoveryHistoryPage | null>(null), [pending, setPending] = useState<string | null>(null), [message, setMessage] = useState("");
  const response = requestId ? recoveryHistoryPages[requestId] : undefined, receipt = pending ? recoveryCommandResults[pending] : undefined;
  const clearReceipt = Object.values(recoveryCommandResults).findLast(result => result.operation === "recovery-history-control" && result.historyAction === "clear-resolved" && result.status === "saved");
  const seenClear = useRef(clearReceipt?.requestId);
  const load = (selected: RecoveryHistoryQuery["filter"], cursor?: RecoveryHistoryQuery["cursor"]) => {
    const id = readRecoveryHistory({ filter: selected, pageSize: 50, ...(cursor ? { cursor } : {}) });
    setRequestId(id); setMessage(id ? "Reading retained history…" : "History could not be requested. Reconnect before trying again.");
  };
  useEffect(() => { if (history && connection === "open") load(filter); }, [Boolean(history), connection]);
  useEffect(() => {
    if (!requestId) return;
    if (response) {
      setRequestId(null); setPage(response);
      setMessage(response.status === "stale" ? "History changed. Refresh to read its current revision." : response.status === "unavailable" ? "Retained history is unavailable. The current reconnect summary remains below." : "");
      return;
    }
    if (connection !== "open") { setRequestId(null); setMessage("Connection lost. Reconnect and refresh history."); return; }
    const timer = setTimeout(() => { setRequestId(null); setMessage("The read did not complete. Refresh history to try again."); }, 30_000);
    return () => clearTimeout(timer);
  }, [requestId, response, connection]);
  useEffect(() => {
    if (!pending) return;
    if (receipt) {
      setPending(null);
      if (receipt.status === "saved") load(filter);
      else setMessage(receipt.reason === "not-applicable" ? "The incident is no longer eligible. Refresh its current evidence." : "The change could not be confirmed. Check current Diagnostics before trying again.");
      return;
    }
    if (connection !== "open") { setPending(null); setMessage("Connection lost. The change is unconfirmed; refresh after reconnecting."); return; }
    const timer = setTimeout(() => { setPending(null); setMessage("The save is unconfirmed. Refresh before trying again."); }, 30_000);
    return () => clearTimeout(timer);
  }, [pending, receipt, connection, filter]);
  useEffect(() => {
    if (!clearReceipt || seenClear.current === clearReceipt.requestId) return;
    seenClear.current = clearReceipt.requestId;
    if (history && connection === "open") { setPage(null); load(filter); }
  }, [clearReceipt?.requestId]);
  if (!history) return null;
  const loaded = page?.status === "ready" && page.filter === filter ? page : null;
  const incidents = loaded?.incidents ?? (filter === "all" && page?.status !== "stale" ? history.incidents : []);
  const remote = isRemoteSession(), busy = pending !== null || requestId !== null || connection !== "open";
  const act = (command: Parameters<typeof controlRecoveryHistory>[0]) => {
    const id = controlRecoveryHistory(command); setPending(id); setMessage(id ? "Saving…" : "The command could not be sent. Reconnect before trying again.");
  };
  return <section aria-label="Recovery history">
    <div className="fy-diag__band"><span className="fy-rt__eyebrow">RECOVERY HISTORY</span></div>
    <div className="fy-set__row fy-set__row--stack">
      <div className="fy-diag__title">{history.activeCount} active · {history.resolvedCount} resolved</div>
      <div className="fy-diag__meta">{history.audit === "unavailable" ? "History could not be saved or read. Current evidence remains available in memory." : history.audit === "starting" ? "Reading local history…" : "Saved locally. Clearing history does not change restart limits or approvals."}</div>
      {history.overflow.lostDetail && <div className="fy-diag__meta">Some older detail was coalesced or pruned within the retention limit.</div>}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Select label="Recovery history filter" value={filter} disabled={busy} onChange={event => { const selected = event.target.value as typeof filter; setFilter(selected); setPage(null); load(selected); }}>
          <option value="all">All incidents</option><option value="active">Active</option><option value="resolved">Resolved</option>
        </Select>
        <Button size="sm" disabled={busy} onClick={() => load(filter)}>Refresh history</Button>
        {loaded && <span className="fy-diag__meta">{loaded.totalCount === 0 ? "0" : `${loaded.offset + 1}–${loaded.offset + loaded.incidents.length}`} of {loaded.totalCount} · as of {new Date(loaded.at).toLocaleTimeString()}</span>}
      </div>
      {message && <div role="status" className="fy-diag__meta">{message}</div>}
    </div>
    {incidents.map(incident => {
      const text = recoveryIncidentSummary(incident), canChange = !remote && !busy && history.audit === "available" && loaded !== null;
      return <div key={incident.id} className="fy-set__row fy-set__row--stack" data-incident-id={incident.id}>
        <div className="fy-diag__title">{text.title} · {PHASE[incident.phase]}</div>
        <div className="fy-diag__meta">{text.detail}</div>
        <div className="fy-diag__meta">Observed {new Date(incident.lastObservedAt).toLocaleString()}{incident.acknowledgedAt !== null ? " · Acknowledged" : ""}</div>
        {incident.phase !== "recovered" && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {incident.acknowledgedAt === null && <Button size="sm" disabled={!canChange} onClick={() => act({ action: "acknowledge", incidentId: incident.id })}>Acknowledge</Button>}
          {incident.severity === "advisory" && <>
            <Button size="sm" disabled={!canChange} onClick={() => act({ action: "snooze-hour", incidentId: incident.id })}>Snooze 1 hour</Button>
            <Button size="sm" disabled={!canChange} onClick={() => act({ action: "snooze-session", incidentId: incident.id })}>Snooze this session</Button>
          </>}
        </div>}
      </div>;
    })}
    {loaded && <div className="fy-set__row" style={{ gap: 8 }}>
      <Button size="sm" disabled={busy || !loaded.previousCursor} onClick={() => loaded.previousCursor && load(filter, loaded.previousCursor)}>Previous</Button>
      <Button size="sm" disabled={busy || !loaded.nextCursor} onClick={() => loaded.nextCursor && load(filter, loaded.nextCursor)}>Next</Button>
    </div>}
  </section>;
}
