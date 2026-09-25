import { adapterCompatibilityProblem, adapterPolicyProblem, matchingAdapterBundle, type AdapterSelection } from "@arke-studio/contracts";
import { Link } from "react-router";
import { useStore } from "../lib/store.js";

export function AdapterPicker({ recipeId, selected, onChange }: {
  recipeId: string; selected: AdapterSelection[]; onChange(rows: AdapterSelection[]): void;
}) {
  const { state } = useStore(), library = state?.app.adapters;
  if (!library?.adultContent.enabled) return selected.length ? <span className="fy-adapter-picker">Adult adapter unavailable · <button type="button" onClick={() => onChange([])}>Clear selection</button></span> : null;
  const rows = library.entries.filter(row => row.release.compatibility.some(pair => pair.recipeId === recipeId));
  if (!rows.length && !selected.length) return null;
  const bundles = (library.bundles ?? []).filter(bundle => bundle.recipeId === recipeId);
  const selectedBundle = matchingAdapterBundle(selected, recipeId, bundles);
  const value = selected.length > 1 ? selectedBundle ? `bundle:${selectedBundle.id}` : "saved-bundle" : selected[0]?.releaseId ?? "";
  const selectedRow = rows.find(row => row.release.id === value);
  const selectedPair = selectedRow?.release.compatibility.find(pair => pair.recipeId === recipeId);
  const selectionProblem = (selection: AdapterSelection): string | null => {
    const row = rows.find(item => item.release.id === selection.releaseId && item.release.source.sha256 === selection.sha256);
    if (!row) return "A bundle member is unavailable for this model.";
    const problem = row.reason ?? adapterPolicyProblem(row.release, library.adultContent, row.decision, row.removed, new Date().toISOString()) ??
      (!row.installed ? "Not installed" : adapterCompatibilityProblem(row.release, recipeId, selection.strength));
    return problem ? `${row.release.displayName}: ${problem}` : null;
  };
  return <div className="fy-adapter-picker" role="group" aria-label="Optional adapter">
  <label>Adapter <select aria-label="H3 adapter" value={value} onChange={event => {
    const bundle = bundles.find(item => `bundle:${item.id}` === event.target.value);
    if (bundle) { onChange(bundle.selections.map(row => ({ ...row }))); return; }
    const row = rows.find(item => item.release.id === event.target.value);
    const pair = row?.release.compatibility.find(item => item.recipeId === recipeId);
    onChange(row ? [{ releaseId: row.release.id, sha256: row.release.source.sha256,
      strength: Math.min(pair?.maxStrength ?? 1, Math.max(pair?.minStrength ?? 0, 1)) }] : []);
  }}>
    <option value="">None · use model only</option>
    {value && !selectedBundle && !selectedRow && <option value={value} disabled>Saved adapter unavailable</option>}
    {bundles.map(bundle => {
      const problem = bundle.selections.map(selectionProblem).find(Boolean);
      return <option key={bundle.id} value={`bundle:${bundle.id}`} disabled={!!problem}>{bundle.displayName} · {bundle.selections.length} adapters · Experimental{problem ? ` · ${problem}` : ""}</option>;
    })}
    {rows.map(row => {
      const pair = row.release.compatibility.find(item => item.recipeId === recipeId)!;
      const problem = row.reason ?? adapterPolicyProblem(row.release, library.adultContent, row.decision, row.removed, new Date().toISOString()) ??
        (!row.installed ? "Not installed" : adapterCompatibilityProblem(row.release, recipeId, pair.minStrength ?? 0));
      return <option key={row.release.id} value={row.release.id} disabled={!!problem}>{row.release.displayName}{pair.state === "owner-approved" ? " · Owner approved" : ""}{problem ? ` · ${problem}` : ""}</option>;
    })}
  </select></label>
  {value && !selectedRow && !selectedBundle && <span>This saved adapter is unavailable for the selected model. Choose None to clear it.</span>}
  {selectedBundle && <>
    <span>{selectedBundle.description}</span>
    <details><summary>View {selected.length} adapters and strengths</summary><ol>{selected.map(row => <li key={row.sha256}>
      {rows.find(item => item.release.id === row.releaseId)?.release.displayName ?? "Unavailable adapter"} · Strength {row.strength}
      {selectionProblem(row) && <span> · {selectionProblem(row)}</span>}
    </li>)}</ol></details>
  </>}
  {selectedPair?.state === "owner-approved" && <span>{selectedPair.reason}</span>}
  {selected[0] && selectedPair && <label>Strength <input aria-label="Adapter strength" type="number" min={selectedPair.minStrength ?? 0} max={selectedPair.maxStrength ?? 2} step="0.05" value={selected[0].strength}
    onChange={event => { const strength = Number(event.target.value); if (Number.isFinite(strength)) onChange([{ ...selected[0]!, strength }]); }} /></label>}
  <Link to="/settings/adapters">Manage adapters</Link>
  </div>;
}
