import type { VoiceBackgroundOperation } from "@arke-studio/contracts";
import { send, useConnection } from "../lib/store.js";

/** Retained background work remains cancellable after the microphone session ends. */
export function VoiceBackgroundActivity({ worldId, conversationId, operations }: {
  worldId: string; conversationId: string; operations: readonly VoiceBackgroundOperation[];
}) {
  const connected = useConnection() === "open";
  const rows = operations.filter(row => ["requested", "running", "cancel-requested", "unknown"].includes(row.status)).slice(-3);
  if (!rows.length) return null;
  return <div aria-label="Background lookups">
    {rows.map(row => <div key={row.id} className="fy-cx__voice-conversation">
      <small title={row.request}>{row.request.slice(0, 80)}{row.request.length > 80 ? "…" : ""} · <span role="status">{
        row.status === "unknown" ? "Interrupted; result unknown" : row.status === "cancel-requested" ? "Stopping" : "Checking in the background"
      }</span></small>
      {row.status !== "unknown" && <button type="button" className="fy-cx__tool" disabled={!connected || row.status === "cancel-requested"}
        onClick={() => send({ kind: "cancel-voice-background", worldId, conversationId, operationId: row.id, requestId: crypto.randomUUID() })}>Cancel lookup</button>}
    </div>)}
  </div>;
}
