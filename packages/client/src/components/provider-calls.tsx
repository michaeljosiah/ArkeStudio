import { useEffect } from "react";
import type { ProviderCallRecord } from "@arke-studio/contracts";
import { Badge, Button, Callout } from "./ui.js";
import { shortDateTime } from "../lib/format.js";
import { listProviderCalls, useProviderCalls } from "../lib/store.js";

/**
 * A job's provider calls, or the hundred most recent when `jobId` is null. It used to live on the
 * Activity page; since design turn 136 it opens inside the Activity panel, where the panel's own
 * header is the way back, so the close control is drawn only for a caller that asks for one.
 */
export function ProviderCallInspector({ jobId, onClose }: { jobId: string | null; onClose?: () => void }) {
  const calls = useProviderCalls(jobId);
  useEffect(() => listProviderCalls(jobId), [jobId]);
  const copy = (call: ProviderCallRecord) => void navigator.clipboard.writeText(JSON.stringify(call, null, 2));
  return (
    <section className={onClose ? "fy-provider-calls" : "fy-provider-calls fy-provider-calls--bare"} aria-label="Provider calls">
      <div className="fy-provider-calls__head">
        <div><div className="fy-eyebrow-sm">PROVIDER CALLS</div><div className="fy-mono">{jobId ?? "100 most recent calls"}</div></div>
        {onClose && <Button variant="ghost" onClick={onClose}>Close</Button>}
      </div>
      <Callout tone="warning" title="Sensitive local history">
        Requests and responses may contain prompts and world content. Credentials and binary media are redacted or summarized.
      </Callout>
      {calls === null && <div className="fy-mono">loading call history…</div>}
      {calls?.length === 0 && <div className="fy-mono">No recorded calls. Calls made before this feature are not recoverable.</div>}
      {calls?.map((call) => (
        <details key={call.id} className="fy-provider-call" open={calls.length === 1}>
          <summary>
            <span>{call.operation}</span><span className="fy-mono">{call.method} {call.endpoint}</span>
            <Badge tone={call.status === "succeeded" || call.status === "accepted" ? "success" : call.status === "pending" ? "warning" : "danger"}>
              {call.status === "pending" ? "outcome unknown" : call.status}
            </Badge>
          </summary>
          <div className="fy-provider-call__meta">{shortDateTime(call.startedAt)} · attempt {call.attempt ?? "—"} · HTTP {call.httpStatus ?? "no response"} · {call.elapsedMs === null ? "still pending" : `${call.elapsedMs} ms`}</div>
          {call.error && <Callout tone="warning" title={`${call.error.name}${call.error.code ? ` · ${call.error.code}` : ""}`}>{call.error.message}</Callout>}
          <div className="fy-provider-call__payloads">
            <div><div className="fy-provider-call__label">REQUEST</div><pre>{JSON.stringify(call.request, null, 2)}</pre></div>
            <div><div className="fy-provider-call__label">RESPONSE</div><pre>{call.response === null ? "No response was witnessed." : JSON.stringify(call.response, null, 2)}</pre></div>
          </div>
          <Button variant="ghost" onClick={() => copy(call)}>Copy sensitive call JSON</Button>
        </details>
      ))}
    </section>
  );
}
