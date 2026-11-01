import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { deriveStorageFindings, findingRef, PROVIDERS, resourceFresh, systemStorageGroups, type ClientState, type ResourceMeasurement, type StorageRootHealth } from "@arke-studio/contracts";
import { refreshDiagnostics, refreshSystemResources, useStore } from "../lib/store.js";
import { closeSystemPanel, useSystemPanel } from "../lib/system-panel.js";
import { useActivityPanel } from "../lib/activity-panel.js";
import { useMediaQuery } from "../lib/media-query.js";
import { isRemoteSession } from "../lib/remote-session.js";
import { PageSheet } from "./page-sheet.js";
import { Button, IconButton } from "./ui.js";
import { Cpu, TriangleAlert, X } from "./icons.js";

const quantity = (value: number) => Number(value.toFixed(1)).toString();
const bytes = (value: number) => value >= 1024 ** 4 ? `${quantity(value / 1024 ** 4)} TiB` : `${quantity(value / 1024 ** 3)} GiB`;
const memoryRange = (used: number, total: number) => `${quantity(used / 1024 ** 3)} / ${quantity(total / 1024 ** 3)} GiB`;
const percent = (value: number) => `${Math.round(value)}%`;
const age = (at: number | null | undefined, now: number): string => at === null || at === undefined ? "Not measured" : at > now ? "Time unavailable" :
  now - at < 1000 ? "just now" : now - at < 60_000 ? `${Math.floor((now - at) / 1000)} s ago` : now - at < 3600_000 ? `${Math.floor((now - at) / 60_000)} min ago` : `${Math.floor((now - at) / 3600_000)} h ago`;
const labels: Record<StorageRootHealth["role"], string> = { "local-ai": "Local models", "generated-media": "World media", "working-files": "Working files", downloads: "Downloads", exports: "Exports" };
function refreshSystemOverview() { refreshDiagnostics(); refreshSystemResources(); }
export const systemStorageWarnings = (app: ClientState["app"], now: number) => deriveStorageFindings(app.storageHealth, new Date(now).toISOString()).filter(finding => finding.kind === "storage-pressure");

function SectionTitle({ title, detail }: { title: string; detail: string }) {
  return <div className="fy-system-section-title"><h3>{title}</h3><span>{detail}</span></div>;
}
function Meter({ value, warning = false }: { value: number | null; warning?: boolean }) {
  return value === null ? null : <div className={`fy-system-meter${warning ? " fy-system-meter--warning" : ""}`} aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>;
}
function Metric({ label, value, detail, sample, now, connected, utilisation }: { label: string; value: string | null; detail: string; sample: ResourceMeasurement | undefined; now: number; connected: boolean; utilisation: number | null }) {
  const fresh = connected && resourceFresh(sample, now);
  return <div className={`fy-system-metric${fresh ? "" : " fy-system-metric--unknown"}`}><div className="fy-system-metric-label">{label}</div><div className="fy-system-value">{value === null ? "Unavailable" : `${fresh ? "" : "Last: "}${value}`}</div><div className="fy-system-detail">{value !== null && !fresh ? `Stale · ${age(sample?.measuredAt, now)}` : value === null ? sample?.state === "unsupported" ? "No supported reading" : "No current reading" : detail}</div><Meter value={fresh ? utilisation : null} /></div>;
}
function Service({ label, value, detail, tone = "" }: { label: string; value: string; detail: string; tone?: string }) {
  return <div className="fy-system-service"><div><span className={`fy-system-dot ${tone}`} aria-hidden="true" /><b>{label}</b></div><span>{value}<small>{detail}</small></span></div>;
}

/** Turn 240. Pure rendering: every value comes from the authenticated host snapshot. */
export function SystemStatusView({ app, now, connected, remote = false, refresh, diagnostics, close }: {
  app: ClientState["app"]; now: number; connected: boolean; remote?: boolean;
  refresh: () => void; diagnostics: (finding?: string) => void; close: () => void;
}) {
  const resources = app.systemResources, cpu = resources?.cpu, memory = resources?.memory, gpu = resources?.gpu;
  const gpuValue = gpu?.value?.[0], warnings = connected ? systemStorageWarnings(app, now) : [];
  const measured = connected && resourceFresh(cpu, now) && resourceFresh(memory, now);
  const groups = systemStorageGroups(app.storageHealth?.roots ?? [], now);
  const cloud = app.providers.filter(provider => provider.configured && !PROVIDERS[provider.id].local);
  const localState = (value: string | undefined) => !connected ? "Unknown" : value === "ready" || value === "healthy" ? "Ready" : value === "starting" ? "Starting" : value === "unreachable" ? "Unreachable" : value === "incompatible" ? "Incompatible" : value === "failed" || value === "unhealthy" ? "Needs attention" : value === "absent" ? "Not installed" : value === "stopped" || value === "unconfigured" ? "Not running" : "Unknown";
  return <div className="fy-system-panel">
    <header className="fy-system-head"><div><h2 tabIndex={-1}>System</h2><p>{remote ? "Connected desktop" : "This desktop"}</p></div><IconButton className="fy-system-icon" label="Close System" onClick={close}><X size={16} /></IconButton></header>
    <div className="fy-system-scroll">
      {!connected || !measured ? <div className="fy-system-notice fy-system-notice--quiet"><div><Cpu size={16} /><b>Current readings unavailable</b></div><p>{!connected ? "Connection lost. These are the desktop’s last reported readings; Refresh is unavailable until it reconnects." : "Some readings are missing or stale. Arke cannot confirm their current use. Refresh to check again."}</p></div> : null}
      {warnings.map(finding => <div className="fy-system-notice" key={finding.occurrence}><div><TriangleAlert size={16} /><b>{finding.title}</b></div><p>{finding.cause.statement}. {finding.note}</p><Button variant="outline" size="sm" className="fy-system-button" onClick={() => diagnostics(findingRef(finding))}>Review in Diagnostics</Button></div>)}
      <SectionTitle title="Performance" detail={resources ? `${measured ? "Sampled" : "Last CPU sample"} ${age(cpu?.measuredAt, now)}` : "Not measured"} />
      <div className="fy-system-metrics">
        <Metric label="CPU" value={cpu?.value === null || cpu?.value === undefined ? null : percent(cpu.value)} detail="Overall utilisation" sample={cpu} now={now} connected={connected} utilisation={cpu?.value ?? null} />
        <Metric label="Memory" value={memory?.value ? memoryRange(memory.value.usedBytes, memory.value.totalBytes) : null} detail={memory?.value ? `${percent(memory.value.usedBytes / memory.value.totalBytes * 100)} in use` : "No current reading"} sample={memory} now={now} connected={connected} utilisation={memory?.value ? memory.value.usedBytes / memory.value.totalBytes * 100 : null} />
        <Metric label={gpu?.value && gpu.value.length > 1 ? `GPU 1 of ${gpu.value.length}` : "GPU"} value={gpuValue?.utilisation === null || gpuValue?.utilisation === undefined ? null : percent(gpuValue.utilisation)} detail="Overall utilisation" sample={gpu} now={now} connected={connected} utilisation={gpuValue?.utilisation ?? null} />
        <Metric label="GPU memory" value={gpuValue?.usedBytes !== null && gpuValue?.usedBytes !== undefined && gpuValue.totalBytes ? memoryRange(gpuValue.usedBytes, gpuValue.totalBytes) : null} detail={gpuValue?.usedBytes !== null && gpuValue?.usedBytes !== undefined && gpuValue.totalBytes ? `${percent(gpuValue.usedBytes / gpuValue.totalBytes * 100)} in use` : "No current reading"} sample={gpu} now={now} connected={connected} utilisation={gpuValue?.usedBytes !== null && gpuValue?.usedBytes !== undefined && gpuValue.totalBytes ? gpuValue.usedBytes / gpuValue.totalBytes * 100 : null} />
      </div>
      {gpu?.value && <p className="fy-system-note">GPU counters · {age(gpu.measuredAt, now)}{gpu.value.length > 1 ? ". Showing the first reported GPU; memory is not combined across devices." : ""}</p>}
      <SectionTitle title="Storage" detail={app.storageHealth ? `Last observation ${age(app.storageHealth.at, now)}` : "Not measured"} />
      <div className="fy-system-storage">{groups.length === 0 ? <p className="fy-system-note">Unavailable · no registered destination readings.</p> : groups.map(({ key, roots, root, fresh: current, unavailable }) => {
        const capacity = root.capacity, fresh = connected && current;
        const available = capacity?.availableBytes, total = capacity?.totalBytes;
        const warning = fresh && warnings.some(finding => finding.occurrence === capacity?.volumeId);
        return <div className="fy-system-drive" key={key}><div className="fy-system-row"><b>{[...new Set(roots.map(row => labels[row.role]))].join(" · ")}</b><span className={warning ? "fy-system-warning-text" : undefined}>{available === null || available === undefined ? "Unavailable" : `${fresh ? "" : "Last: "}${bytes(available)} free`}</span></div><div className="fy-system-row fy-system-detail"><span>{fresh && capacity ? `Checked ${age(capacity.measuredAt, now)}${unavailable ? ` · ${unavailable} destination${unavailable === 1 ? "" : "s"} stale or unavailable` : ""}` : capacity ? `Stale · ${age(capacity.measuredAt, now)}` : root.state === "unsupported" ? "Unsupported on this host" : "No current reading"}{roots.some(row => row.limitations.includes("quota-unavailable")) ? " · Quota limit unknown" : ""}</span><span>{total ? `of ${bytes(total)}` : "Total unavailable"}</span></div><Meter value={fresh && total && available !== null && available !== undefined ? (total - available) / total * 100 : null} warning={!!warning} /></div>;
      })}</div>
      <SectionTitle title="Local AI" detail="Last reported status" />
      <div className="fy-system-services">
        <Service label="Ollama" value={localState(app.ollama?.state)} detail="Check time unavailable" />
        <Service label={app.comfyui?.engine.locality === "remote" ? "ComfyUI (remote)" : "ComfyUI"} value={localState(app.comfyui?.engine.state)} detail={app.comfyui ? `Last check ${age(Date.parse(app.comfyui.checkedAt), now)}` : "Not checked"} />
        <Service label="Ming" value={connected && resourceFresh(resources?.ming, now) ? resources!.ming.value ? "Running" : "Not running" : "Unknown"} detail={resources?.ming.measuredAt ? `Owner observed ${age(resources.ming.measuredAt, now)}` : "No owner observation"} />
        {app.voiceRuntime && <Service label="Voxa" value={localState(app.voiceRuntime.processState)} detail="Check time unavailable" />}
      </div>
      <SectionTitle title="Cloud" detail="Configured providers" />
      <div className="fy-system-services">{cloud.length === 0 ? <Service label="Provider connections" value="None configured" detail="Configure in Settings" /> : cloud.map(provider => <Service key={provider.id} label={PROVIDERS[provider.id].displayName} value={!connected ? "Unknown" : provider.validation === "invalid" || provider.faultKind === "credential" ? "Needs attention" : provider.validation === "valid" ? "Last check passed" : provider.validation === "testing" ? "Checking" : "Not checked"} detail={provider.lastValidated ? `Checked ${age(Date.parse(provider.lastValidated), now)}` : "Check in Diagnostics"} />)}</div>

    </div>
    <footer className="fy-system-foot"><div><Button className="fy-system-button" variant="outline" size="sm" disabled={!connected} onClick={refresh}>Refresh</Button><Button className="fy-system-button" variant="primary" size="sm" onClick={() => diagnostics()}>Diagnostics</Button></div></footer>
  </div>;
}

export function SystemPanel() {
  const open = useSystemPanel(), { state, connection } = useStore(), activity = useActivityPanel();
  const location = useLocation(), navigate = useNavigate(), compact = useMediaQuery("(max-width: 1099px)");
  const [, tick] = useState(0), root = useRef<HTMLDivElement>(null), path = location.pathname + location.search;
  // The tick invalidates ages; a newly received sample must be compared with the current
  // local wall clock, never the preceding tick or a clamped host measurement time.
  const now = Date.now();
  useLayoutEffect(() => { if (open) { const body = root.current?.querySelector('.fy-system-scroll'); if (body) body.scrollTop = 0; } }, [open]);
  useEffect(() => { closeSystemPanel(); }, [path]);
  useEffect(() => { if (activity.open) closeSystemPanel(); }, [activity.open]);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => tick(value => value + 1), 1_000);
    const visible = () => connection === "open" && !document.hidden && root.current?.closest('dialog')?.hasAttribute('open');
    const refresh = () => { if (visible()) refreshSystemResources(); };
    if (visible()) refreshSystemOverview(); const sample = setInterval(refresh, 5_000);
    const wake = () => { tick(value => value + 1); refresh(); }; document.addEventListener("visibilitychange", wake);
    return () => { clearInterval(timer); clearInterval(sample); document.removeEventListener("visibilitychange", wake); };
  }, [open, connection]);
  useEffect(() => {
    if (!open || compact) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && root.current?.closest("dialog")?.open) { event.preventDefault(); event.stopImmediatePropagation(); closeSystemPanel(); }
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [open, compact]);
  if (!state) return null;
  return <PageSheet open={open} onClose={closeSystemPanel} title="System" headless modeless={!compact} className="fy-system-host">
    <div ref={root} className="fy-system-root"><SystemStatusView app={state.app} now={now} connected={connection === "open"} remote={isRemoteSession()} refresh={refreshSystemOverview} diagnostics={finding => { closeSystemPanel(); navigate(`/settings/diagnostics${finding ? `?finding=${encodeURIComponent(finding)}` : ""}`); }} close={closeSystemPanel} /></div>
  </PageSheet>;
}
