import { useEffect, useState } from "react";
import { deriveStorageFindings, systemStorageGroups, type StorageHealthSnapshot, type StorageRootHealth } from "@arke-studio/contracts";
import { TriangleAlert } from "./icons.js";

const labels: Record<StorageRootHealth["role"], string> = { "local-ai": "Local models", "generated-media": "World media", "working-files": "Working files", downloads: "Downloads", exports: "Exports" };
const bytes = (value: number | null | undefined) => value === null || value === undefined ? "Unknown"
  : value < 1024 ? `${value} bytes` : value < 1024 ** 2 ? `${Number((value / 1024).toFixed(1))} KiB`
    : value < 1024 ** 3 ? `${Number((value / 1024 ** 2).toFixed(1))} MiB` : `${Number((value / 1024 ** 3).toFixed(1))} GiB`;

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
  const warnings = connected ? deriveStorageFindings(health, new Date(now).toISOString()).filter(finding => finding.kind === "storage-pressure") : [];
  return <section aria-label="Latest storage readings">
    {!connected && <p className="fy-studio-note">Connection lost. These are the host’s last reported readings.</p>}
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
