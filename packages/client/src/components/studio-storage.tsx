import { useEffect, useState } from "react";
import { deriveStorageFindings, storageByteLabel as bytes, systemStorageGroups, type StorageHealthSnapshot, type StorageRootHealth, type StorageSpaceCheck } from "@arke-studio/contracts";
import { TriangleAlert } from "./icons.js";

const labels: Record<StorageRootHealth["role"], string> = { "local-ai": "Local models", "generated-media": "World media", "working-files": "Working files", downloads: "Downloads", exports: "Exports" };
const purposes: Record<StorageSpaceCheck["purpose"], string> = { setup: "Installation", job: "Generation", import: "Import", export: "Export", publication: "Publication", scratch: "Local processing", preview: "Preview", submission: "Generation preparation" };

/** Live host readings stay separate from the saved diagnosis and never grant write/repair authority. */
export function StudioStorageReadings({ health, connected }: { health?: StorageHealthSnapshot | null; connected: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick(value => value + 1), 1_000);
    const wake = () => tick(value => value + 1);
    document.addEventListener("visibilitychange", wake);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", wake); };
  }, []);
  return <StudioStorageReadingsView health={health} connected={connected} now={Date.now()} />;
}

export function StudioStorageReadingsView({ health, connected, now }: { health?: StorageHealthSnapshot | null; connected: boolean; now: number }) {
  const groups = systemStorageGroups(health?.roots ?? [], now);
  const checks = (health?.spaceChecks ?? []).filter(check => check.checkedAt <= now && now - check.checkedAt <= 15 * 60_000);
  const warnings = connected ? deriveStorageFindings(health ? { ...health, spaceChecks: [] } : health, new Date(now).toISOString()).filter(finding => finding.kind === "storage-pressure") : [];
  return <section aria-label="Latest storage readings">
    {!connected && <p className="fy-studio-note">Connection lost. These are the host’s last reported readings.</p>}
    {checks[0] && <StudioSpaceCheck check={checks[0]} now={now} />}
    {checks.length > 1 && <details className="fy-studio-fact-card"><summary>Earlier space checks ({checks.length - 1})</summary>
      {checks.slice(1).map(check => <StudioSpaceCheck key={check.id} check={check} now={now} />)}
    </details>}
    {!groups.length && <div className="fy-studio-fact-card"><div className="fy-studio-fact-head">Storage readings unavailable</div><p className="fy-studio-note">No destination measurements are available. Check Diagnostics for the current status.</p></div>}
    {groups.map(({ key, roots, root, fresh, unavailable }) => {
      const capacity = root.capacity && root.capacity.measuredAt <= now ? root.capacity : null, current = connected && fresh && !!capacity;
      const warning = current ? warnings.find(finding => finding.occurrence === capacity.volumeId) : undefined;
      const reserve = warning?.facts.find(fact => fact.name === "reserve-bytes")?.value;
      return <div className="fy-studio-fact-card" key={key}>
        <div className="fy-studio-fact-head">{warning && <TriangleAlert size={16} />}{warning ? "Storage needs attention" : "Storage readings"}</div>
        <div className="fy-studio-meta">{[...new Set(roots.map(row => labels[row.role]))].join(" · ")}</div>
        <p className="fy-studio-meta">{capacity ? `${current ? "Measured" : "Last measured"} ${new Date(capacity.measuredAt).toLocaleString()}` : root.state === "unsupported" ? "Measurement is not supported on this host" : "No current measurement"}</p>
        <dl className="fy-studio-facts"><dt>{current ? "Available" : "Last measured available"}</dt><dd>{bytes(capacity?.availableBytes)}</dd>
          <dt>Drive capacity</dt><dd>{bytes(capacity?.totalBytes)}</dd>
          {typeof reserve === "number" && <><dt>Working reserve</dt><dd>{bytes(reserve)}</dd></>}
        </dl>
        {current && unavailable > 0 && <p className="fy-studio-note">{unavailable} {unavailable === 1 ? "destination has" : "destinations have"} stale or unavailable readings on this drive.</p>}
        {!current && capacity && <p className="fy-studio-note">Current available space is unknown. These earlier figures may have changed.</p>}
        {roots.some(row => row.limitations.includes("quota-unavailable")) && <p className="fy-studio-note">Any separate storage quota is unknown.</p>}
        {warning && <p className="fy-studio-note">{warning.cause.statement.charAt(0).toUpperCase() + warning.cause.statement.slice(1)}. Existing artwork, recordings and exports are kept.</p>}
      </div>;
    })}
    {health?.limited && <p className="fy-studio-note">Some destinations are outside this measurement summary.</p>}
    {groups.length > 0 && <p className="fy-studio-note">These readings alone do not confirm that an export or other operation will fit.</p>}
  </section>;
}

function StudioSpaceCheck({ check, now }: { check: StorageSpaceCheck; now: number }) {
  return <div className="fy-studio-fact-card">
    <div className="fy-studio-fact-head"><TriangleAlert size={16} />{purposes[check.purpose]} space check</div>
    <p className="fy-studio-meta">Checked {new Date(check.checkedAt).toLocaleString()}</p>
    {check.volumes.map(volume => <div key={volume.volumeId}>
      <div className="fy-studio-meta">{volume.roles.map(role => labels[role]).join(" · ")}</div>
      {volume.measuredAt <= now ? <dl className="fy-studio-facts">
        <dt>Available at check</dt><dd>{bytes(volume.availableBytes)}</dd>
        <dt>Already committed</dt><dd>{bytes(volume.reservedBytes)}</dd>
        <dt>{check.purpose === "submission" ? "Minimum preparation space" : "Estimated remaining writes"}</dt><dd>{bytes(volume.peakBytes)}</dd>
        <dt>Working reserve</dt><dd>{bytes(volume.reserveBytes)}</dd>
        <dt>Additional space needed</dt><dd>{bytes(volume.deficitBytes)}</dd>
      </dl> : <p className="fy-studio-note">The measurement time cannot be verified. Refresh Diagnostics.</p>}
      {volume.status === "held" && volume.deficitBytes === 0 && <p className="fy-studio-note">There was no headroom above the working reserve.</p>}
    </div>)}
    <p className="fy-studio-note">This attempt could not fit. Figures describe that check; check the operation for its current status. Existing artwork, recordings and exports are kept.</p>
    {check.purpose === "submission" && <p className="fy-studio-note">This checks preparation space only. Generated media may need more space.</p>}
    <p className="fy-studio-note">Free space on the affected drive, then retry through the operation’s own controls. Current remedies are below.</p>
  </div>;
}
