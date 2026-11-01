import { useEffect, useId, useRef, useState } from "react";
import { productionShape, reviewPrompt, type PromptTarget, type PromptInspectSource, type PromptInspection, type ShotPromptHistory, type PromptReview } from "@arke-studio/contracts";
import { requestPromptTools, setPromptTools, useStore } from "../lib/store.js";
import { PageSheet } from "./page-sheet.js";
import { Button, Checkbox } from "./ui.js";

export function PromptToolsSetting() {
  const { state, connection } = useStore(), id = useId();
  return <div className="fy-prompt-pref">
    <Checkbox label="Prompt history and inspection" checked={state?.app.promptTools === true} disabled={connection !== "open"}
      aria-describedby={id} onChange={event => setPromptTools(event.currentTarget.checked)} />
    <p id={id}>Show tools to compare earlier shot prompts, restore one as a new version, and inspect the prompt and references before generation. Useful when tuning a difficult shot.</p>
    <p>Off by default. Turning this off hides the tools; saved prompts and scene history are kept.</p>
  </div>;
}

export function PromptTools({ worldId, target, source, revision, disabled = false, inspectLabel = "Inspect request" }: {
  worldId: string; target?: PromptTarget; source?: PromptInspectSource; revision?: unknown; disabled?: boolean; inspectLabel?: string;
}) {
  const { state, connection } = useStore();
  const enabled = state?.app.promptTools === true;
  const [open, setOpen] = useState<"history" | "inspection" | null>(null);
  const [history, setHistory] = useState<ShotPromptHistory | null>(null);
  const [inspection, setInspection] = useState<PromptInspection | null>(null);
  const [selected, setSelected] = useState(0), [review, setReview] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [diff, setDiff] = useState<PromptReview | null>(null);
  const context = JSON.stringify({ target, session: source && "sessionId" in source ? source.sessionId : undefined, take: source?.kind === "take" ? source.takeId : undefined });
  const generation = useRef(0), identity = enabled ? JSON.stringify({ worldId, target, source, revision, canon: state?.world?.meta.canonRevision,
    artDirection: state?.world?.artDirection.version, sheets: state?.world?.sheets.map(s => [s.id, s.version]), artifacts: state?.world?.artifacts.map(a => [a.id, a.hash]),
    routing: state?.app.routing.defaults, models: state?.app.models, manifest: [state?.app.manifest?.manifestVersion, state?.app.manifest?.generated],
    scenes: state?.world?.productions.map(p => [p.meta, p.scenes.map(s => [s.id, s.version])]) }) : "";
  const entry = history?.entries[selected];
  const scene = target ? state?.world?.productions.find(p => p.meta.id === target.productionId)?.scenes.find(s => s.id === target.sceneId) : undefined;
  const production = target ? state?.world?.productions.find(p => p.meta.id === target.productionId) : undefined;
  const inferred = production && productionShape(production.meta).dispatchCapability === "video" ? "video" : "image";
  const collision = history?.currentOverride && (history.currentOverride.capability ?? inferred) !== target?.capability;
  const incompatible = entry?.prompt && (entry.prompt.capability ?? inferred) !== target?.capability;
  const moved = history && scene?.version !== history.currentVersion;
  const unchanged = JSON.stringify(entry?.prompt ?? null) === JSON.stringify(history?.currentOverride ?? null);
  const canRestore = !!entry && !entry.unavailable && !!entry.hash && entry.version < (history?.currentVersion ?? 0) && !collision && !incompatible && !moved && !unchanged && !disabled;
  useEffect(() => {
    generation.current++; setOpen(null); setHistory(null); setInspection(null); setReview(false); setBusy(false); setError("");
  }, [enabled, worldId, context, state?.world?.meta.worldId]);
  useEffect(() => {
    if (open === "inspection") { generation.current++; setBusy(false); }
    setInspection(null); setReview(false);
  }, [identity]);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => {
    let active = true; setDiff(null);
    if (history && entry?.prompt) void reviewPrompt(history.currentBody || " ", entry.prompt.text, [], "shot-prompt").then(value => { if (active) setDiff(value); }).catch(() => {});
    return () => { active = false; };
  }, [history, entry]);
  const load = async (mode: "history" | "inspection") => {
    const revision = ++generation.current;
    setOpen(mode); setBusy(true); setError(""); setReview(false);
    try {
      const result = await requestPromptTools(mode === "history" && target ? { kind: "prompt-history-read", worldId, ...target }
        : { kind: "prompt-request-inspect", worldId, source: source ?? { kind: "shot", ...target! } });
      if (revision !== generation.current) return;
      if (result.kind === "history") { setHistory(result.history); setSelected(Math.max(0, result.history.entries.findIndex(item => !item.unavailable && item.version < result.history.currentVersion))); }
      if (result.kind === "inspection") setInspection(result.inspection);
    } catch (err) { if (revision === generation.current) { setError(err instanceof Error ? err.message : "Could not read this request."); setInspection(null); } }
    finally { if (revision === generation.current) setBusy(false); }
  };
  const restore = async () => {
    if (!target || !history || !entry?.hash || !canRestore) return;
    const revision = ++generation.current;
    setBusy(true); setError("");
    try {
      const result = await requestPromptTools({ kind: "prompt-history-restore", worldId, ...target,
        assembledHash: history.assembledHash, baseVersion: history.currentVersion, baseHash: history.currentHash, sourceVersion: entry.version, sourceHash: entry.hash });
      if (revision !== generation.current) return;
      if (result.kind === "restored") { setNotice(`Prompt saved as scene v${result.version}.`); await load("history"); }
    } catch (err) { if (revision === generation.current) { setError(err instanceof Error ? err.message : "The restore was refused."); setReview(false); } }
    finally { if (revision === generation.current) setBusy(false); }
  };
  const close = () => { generation.current++; setOpen(null); setBusy(false); setReview(false); setError(""); setNotice(""); };
  if (!enabled) return null;
  return <>
    <div className="fy-prompt-tools" onMouseDown={event => event.stopPropagation()}>
      {target && <button type="button" className="fy-shot__link" disabled={disabled || connection !== "open"} title={disabled ? "Finish saving the prompt before reading its history." : "Compare retained saved prompts"} onClick={() => void load("history")}>History</button>}
      {(source || target) && <button type="button" className="fy-shot__link" disabled={disabled || connection !== "open"} title={disabled ? "Finish saving the prompt before inspecting it." : "Read the compiled request without generating"} onClick={() => void load("inspection")}>{inspectLabel}</button>}
    </div>
    <PageSheet open={open !== null} onClose={close} title={open === "history" ? review ? "Restore this prompt?" : "Prompt history" : "Inspect request"}
      className="fy-prompt-sheet" footer={<>
        <span>{busy ? "Reading…" : open === "history" ? `${target?.capability === "image" ? "Frame · image" : "Video"} · scene v${history?.currentVersion ?? "—"}` : "Read-only inspection"}</span>
        <span className="fy-prompt-grow" />
        {open === "history" && review ? <><Button variant="outline" disabled={busy} onClick={() => setReview(false)}>Cancel</Button><Button disabled={!canRestore || busy} onClick={() => void restore()}>{entry?.prompt ? `Restore ${target?.capability} prompt` : "Use assembled prompt"}</Button></>
          : <>{open === "history" && <Button disabled={!canRestore || busy} onClick={() => setReview(true)}>Review restore</Button>}<Button variant="outline" onClick={close}>Done</Button></>}
      </>}>
      {error && <p className="fy-prompt-notice" role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {open === "history" && history && <>
        {(history.partial || history.entries.length === 1) && <p className="fy-prompt-notice">{history.entries.length === 1 ? "Current prompt only. No earlier retained prompt changes are available." : "Some history is unavailable. These are the retained changes that can be read."}</p>}
        {(collision || incompatible || moved) && <p className="fy-prompt-notice" role="status">{moved ? "The scene changed. Read again before restoring." : "This prompt belongs to the other capability. It cannot be replaced from this context."}</p>}
        {review ? <section><p>Save the selected prompt as one new scene version. The script, camera and selected take keep their current values.</p>
          <h3>{entry?.prompt ? `Historical body · scene v${entry.version}` : "Today's assembled prompt"}</h3><p className="fy-prompt-text">{entry?.prompt?.text ?? history.assembledBody}</p>
          <p className="fy-prompt-notice">{entry?.prompt ? "The original source versions stay recorded. Restoring does not reground these words in today's sheets." : "No historical assembly text was recorded. Removing the override uses today's sources."}</p>
        </section> : <div className="fy-prompt-history"><nav aria-label="Retained prompt versions">{history.entries.map((item, index) => <button type="button" key={item.version} aria-current={selected === index ? "true" : undefined} disabled={item.unavailable} onClick={() => { setSelected(index); setReview(false); }}>
          <strong>Scene v{item.version}{item.version === history.currentVersion ? " · current" : ""}</strong><span>{item.unavailable ? "Could not read" : item.prompt ? `${item.prompt.capability ?? "Legacy"} prompt` : "No saved override"}</span>
        </button>)}</nav><article><h3>Current saved body</h3><p className="fy-prompt-text">{history.currentBody}</p><h3>Selected · scene v{entry?.version}</h3><p className="fy-prompt-text">{entry?.prompt?.text ?? "No override was recorded. Use assembled prompt reviews today's sources; it cannot recover unrecorded historical words."}</p>
          {diff && <details><summary>Text changes</summary>{diff.hunks.length ? diff.hunks.map((hunk, index) => <p key={index}>{hunk.op === "add" ? <>Added: <ins>{hunk.text}</ins></> : <>Removed: <del>{hunk.text}</del></>}</p>) : <p>No textual changes.</p>}</details>}
          {entry?.prompt && <details><summary>Recorded source versions</summary>{Object.entries(entry.prompt.sheetVersions).map(([id, version]) => <p key={id}>{id} · v{version}{state?.world?.sheets.find(s => s.id === id)?.version !== version ? " · source has changed" : ""}</p>)}</details>}
        </article></div>}
      </>}
      {open === "inspection" && inspection && <>
        <p className="fy-prompt-notice"><strong>{inspection.source === "saved-shot" ? "Current saved shot" : inspection.source === "generator-draft" ? "Current generator draft · not saved to the shot" : "Recorded compiled request"}</strong><br />{inspection.identity}</p>
        <p>{inspection.capability} · {inspection.provider} · {inspection.model}{inspection.quantity > 1 ? ` · first of ${inspection.quantity} requests` : ""}</p>
        <p>{inspection.controls.map(control => `${control.label}: ${control.value}`).join(" · ")}</p>
        <div className="fy-prompt-title"><h3>Compiled prompt</h3><Button variant="outline" onClick={() => { if (!navigator.clipboard) { setError("Copy is unavailable here. Select the text to copy it."); return; } void navigator.clipboard.writeText(inspection.prompt).then(() => setNotice("Prompt copied.")).catch(() => setError("Copy is unavailable here. Select the text to copy it.")); }}>Copy full prompt</Button></div>
        <p className="fy-prompt-text">{inspection.prompt}</p><h3>References · order within each input kind</h3>
        {inspection.references.map((ref, index) => <div className="fy-prompt-reference" key={index}><strong>{ref.sent ? `${ref.field}${ref.index ? ` ${ref.index}` : ""}` : "Not sent"} · {ref.subject}</strong>
          <p>{ref.role}{ref.sheetVersion ? ` · sheet v${ref.sheetVersion}` : ""}{ref.reason ? ` · ${ref.reason}` : ""}</p>{ref.file && <details><summary>Source</summary><p>{ref.file}</p>{ref.hash && <p>Recorded hash · {ref.hash}</p>}</details>}
        </div>)}
        {inspection.references.length === 0 && <p>No carried references.</p>}
        {inspection.notices.map(value => <p className="fy-prompt-hint" key={value}>{value}</p>)}
      </>}
      {open === "inspection" && !busy && !inspection && !error && <p role="status">The request changed. Read again to inspect the current inputs.</p>}
      {!busy && <Button variant="outline" disabled={connection !== "open"} onClick={() => { setHistory(null); void load(open ?? "history"); }}>Read again</Button>}
      {busy && <p role="status">Reading prompt evidence…</p>}
    </PageSheet>
  </>;
}
