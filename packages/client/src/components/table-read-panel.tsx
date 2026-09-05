import { useEffect, useRef, useState } from "react";
import { deriveRehearsalLines, formatMicroUsd, ulid, type TableReadPlan, type WorldBundle, type ProductionBundle, type SceneRecord } from "@arke-studio/contracts";
import { send, subscribeRehearsalResults, subscribeQueueResults, useStore } from "../lib/store.js";
import { loadPlaylist, clearPlaylist, playPlaylistLine, nextPlaylistLine, restartPlaylistLine, togglePlayback,
  setPlaylistRate, setPlaylistSolo, usePlaylist, usePlayback, type PlaylistState } from "../lib/audio.js";
import { mediaUrl } from "../lib/media.js";
import { Button } from "./ui.js";
export function TableReadPanel({ world, production, scene, onRecord }: { world: WorldBundle; production: ProductionBundle; scene: SceneRecord; onRecord: (shotId: string) => void }) {
  const { state } = useStore();
  const lines = deriveRehearsalLines(scene, world.sheets);
  const [plan, setPlan] = useState<TableReadPlan | null>(null), [notice, setNotice] = useState("");
  const [queueNotice, setQueueNotice] = useState("");
  const [busy, setBusy] = useState(false), [drafts, setDrafts] = useState<Record<string, string>>({});
  const pending = useRef<string | null>(null), queued = useRef<string | null>(null);
  const [sessionId] = useState(() => production.rehearsals.find(r => r.sceneId === scene.id)?.id ?? `rh_${ulid()}`);
  const session = production.rehearsals.find(r => r.id === sessionId);
  const playlist = usePlaylist(), playback = usePlayback();
  const requestPlan = () => { pending.current = ulid(); if (!send({ kind: "plan-table-read", requestId: pending.current, worldId: world.meta.worldId, productionId: production.meta.id, sceneId: scene.id })) setNotice("The studio is disconnected."); };
  useEffect(() => subscribeRehearsalResults(result => {
    if (result.requestId !== pending.current) return;
    pending.current = null; setBusy(false); if (result.plan) setPlan(result.plan); setNotice(result.reason);
  }), []);
  useEffect(() => subscribeQueueResults(result => {
    if (result.requestId !== queued.current) return;
    queued.current = null;
    setQueueNotice(`${result.acceptedJobIds.length} of ${result.requestedCount} cloud lines added to Activity.${result.failures.length ? " Some lines could not be queued." : ""}`);
  }), []);
  const jobStatus = state?.app.jobs.filter(j => j.target.kind === "table-read-cache" && j.worldId === world.meta.worldId).map(j => `${j.id}:${j.status}`).join("|");
  useEffect(() => { requestPlan(); }, [scene.version, production.performanceReview.reviewHash, production.performanceReview.selectionHash, jobStatus]);
  useEffect(() => () => clearPlaylist(), []);
  const sourceSignature = plan?.items.map(item => `${item.lineId}:${item.route}:${item.file ?? ""}:${item.sourceHash ?? ""}`).join("|");
  useEffect(() => { clearPlaylist(); }, [sourceSignature]);
  const saveNote = (lineId: string, body: string | null) => {
    pending.current = ulid(); setBusy(true);
    if (!send({ kind: "save-rehearsal-note", requestId: pending.current, worldId: world.meta.worldId, productionId: production.meta.id,
      sceneId: scene.id, rehearsalId: sessionId, expectedHash: production.rehearsalHashes?.[sessionId] ?? null, lineId, body })) { setBusy(false); setNotice("The studio is disconnected."); }
  };
  const active = playlist?.items[playlist.index];
  return <details style={{ padding: 16, borderTop: "1px solid var(--border)" }}><summary>Scene table read · {lines.length} authored lines</summary>
    {!lines.length && <p>This scene has no authored spoken lines.</p>}
    <Button disabled={busy} onClick={requestPlan}>Refresh preparation preview</Button>
    {plan && <><p>{plan.items.filter(i => i.route === "existing").length} accepted · {plan.items.filter(i => i.route === "cached").length} cached · {plan.items.filter(i => i.route === "local").length} local missing · {plan.items.filter(i => i.route === "cloud").length} cloud missing · {plan.items.filter(i => i.route === "unavailable").length} unavailable</p>
      <p>Prepare missing lines · {formatMicroUsd(plan.totalEstimatedMicroUsd)}. Cloud text and voice IDs go to ElevenLabs and remain in local Activity history until that job history is deleted. Provider-call history may also contain text. Cache preparation does not accept a performance.</p>
      <Button disabled={busy || !plan.items.some(i => i.route === "local" || i.route === "cloud")} onClick={() => {
        pending.current = ulid(); queued.current = pending.current; setBusy(true);
        if (!send({ kind: "prepare-table-read", requestId: pending.current, worldId: world.meta.worldId, productionId: production.meta.id, sceneId: scene.id,
          confirmationToken: plan.confirmationToken, confirmedMicroUsd: plan.totalEstimatedMicroUsd })) { setBusy(false); setNotice("The studio is disconnected."); }
      }}>Confirm preparation · {formatMicroUsd(plan.totalEstimatedMicroUsd)}</Button>
      <Button disabled={!plan.items.some(i => i.file)} onClick={() => {
        const items = plan.items.flatMap(item => {
          const line = lines.find(l => l.id === item.lineId); if (!item.file || !line?.speakerSheetId) return [];
          const name = world.sheets.find(s => s.id === line.speakerSheetId)?.name ?? line.speakerSheetId;
          return [{ id: `table/${line.id}`, lineId: line.id, speakerSheetId: line.speakerSheetId, url: mediaUrl(world.meta.slug, item.file), title: `${name}: ${line.text}`, sub: `${item.route} · ${item.performanceId ?? item.model ?? ""}` }];
        });
        loadPlaylist(items); void playPlaylistLine(); setNotice(`${plan.items.length - items.length} unavailable lines skipped from this playback list.`);
      }}>Play table read</Button>
    </>}
    {playlist && <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <Button onClick={togglePlayback}>{playback.status === "playing" ? "Pause" : "Resume"}</Button>
      <Button onClick={() => nextPlaylistLine(-1)}>Previous</Button><Button onClick={() => nextPlaylistLine()}>Skip line</Button>
      <Button onClick={restartPlaylistLine}>Restart line</Button><Button onClick={clearPlaylist}>Stop table read</Button>
      <label>Solo <select value={playlist.soloSheetId ?? ""} onChange={e => setPlaylistSolo(e.target.value || null)}><option value="">All characters</option>{[...new Set(lines.flatMap(l => l.speakerSheetId ? [l.speakerSheetId] : []))].map(id => <option key={id} value={id}>{world.sheets.find(s => s.id === id)?.name ?? id}</option>)}</select></label>
      <label>Rate <select value={playlist.rate} onChange={e => setPlaylistRate(Number(e.target.value) as PlaylistState["rate"])}>{[0.75, 1, 1.25, 1.5].map(rate => <option key={rate} value={rate}>{rate}×</option>)}</select></label>
    </div>}
    <p role="status" aria-live="polite">{active?.title} {playlist?.notice} {playback.status === "error" || playback.status === "blocked" ? playback.error : ""} {notice} {queueNotice}</p>
    {lines.map(line => { const item = plan?.items.find(i => i.lineId === line.id), note = session?.notes[line.id]; return <div key={line.id} style={{ marginTop: 16 }}>
      <p>{world.sheets.find(s => s.id === line.speakerSheetId)?.name ?? "Unresolved speaker"}: {line.text || line.reason}</p>
      <p>{item?.route ?? "Unresolved"} · {item?.reason ?? item?.model ?? item?.performanceId ?? ""}</p>
      <Button onClick={() => onRecord(line.shotId)}>Record / review this line</Button>
      <label>Rehearsal note <textarea value={drafts[line.id] ?? note?.body ?? ""} onChange={e => setDrafts(current => ({ ...current, [line.id]: e.target.value }))} maxLength={4000} /></label>
      {note && item?.textHash && note.authoredTextHash !== item.textHash && <p>Note from earlier wording.</p>}
      <Button disabled={busy || !(drafts[line.id] ?? note?.body)?.trim()} onClick={() => saveNote(line.id, (drafts[line.id] ?? note?.body ?? "").trim())}>Save note</Button>
      {note && <Button variant="ghost" disabled={busy} onClick={() => { setDrafts(current => ({ ...current, [line.id]: "" })); saveNote(line.id, null); }}>Remove note</Button>}
    </div>; })}
    {Object.entries(session?.notes ?? {}).filter(([key]) => !lines.some(l => l.id === key)).map(([key, note]) => <p key={key}>Orphaned note: {note.body} <Button disabled={busy} onClick={() => saveNote(key, null)}>Remove orphaned note</Button></p>)}
    <p>Notes are world content and travel with exports. Table-read audio cache is derived content.</p>
  </details>;
}
