import { useEffect, useRef, useState } from "react";
import { adapterCompatibilityProblem, adapterPolicyProblem, adapterStartingStrength, matchingAdapterBundle, type AdapterSelection } from "@arke-studio/contracts";
import { Link } from "react-router";
import { useStore } from "../lib/store.js";
import { cx } from "./ui.js";

/**
 * The adapter, as one chip in the composer row (design turn 180c), the way Sampling is a chip.
 *
 * It replaced a label, a select whose option text ran past its column, a description sentence, a
 * disclosure and a link — the same choices, now in one popover: None, Bundles (the chosen one
 * opens to its members' strength fields), Adapters (the chosen one opens to its strength), then
 * Manage adapters. Rows carry names only. Status, descriptions and approval reasons stay in
 * Settings; the one thing a row still says is why it cannot be chosen, in one clause, because a
 * choice that is listed but will not take needs its reason where it is refused.
 */
export function AdapterPicker({ recipeId, selected, onChange, initialOpen = false }: {
  recipeId: string; selected: AdapterSelection[]; onChange(rows: AdapterSelection[]): void;
  /** Rendered open, for a server-rendered test of the popover; the screen always starts closed. */
  initialOpen?: boolean;
}) {
  const { state } = useStore(), library = state?.app.adapters;
  const [open, setOpen] = useState(initialOpen);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  // With adult content off nothing is listed; a choice already made stays visible and clearable,
  // because hiding it would leave a take going out with an adapter nobody can see.
  if (!library?.adultContent.enabled) {
    return selected.length
      ? <span className="fy-adapter-off">Adapter unavailable · <button type="button" className="fy-set__link" onClick={() => onChange([])}>Clear selection</button></span>
      : null;
  }
  const rows = library.entries.filter(row => row.release.compatibility.some(pair => pair.recipeId === recipeId));
  if (!rows.length && !selected.length) return null;
  const bundles = (library.bundles ?? []).filter(bundle => bundle.recipeId === recipeId);
  const selectedBundle = matchingAdapterBundle(selected, recipeId, bundles);
  const value = selected.length > 1 ? selectedBundle ? `bundle:${selectedBundle.id}` : "saved-bundle" : selected[0]?.releaseId ?? "";
  const selectedRow = rows.find(row => row.release.id === value);
  const selectedPair = selectedRow?.release.compatibility.find(pair => pair.recipeId === recipeId);
  const unavailable = value !== "" && !selectedRow && !selectedBundle;
  const selectionProblem = (selection: AdapterSelection): string | null => {
    const row = rows.find(item => item.release.id === selection.releaseId && item.release.source.sha256 === selection.sha256);
    if (!row) return "A bundle member is unavailable for this model.";
    const problem = row.reason ?? adapterPolicyProblem(row.release, library.adultContent, row.decision, row.removed) ??
      (!row.installed ? "Not installed" : adapterCompatibilityProblem(row.release, recipeId, selection.strength));
    return problem ? `${row.release.displayName}: ${problem}` : null;
  };
  const rowProblem = (row: (typeof rows)[number]): string | null => {
    const pair = row.release.compatibility.find(item => item.recipeId === recipeId)!;
    return row.reason ?? adapterPolicyProblem(row.release, library.adultContent, row.decision, row.removed) ??
      (!row.installed ? "Not installed" : adapterCompatibilityProblem(row.release, recipeId, pair.minStrength ?? 0));
  };
  const strengthField = (name: string, label: string, pair: { minStrength?: number | undefined; maxStrength?: number | undefined }, strength: number, set: (strength: number) => void) => (
    <input aria-label={label} type="number" min={pair.minStrength ?? 0} max={pair.maxStrength ?? 2} step="0.05" value={strength}
      onChange={event => { const next = Number(event.target.value); if (Number.isFinite(next)) set(next); }} name={name} />
  );
  const chipName = selectedBundle?.displayName ?? selectedRow?.release.displayName ?? (unavailable ? "Adapter unavailable" : "No adapter");
  const chipCount = selectedBundle ? String(selected.length) : selectedRow && selected[0] ? String(selected[0].strength) : null;
  return <span className="fy-samp__chipwrap" ref={root}>
    <button type="button" className={cx("fy-samp__chip", unavailable && "fy-adapter-chip--bad")} data-testid="adapter-chip"
      aria-haspopup="dialog" aria-expanded={open} aria-label={`Adapter: ${chipName}`} onClick={() => setOpen(!open)}>
      {chipName}
      {chipCount !== null && <small>{chipCount}</small>}
    </button>
    {open && <span className="fy-samp__menu fy-adapter-pop" role="dialog" aria-label="Adapter">
      <button type="button" className={cx("fy-samp__item", value === "" && "is-on")} aria-pressed={value === ""}
        onClick={() => { onChange([]); setOpen(false); }}><span>None</span></button>
      {unavailable && <span className="fy-adapter-pop__row is-off"><span>Saved adapter unavailable</span><small>Choose None to clear it</small></span>}
      {bundles.length > 0 && <span className="fy-adapter-pop__group">Bundles</span>}
      {bundles.map(bundle => {
        const problem = bundle.selections.map(selectionProblem).find(Boolean) ?? null;
        const chosen = selectedBundle?.id === bundle.id;
        return <span key={bundle.id} className="fy-adapter-pop__block">
          <button type="button" className={cx("fy-samp__item", chosen && "is-on")} aria-pressed={chosen} disabled={!!problem && !chosen}
            data-value={`bundle:${bundle.id}`} onClick={() => onChange(bundle.selections.map(row => ({ ...row })))}>
            <span>{bundle.displayName}</span><small>{bundle.selections.length}</small>
          </button>
          {problem && <span className="fy-adapter-pop__why">{problem}</span>}
          {chosen && selected.map((row, index) => {
            const release = rows.find(item => item.release.id === row.releaseId)?.release;
            const pair = release?.compatibility.find(item => item.recipeId === recipeId);
            const name = release?.displayName ?? "Unavailable adapter";
            return <span key={row.sha256} className="fy-adapter-pop__member">
              <span>{name}</span>
              {pair ? strengthField(`strength-${row.sha256}`, `Strength for ${name}`, pair, row.strength,
                strength => onChange(selected.map((item, i) => i === index ? { ...item, strength } : { ...item })))
                : <small>{row.strength}</small>}
            </span>;
          })}
        </span>;
      })}
      {rows.length > 0 && <span className="fy-adapter-pop__group">Adapters</span>}
      {rows.map(row => {
        const problem = rowProblem(row);
        const chosen = value === row.release.id;
        return <span key={row.release.id} className="fy-adapter-pop__block">
          <button type="button" className={cx("fy-samp__item", chosen && "is-on")} aria-pressed={chosen} disabled={!!problem && !chosen}
            data-value={row.release.id}
            onClick={() => onChange([{ releaseId: row.release.id, sha256: row.release.source.sha256, strength: adapterStartingStrength(row.release, recipeId) }])}>
            <span>{row.release.displayName}</span>
          </button>
          {problem && <span className="fy-adapter-pop__why">{problem}</span>}
          {chosen && selected[0] && selectedPair && <span className="fy-adapter-pop__member">
            <span>Strength</span>
            {strengthField("strength", "Adapter strength", selectedPair, selected[0].strength, strength => onChange([{ ...selected[0]!, strength }]))}
          </span>}
        </span>;
      })}
      <Link className="fy-samp__item fy-samp__item--foot" to="/settings/adapters" onClick={() => setOpen(false)}>Manage adapters</Link>
    </span>}
  </span>;
}
