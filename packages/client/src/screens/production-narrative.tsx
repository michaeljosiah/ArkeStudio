import { useEffect, useRef, useState } from "react";
import { NavLink, useParams } from "react-router";
import { ulid, type ProductionNarrative } from "@arke-studio/contracts";
import { useProduction } from "../lib/selectors.js";
import { send, subscribeCommandFailures, subscribeNarrativeSaved } from "../lib/store.js";
import { Button } from "../components/ui.js";

export function ProductionNarrativeScreen() {
  const { worldId, prodId } = useParams();
  const { production } = useProduction(worldId, prodId);
  const narrative = production?.narrative ?? null;
  const [draft, setDraft] = useState<Omit<ProductionNarrative, "version">>({});
  const [base, setBase] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const request = useRef<string | null>(null);
  useEffect(() => {
    setDirty(false); setPending(false); setFailure(null); request.current = null;
  }, [worldId, prodId]);
  useEffect(() => {
    if (!dirty) {
      const { version: _version, ...fields } = narrative ?? {};
      setDraft(fields); setBase(narrative?.version ?? null);
    }
  }, [narrative, dirty]);
  useEffect(() => subscribeCommandFailures(event => {
    if (event.requestId === request.current) { setPending(false); setFailure(event.reason); }
  }), []);
  useEffect(() => subscribeNarrativeSaved(event => {
    if (event.requestId === request.current) { setPending(false); setDirty(false); }
  }), []);
  return <div className="fy-prodmain" data-screen="production-narrative">
    <div className="fy-h1row"><h1 className="fy-h1">{production?.meta.title} · Film narrative</h1></div>
    <p>The dramatic question, through-line and ending that guide this film.</p>
    {production?.story && <p><NavLink to={`/w/${worldId}/p/${prodId}/overview`}>Earlier overview</NavLink></p>}
    {failure && <p role="alert">{failure}</p>}
    {dirty && (narrative?.version ?? null) !== base && <p role="alert">The narrative changed elsewhere. Reopen this page before saving.</p>}
    <div style={{ maxWidth: 760, display: "grid", gap: 20 }}>
      {(["question", "direction", "ending", "arcNotes"] as const).map(field => <label key={field} style={{ display: "grid", gap: 8 }}>
        {{ question: "Dramatic question", direction: "Through-line", ending: "Ending", arcNotes: "Arc notes" }[field]}
        <textarea value={draft[field] ?? ""} maxLength={20_000} rows={field === "direction" ? 5 : 3} disabled={pending}
          style={{ padding: 12, font: "inherit", lineHeight: 1.6, color: "inherit", background: "transparent", border: "1px solid var(--line)", borderRadius: 6 }}
          onChange={event => { setDraft(previous => ({ ...previous, [field]: event.target.value })); setDirty(true); }} />
      </label>)}
      <div><Button disabled={!dirty || pending || !worldId || !prodId || (narrative?.version ?? null) !== base} onClick={() => {
        const requestId = ulid(); request.current = requestId; setFailure(null);
        if (send({ kind: "save-production-narrative", worldId: worldId!, productionId: prodId!, requestId, expectedVersion: base, narrative: draft })) setPending(true);
        else setFailure("The studio is disconnected. Your edits are still here.");
      }}>{pending ? "Saving…" : "Save narrative"}</Button>
      <span className="fy-mono" style={{ marginLeft: 14 }}>{base === null ? "No narrative saved yet" : `Version ${base}`}</span></div>
    </div>
  </div>;
}
