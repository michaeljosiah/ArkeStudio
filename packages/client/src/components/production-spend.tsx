import { useEffect, useId, useState } from "react";
import { Link } from "react-router";
import { formatMicroUsd, orderedShots, productionShape, type ProductionBundle, type ProductionSpendSummary,
  type ProductionSpendReceipt, type ProductionSpendRollup } from "@arke-studio/contracts";
import { refreshProductionSpend, useStore } from "../lib/store.js";
import { PageSheet } from "./page-sheet.js";
import { Button } from "./ui.js";

type Scope = { kind: "production" } | { kind: "scene" | "shot"; id: string };
const isAllowance = (source: string) => ["included-plan", "free-plan", "free-credit"].includes(source);
const sourceLabels: Record<ProductionSpendReceipt["source"], string> = {
  "provider-reported": "Provider-reported", "usage-derived": "Usage-derived", "mixed-measured": "Mixed measured",
  "manifest-derived": "Manifest-derived", "estimated": "Estimated", "unknown-actual": "Unknown source",
  "local-zero": "Unmetered", "included-plan": "ChatGPT plan", "free-plan": "Free plan", "free-credit": "Free credit", "unavailable": "Unavailable",
};
const outcomeLabels = { succeeded: "Made", failed: "Failed", cancelled: "Cancelled", pending: "Pending", unknown: "Unknown" };
function spendLabel(value?: ProductionSpendSummary): string {
  if (value?.spentMicroUsd == null) return "—";
  if (value.sources.length && value.sources.every(source => source.source === "local-zero" || isAllowance(source.source))) {
    return value.sources.every(source => source.source === "local-zero") ? "Unmetered"
      : value.sources.every(source => isAllowance(source.source)) ? "Plan-covered" : "Local / plan";
  }
  return formatMicroUsd(value.spentMicroUsd);
}
export function SpendSummary({ value, onDetails, refreshing = false }: { value?: ProductionSpendSummary; onDetails?: () => void; refreshing?: boolean }) {
  const label = !value ? "Reading history" : value.coverage === "unavailable"
    ? value.problems.includes("ledger-unreadable") || value.problems.includes("history-unreadable") ? "Could not read spend history" : "Historical spend unavailable"
    : value.coverage === "partial" ? "Known spend on this device" : value.coverage === "empty" ? "No work yet" : "On this device";
  const plans = value?.sources.filter(source => isAllowance(source.source)).reduce((sum, source) => sum + source.entries, 0) ?? 0;
  return <div className="fy-spend-summary" aria-label="Lifetime production work" aria-busy={!value || refreshing}>
    <div><span className="fy-spend-label">Lifetime spend{value?.coverage === "partial" ? " · partial" : ""}</span>
      <strong className="fy-spend-amount">{spendLabel(value)}</strong>
      <span className="fy-spend-meta">{refreshing ? "Reading history…" : label}</span></div>
    <div className="fy-spend-counts"><span className="fy-spend-label">Video candidates{value?.countsPartial ? " · counts partial" : ""}</span>
      <span>{value ? `${value.generated} generated · ${value.selected} selected` : "— generated · — selected"}</span>
      <span className="fy-spend-meta">{value?.localRuns ? `${value.localRuns} local run${value.localRuns === 1 ? "" : "s"}` : "Selected = shots with a current video take"}{plans ? ` · ${plans} plan attempt${plans === 1 ? "" : "s"}` : ""}</span></div>
    {onDetails && <Button variant="outline" onClick={onDetails}>Spend details →</Button>}
  </div>;
}

function scopeValue(rollup: ProductionSpendRollup | undefined, scope: Scope) {
  return scope.kind === "production" ? rollup?.total : scope.kind === "scene" ? rollup?.scenes[scope.id] : rollup?.shots[scope.id];
}
function Receipt({ row, scope, shotName }: { row: ProductionSpendReceipt; scope: Scope; shotName: (id: string) => string }) {
  const share = scope.kind === "shot" ? row.shots.find(shot => shot.shotId === scope.id)?.microUsd : row.microUsd;
  const amount = isAllowance(row.source) ? "Plan" : row.source === "local-zero" ? "Local" : share == null ? "Unavailable" : formatMicroUsd(share);
  const label = row.shots.length > 1 ? `Board · ${row.shots.map(shot => shotName(shot.shotId)).join(", ")}`
    : row.shots.length ? `${shotName(row.shots[0]!.shotId)} · ${row.kind === "frame" ? "frame" : "video"}` : "Unassigned production work";
  return <article className="fy-spend-receipt">
    <div className="fy-spend-work">{label}<span className="fy-spend-meta">{row.model}</span></div>
    <span className="fy-spend-outcome">{outcomeLabels[row.outcome]}</span><span className="fy-spend-source">{sourceLabels[row.source]}</span><span className="fy-spend-price">{amount}</span>
    <details><summary>Receipt and allocation</summary><div className="fy-spend-evidence">
      <p>{row.provider} · {row.model}</p><p className="fy-spend-job">Job {row.jobId}</p>
      {row.source === "estimated" && <p>Estimate used; no actual amount was recorded.</p>}
      {row.source === "unknown-actual" && <p>The amount is recorded; its historical source is unknown.</p>}
      {isAllowance(row.source) ? <p>Account allowance work is separate from billed spend. Allowance consumed is unknown.{row.source === "free-credit" && row.recordedMicroUsd !== null ? ` Recorded credit estimate: ${formatMicroUsd(row.recordedMicroUsd)}.` : ""}</p>
        : row.source === "local-zero" ? <p>One local run. No metered API charge.</p>
          : <p>{scope.kind === "shot" ? "Full job amount" : "Job amount"}: {row.microUsd === null ? "Unavailable" : formatMicroUsd(row.microUsd)}</p>}
      {row.shots.map(shot => <p key={shot.shotId}>{shotName(shot.shotId)}{row.shots.length > 1 ? ` · ${shot.durationSec}s` : ""}{!isAllowance(row.source) && row.source !== "local-zero" ? ` · ${shot.microUsd === null ? "Allocation unavailable" : formatMicroUsd(shot.microUsd)}` : ""}</p>)}
      {row.unallocatedMicroUsd > 0 && <p>{formatMicroUsd(row.unallocatedMicroUsd)} is unassigned and already included in the parent total.</p>}
      {row.outcome === "failed" || row.outcome === "cancelled" ? <p>No video candidate is inferred from this attempt. A terminal attempt can still incur a charge.</p> : null}
      {row.kind === "frame" && <p>A still frame contributes spend, not a video candidate.</p>}
    </div></details>
  </article>;
}

export function ProductionSpend({ production, sceneId, shotId, compact = false, scenesOnly = false }: { production: ProductionBundle; sceneId?: string; shotId?: string; compact?: boolean; scenesOnly?: boolean }) {
  const { state, connection } = useStore();
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Scope>({ kind: "production" });
  const [refreshing, setRefreshing] = useState(false);
  const selectId = useId();
  const worldId = state?.world?.meta.worldId;
  const rollup = state?.productionSpend?.worldId === worldId ? state?.productionSpend?.productions[production.meta.id] : undefined;
  useEffect(() => setRefreshing(false), [rollup]);
  useEffect(() => { setOpen(false); setRefreshing(false); }, [worldId, production.meta.id]);
  useEffect(() => { if (connection !== "open") setRefreshing(false); }, [connection]);
  const initial: Scope = shotId ? { kind: "shot", id: shotId } : sceneId ? { kind: "scene", id: sceneId } : { kind: "production" };
  const current = scopeValue(rollup, initial);
  const detail = scopeValue(rollup, scope);
  const shape = productionShape(production.meta);
  if (!shape.hasScenes || shape.dispatchCapability !== "video") return null;
  const show = () => { setScope(initial); setOpen(true); };
  const refresh = () => { if (worldId) { setRefreshing(true); refreshProductionSpend(worldId); } };
  const shots = production.scenes.flatMap(scene => orderedShots(scene));
  const shotName = (id: string) => { const shot = shots.find(shot => shot.id === id); return shot ? `Shot ${shot.number}` : "Removed shot"; };
  const title = scope.kind === "production" ? production.meta.title : scope.kind === "scene" ? `Scene ${production.scenes.find(scene => scene.id === scope.id)?.number ?? ""}` : shotName(scope.id);
  const rows = rollup?.receipts.filter(row => scope.kind === "production" || (scope.kind === "scene" ? row.sceneId === scope.id : row.shots.some(shot => shot.shotId === scope.id))) ?? [];
  return <>
    {scenesOnly ? <section className="fy-spend-scenes" aria-label="Scene spend"><h2>Scenes</h2>
      <table><thead><tr><th>Scene</th><th>Lifetime spend</th><th>Generated · selected</th></tr></thead><tbody>
        {production.scenes.map(scene => { const value = rollup?.scenes[scene.id]; return <tr key={scene.id}>
          <td><Link to={`/w/${worldId}/p/${production.meta.id}/scenes/${scene.id}`}>{scene.number} · {scene.title}</Link><span className="fy-spend-meta">{orderedShots(scene).length} shots</span></td>
          <td><button type="button" className="fy-spend-inline" aria-label={`Spend details for scene ${scene.number}`} onClick={() => { setScope({ kind: "scene", id: scene.id }); setOpen(true); }}>{spendLabel(value)}{value?.coverage === "partial" ? " · partial" : ""}</button></td>
          <td>{value ? `${value.generated} generated · ${value.selected} selected${value.countsPartial ? " · counts partial" : ""}` : "Reading history…"}</td>
        </tr>; })}
      </tbody></table>
    </section> : compact ? <button type="button" className="fy-spend-inline" onClick={event => { event.stopPropagation(); show(); }}>
      <span>{current?.spentMicroUsd == null ? "Spend unavailable" : `${spendLabel(current)} lifetime`}</span>
      <span className="fy-spend-meta">{current ? `${current.generated} generated · ${current.selected} selected${current.countsPartial ? " · counts partial" : ""}` : "Reading history…"}{current?.coverage === "partial" ? " · spend partial" : ""}</span>
    </button> : <SpendSummary value={current} onDetails={show} />}
    <PageSheet open={open} onClose={() => setOpen(false)} title={`Spend · ${title}`} className="fy-production-spend"
      footer={<><span>Lifetime · this device</span><Button variant="outline" onClick={() => setOpen(false)}>Done</Button></>}>
      <div className="fy-spend-scope"><label htmlFor={selectId}>Show</label><select id={selectId}
        value={scope.kind === "production" ? "production" : `${scope.kind}:${scope.id}`}
        onChange={event => { const value = event.target.value; setScope(value === "production" ? { kind: "production" } : { kind: value.startsWith("scene:") ? "scene" : "shot", id: value.slice(value.indexOf(":") + 1) }); }}>
        <option value="production">Production · {production.meta.title}</option>
        {production.scenes.map(scene => <option key={scene.id} value={`scene:${scene.id}`}>Scene {scene.number} · {scene.title}</option>)}
        {shots.map(shot => <option key={shot.id} value={`shot:${shot.id}`}>Shot {shot.number} · {shot.title}</option>)}
      </select>{detail && <span className="fy-spend-meta">{detail.coverage === "complete" ? "Complete" : detail.coverage}</span>}</div>
      <SpendSummary value={detail} refreshing={refreshing} />
      {detail?.coverage === "partial" || detail?.coverage === "unavailable" || detail?.countsPartial ? <div className="fy-spend-callout" role="status">
        <strong>{detail.coverage === "unavailable" ? detail.problems.includes("ledger-unreadable") || detail.problems.includes("history-unreadable") ? "Spend history could not be read" : "Historical spend unavailable" : "Some history is incomplete"}</strong>
        <p>{detail.coverage === "partial" ? "This is known spend on this device. Earlier work or attribution may be missing." : detail.coverage === "unavailable" ? "An unavailable amount is not a zero-dollar total." : "Candidate counts may be incomplete."}</p>
        {detail.unallocatedMicroUsd > 0 && <p>{formatMicroUsd(detail.unallocatedMicroUsd)} cannot be assigned to a current shot. This amount is already in the total.</p>}
        {detail.countsPartial && <p>Counts partial · some original candidate records could not be read or matched.</p>}
        <Button variant="outline" disabled={connection !== "open" || refreshing} onClick={refresh}>{refreshing ? "Reading history…" : "Read history again"}</Button>
      </div> : null}
      {detail && <div className="fy-spend-sources">{detail.sources.map(source => <span key={source.source}>{source.source === "local-zero" ? `${source.entries} local run${source.entries === 1 ? "" : "s"}`
        : isAllowance(source.source) ? `${source.entries} ${sourceLabels[source.source]} attempt${source.entries === 1 ? "" : "s"} · allowance used unknown`
          : `${formatMicroUsd(source.microUsd)} ${sourceLabels[source.source].toLowerCase()}`}</span>)}</div>}
      {detail?.coverage === "empty" ? <div className="fy-spend-empty"><h3>No generation work yet</h3><p>Shot frames and video attempts will appear here as you make them.</p></div>
        : rows.length > 0 ? <section aria-label="Contributing work"><div className="fy-spend-columns" aria-hidden="true"><span>Work</span><span>Outcome</span><span>Cost source</span><span>{scope.kind === "shot" ? "Shot share" : "Billed spend"}</span></div>
          {rows.map(row => <Receipt key={row.jobId} row={row} scope={scope} shotName={shotName} />)}</section> : null}
      <p className="fy-spend-note">Spend includes frames and video attempts. Generated counts video candidates; selected counts shots with a current video take. Board charges appear once and are shared by duration.</p>
    </PageSheet>
  </>;
}
