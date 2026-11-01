import { Link } from "react-router";
import { storageByteLabel, type JobStorageWait, type StorageRootRole } from "@arke-studio/contracts";
import { closeActivityPanel } from "../lib/activity-panel.js";

const roles: Record<StorageRootRole, string> = { "local-ai": "Local AI", "generated-media": "Generated media", "working-files": "Working files", downloads: "Downloads", exports: "Exports" };
const reasons: Record<NonNullable<JobStorageWait["detail"]>["code"], [string, string]> = {
  "capacity-unavailable": ["Destination measurement unavailable", "Arke could not measure this destination. It will check again before continuing."],
  "capacity-stale": ["Storage measurement needs updating", "Arke will check this destination again before continuing."],
  "mapping-changed": ["Destination changed", "Review the destination in Diagnostics before continuing."],
  "unbounded-output": ["Required space is unknown", "Review the operation’s output settings before retrying."],
  space: ["More storage space needed", "Free space on this drive. Arke will recheck before continuing."],
  "audit-unavailable": ["Storage accounting unavailable", "Open Diagnostics to check storage access. Available space alone cannot clear this hold."],
  "reconciliation-required": ["Earlier storage work needs reconciliation", "Open Diagnostics to review unresolved storage work. Do not repeat generation."],
  "reservation-limit": ["Too many storage operations", "Wait for existing work to finish. Arke will check again."],
  stopped: ["Storage checking stopped", "Reconnect to the host to see its current status."],
  "destination-unavailable": ["Destination unavailable", "Check that the world and its working folders are available on the host."],
  "different-volumes": ["Result destinations are on different drives", "Review the staging and saved-media locations before retrying local saving."],
};

/** The job's own observation wins over broad drive health; never infers provider progress. */
export function JobStorageWaitNotice({ wait, now = Date.now(), connected = true }: { wait?: JobStorageWait; now?: number; connected?: boolean }) {
  if (!wait) return null;
  const detail = wait.detail, [title, next] = reasons[detail?.code ?? (wait.reason === "space" ? "space" : "capacity-unavailable")];
  const measured = detail?.measuredAt, observed = Date.parse(wait.observedAt);
  const at = measured ?? observed, seconds = Math.max(0, Math.floor((now - at) / 1000));
  const count = seconds < 60 ? seconds : Math.floor(seconds / 60), unit = seconds < 60 ? "second" : "minute";
  const age = at > now || !Number.isFinite(at) ? "Check time unavailable" : `${measured === undefined ? "Checked" : "Measured"} ${count} ${unit}${count === 1 ? "" : "s"} ago`;
  return <div className="fy-ap__reason" role="status">
    <b>{!connected ? "Last reported storage hold" : wait.checking ? "Checking destination…" : wait.phase === "submission" ? "Not submitted" : "Result awaiting saving"}</b>
    <div>{title}</div>
    <div className="fy-ap__rowsub">{[...(detail?.roles.map(role => roles[role]) ?? []), age].join(" · ")}</div>
    {detail?.availableBytes !== undefined && <div>Available at check: {storageByteLabel(detail.availableBytes)}</div>}
    {detail?.deficitBytes !== undefined && <div>Additional space needed: {storageByteLabel(detail.deficitBytes)}</div>}
    <div>{connected ? next : "Reconnect to see the operation’s current status."}</div>
    <div className="fy-ap__rowsub">{wait.phase === "submission" ? "This request has not reached the provider." : "Generation finished. The result is retained; generation has not been repeated."}</div>
    <Link className="fy-studio-button" to="/settings/diagnostics" onClick={closeActivityPanel}>Open Diagnostics</Link>
  </div>;
}
