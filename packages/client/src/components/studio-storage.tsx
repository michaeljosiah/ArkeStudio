import { Fragment, useEffect, useState } from "react";
import { componentIsSettled, deriveStorageFindings, STORAGE_CATEGORY_LABELS, storageByteLabel as bytes, storageWaitingWork, systemStorageGroups, type JobSummary, type SetupStatus, type StorageHealthSnapshot, type StorageRootHealth, type StorageSpaceCheck } from "@arke-studio/contracts";
import { Link } from "react-router";
import { TriangleAlert } from "./icons.js";
import { openActivityPanel } from "../lib/activity-panel.js";

const labels: Record<StorageRootHealth["role"], string> = { "local-ai": "Local models", "generated-media": "World media", "working-files": "Working files", downloads: "Downloads", exports: "Exports" };
const purposes: Record<StorageSpaceCheck["purpose"], string> = { setup: "Installation", job: "Generation", import: "Import", export: "Export", publication: "Publication", scratch: "Local processing", preview: "Preview", submission: "Generation preparation" };

/** Live host readings stay separate from the saved diagnosis and never grant write/repair authority. */
interface StudioStorageProps { health?: StorageHealthSnapshot | null; connected: boolean; jobs?: readonly JobSummary[]; setup?: SetupStatus | null; close?: () => void }

export function StudioStorageReadings({ health, connected, jobs, setup, close }: StudioStorageProps) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick(value => value + 1), 1_000);
    const wake = () => tick(value => value + 1);
    document.addEventListener("visibilitychange", wake);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", wake); };
  }, []);
  return <StudioStorageReadingsView health={health} connected={connected} jobs={jobs} setup={setup} close={close} now={Date.now()} />;
}

export function StudioStorageReadingsView({ health, connected, now, jobs = [], setup, close }: StudioStorageProps & { now: number }) {
  const groups = systemStorageGroups(health?.roots ?? [], now);
  const waiting = storageWaitingWork(jobs, setup, now);
  const checks = (health?.spaceChecks ?? []).filter(check => check.checkedAt <= now && now - check.checkedAt <= 15 * 60_000);
  const warnings = connected ? deriveStorageFindings(health ? { ...health, spaceChecks: [] } : health, new Date(now).toISOString()).filter(finding => finding.kind === "storage-pressure") : [];
  return <section aria-label="Latest storage readings">
    {!connected && <p className="fy-studio-note">Connection lost. These are the host’s last reported readings.</p>}
    {waiting.total > 0 && <div className="fy-studio-fact-card">
      <div className="fy-studio-fact-head"><TriangleAlert size={16} />{connected ? "Work awaiting storage" : "Last reported storage waits"}</div>
      <dl className="fy-studio-facts">
        {waiting.unsubmitted > 0 && <><dt>Waiting to submit</dt><dd>{waiting.unsubmitted} {waiting.unsubmitted === 1 ? "job" : "jobs"}</dd></>}
        {waiting.completed > 0 && <><dt>Completed results awaiting saving</dt><dd>{waiting.completed}</dd></>}
        {waiting.downloads > 0 && <><dt>Downloads awaiting space</dt><dd>{waiting.downloads}</dd></>}
      </dl>
      {waiting.unverified > 0 && <p className="fy-studio-note">{waiting.unverified} {waiting.unverified === 1 ? "job needs" : "jobs need"} storage verification. Available space or the destination could not be confirmed.</p>}
      {waiting.completed > 0 && <p className="fy-studio-note">Completed generation is waiting for local saving. Arke has not repeated it.</p>}
      <p className="fy-studio-note">{connected ? "The operation’s own controls show its next step and any pause." : "Current work status is unknown until the connection returns."}</p>
      <div className="fy-studio-work-actions">
        {waiting.unsubmitted + waiting.completed > 0 && <button type="button" className="fy-studio-button" onClick={() => { close?.(); openActivityPanel("inbox"); }}>Open Activity</button>}
        {waiting.downloads > 0 && <Link className="fy-studio-button" to="/settings/downloads" onClick={close}>Open Downloads</Link>}
      </div>
    </div>}
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
    {health?.inventory && <details className="fy-studio-fact-card">
      <summary>Files in Arke folders{health.inventory.scanning && connected ? " · measuring" : ""}</summary>
      <p className="fy-studio-note">Size estimates for Arke’s managed folders and the open world. Other locations and closed worlds are not included.</p>
      <dl className="fy-studio-facts">{health.inventory.categories.map(row => {
        const fresh = connected && row.measuredAt !== null && row.measuredAt <= now && now - row.measuredAt <= 5 * 60_000;
        return <Fragment key={row.category}><dt>{STORAGE_CATEGORY_LABELS[row.category]}</dt><dd>
          {row.measuredAt !== null && row.measuredAt > now ? "Unknown" : bytes(row.logicalBytes)}
          {row.logicalBytes !== null && row.measuredAt !== null && row.measuredAt <= now && <>{row.state === "partial" ? " · partial" : ""}{!fresh ? " · last measured" : ""}</>}
        </dd></Fragment>;
      })}</dl>
      <p className="fy-studio-note">File sizes do not explain all used drive space. Shared files may be counted more than once. Recoverable space is unknown. Removing an artifact from the shelf keeps its files.</p>
    </details>}
    {connected && setup?.components.some(row => row.removable && row.provides?.length && componentIsSettled(row.state)) &&
      <Link className="fy-studio-button" to="/settings/models?half=local" onClick={close}>Review installed models</Link>}
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
