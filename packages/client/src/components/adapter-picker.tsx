import { adapterCompatibilityProblem, adapterPolicyProblem, type AdapterSelection } from "@arke-studio/contracts";
import { Link } from "react-router";
import { useStore } from "../lib/store.js";

export function AdapterPicker({ recipeId, selected, onChange }: {
  recipeId: string; selected: AdapterSelection[]; onChange(rows: AdapterSelection[]): void;
}) {
  const { state } = useStore(), library = state?.app.adapters;
  if (!library?.adultContent.enabled) return selected.length ? <span>Adult adapter unavailable · <button type="button" onClick={() => onChange([])}>Clear selection</button></span> : null;
  const rows = library.entries.filter(row => row.release.compatibility.some(pair => pair.recipeId === recipeId));
  const value = selected[0]?.releaseId ?? "";
  return <label>Adapter <select aria-label="H3 adapter" value={value} onChange={event => {
    const row = rows.find(item => item.release.id === event.target.value);
    const pair = row?.release.compatibility.find(item => item.recipeId === recipeId);
    onChange(row ? [{ releaseId: row.release.id, sha256: row.release.source.sha256,
      strength: Math.min(pair?.maxStrength ?? 1, Math.max(pair?.minStrength ?? 0, 1)) }] : []);
  }}>
    <option value="">None</option>
    {value && !rows.some(row => row.release.id === value) && <option value={value} disabled>Saved adapter unavailable</option>}
    {rows.map(row => {
      const pair = row.release.compatibility.find(item => item.recipeId === recipeId)!;
      const problem = row.reason ?? adapterPolicyProblem(row.release, library.adultContent, row.decision, row.removed, new Date().toISOString()) ??
        (!row.installed ? "Not installed" : adapterCompatibilityProblem(row.release, recipeId, pair.minStrength ?? 0));
      return <option key={row.release.id} value={row.release.id} disabled={!!problem}>{row.release.displayName}{problem ? ` · ${problem}` : ""}</option>;
    })}
  </select> <Link to="/settings/adapters">Manage adapters</Link>
  {selected[0] && <span> Strength <input aria-label="Adapter strength" type="number" min="0" max="2" step="0.05" value={selected[0].strength}
    onChange={event => { const strength = Number(event.target.value); if (Number.isFinite(strength)) onChange([{ ...selected[0]!, strength }]); }} /></span>}
  </label>;
}
