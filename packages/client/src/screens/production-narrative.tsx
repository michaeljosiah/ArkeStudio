import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, useParams } from "react-router";
import { ulid, type ProductionNarrative } from "@arke-studio/contracts";
import { useProduction } from "../lib/selectors.js";
import { send, subscribeCommandFailures, subscribeNarrativeSaved } from "../lib/store.js";
import { Button } from "../components/ui.js";
import { HeldBar } from "../components/held-bar.js";
import { Book, ChevronRight } from "../components/icons.js";
import { useMediaQuery } from "../lib/media-query.js";

const fields = ["question", "direction", "ending", "arcNotes"] as const;

export function ProductionNarrativeScreen() {
  const { worldId, prodId } = useParams();
  const { production } = useProduction(worldId, prodId);
  const narrative = production?.narrative ?? null;
  const [draft, setDraft] = useState<Omit<ProductionNarrative, "version">>({});
  const [base, setBase] = useState<number | null>(null);
  const [original, setOriginal] = useState<Omit<ProductionNarrative, "version">>({});
  const compact = useMediaQuery("(max-width: 1099px)");
  const grid = useRef<HTMLDivElement>(null);
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
      setDraft(fields); setOriginal(fields); setBase(narrative?.version ?? null);
    }
  }, [narrative, dirty]);
  useEffect(() => subscribeCommandFailures(event => {
    if (event.requestId === request.current) { setPending(false); setFailure(event.reason); }
  }), []);
  useEffect(() => subscribeNarrativeSaved(event => {
    if (event.requestId === request.current) { setPending(false); setDirty(false); }
  }), []);
  useLayoutEffect(() => {
    grid.current?.querySelectorAll("textarea").forEach(field => {
      field.style.height = "";
      if (compact) { field.style.height = "88px"; field.style.height = `${Math.max(88, field.scrollHeight + 2)}px`; }
    });
  }, [draft, compact]);
  const changes = fields.filter(field => (draft[field] ?? "") !== (original[field] ?? "")).length;
  return <div className="fy-prodmain fy-narrative" data-screen="production-narrative">
    <div className="fy-narrative__eyebrow fy-eyebrow-sm">Overview · {production?.meta.format ?? "film"} · version {base ?? 0}</div>
    <div className="fy-h1row"><h1 className="fy-h1">{compact ? "Narrative" : <>{production?.meta.title} · Film narrative</>}</h1></div>
    <p className="fy-narrative__intro">The dramatic question, through-line and ending that guide this film.</p>
    {production?.story && <p className="fy-narrative__earlier"><NavLink to={`/w/${worldId}/p/${prodId}/overview`}><Book size={16} />Earlier overview<span>story v{production.story.version} · logline, spine, {production.story.acts?.length ?? 0} acts</span><ChevronRight size={16} /></NavLink></p>}
    {failure && <p role="alert">{failure}</p>}
    {dirty && (narrative?.version ?? null) !== base && <p role="alert">The narrative changed elsewhere. Reopen this page before saving.</p>}
    <div ref={grid} className="fy-narrative__fields">
      {fields.map(field => <label key={field} style={{ display: "grid", gap: 8 }}>
        <span>{{ question: "Dramatic question", direction: "Through-line", ending: "Ending", arcNotes: "Arc notes" }[field]}{(draft[field] ?? "") !== (original[field] ?? "") && <small>edited</small>}</span>
        <textarea value={draft[field] ?? ""} maxLength={20_000} rows={field === "direction" ? 5 : 3} disabled={pending}
          style={{ padding: 12, font: "inherit", lineHeight: 1.6, color: "inherit", background: "transparent", border: "1px solid var(--line)", borderRadius: 6 }}
          onChange={event => { const next = { ...draft, [field]: event.target.value }; setDraft(next); setDirty(fields.some(key => (next[key] ?? "") !== (original[key] ?? ""))); }} />
      </label>)}
      <HeldBar className="fy-narrative__save"><Button disabled={!dirty || changes === 0 || pending || !worldId || !prodId || (narrative?.version ?? null) !== base} onClick={() => {
        const requestId = ulid(); request.current = requestId; setFailure(null);
        if (send({ kind: "save-production-narrative", worldId: worldId!, productionId: prodId!, requestId, expectedVersion: base, narrative: draft })) setPending(true);
        else setFailure("The studio is disconnected. Your edits are still here.");
      }}>{pending ? "Saving…" : "Save narrative"}</Button>
      <span className="fy-mono" style={{ marginLeft: 14 }}>{compact ? `${changes} change${changes === 1 ? "" : "s"} · version ${base ?? 0}` : base === null ? "No narrative saved yet" : `Version ${base}`}</span></HeldBar>
    </div>
  </div>;
}
