import { useEffect, useRef, useState } from "react";
import { allowedDialogueFeedback, aggregateDialogueFeedback, ulid, type Take, type ProductionBundle, type TakeDialogueFeedback } from "@arke-studio/contracts";
import { send, subscribeDialogueResults, useStore } from "../lib/store.js";
import { Button } from "./ui.js";

export function TakeDialogueFeedbackPanel({ worldId, production, take, shotId }: { worldId: string; production: ProductionBundle; take: Take; shotId: string }) {
  const allowed = allowedDialogueFeedback(take, shotId);
  const [tags, setTags] = useState<TakeDialogueFeedback["tags"]>([]), [note, setNote] = useState(""), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), pending = useRef<string | null>(null);
  const { connection } = useStore();
  useEffect(() => subscribeDialogueResults(result => { if (result.requestId === pending.current) { pending.current = null; setBusy(false); setNotice(result.reason); if (result.status === "saved") { setTags([]); setNote(""); } } }), []);
  useEffect(() => { if (connection !== "open" && busy) { setBusy(false); setNotice("Disconnected. Check saved feedback before retrying."); } }, [connection, busy]);
  const feedback = production.feedback ?? [];
  const aggregates = aggregateDialogueFeedback(production.takes, feedback);
  return <details style={{ padding: 12, overflowWrap: "anywhere" }}><summary>Take diagnostics · separate from Accept / Reject</summary>
    {!allowed.length ? <p>This take has no frozen dialogue assessment.</p> : <>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>{allowed.map(tag => <label key={tag}><input type="checkbox" checked={tags.includes(tag)} onChange={e => setTags(e.target.checked ? [...tags, tag] : tags.filter(t => t !== tag))} />{tag.replaceAll("-", " ")}</label>)}</div>
      <label>Diagnostic note<textarea style={{ width: "100%" }} value={note} maxLength={1000} onChange={e => setNote(e.target.value)} /></label>
      <Button disabled={busy || !tags.length} onClick={() => {
        pending.current = ulid(); setBusy(true);
        if (!send({ kind: "record-dialogue-feedback", worldId, requestId: pending.current, productionId: production.meta.id, takeId: take.id, shotId,
          tags, note, recommendationIds: take.provenance.dialogueAssessments?.[shotId]?.acknowledgedRecommendationIds ?? [] })) { setBusy(false); setNotice("The studio is disconnected."); }
      }}>Save diagnostic feedback</Button>
    </>}
    <p role="status">{notice}</p>
    {feedback.filter(f => f.takeId === take.id && f.shotId === shotId).map((f, i) => <p key={i}>{f.ts} · {f.tags.join(", ")}{f.note ? ` · ${f.note}` : ""}</p>)}
    <details><summary>Local observations · shipped guidance unchanged</summary>{aggregates.length ? aggregates.map((a, i) => <p key={i}>{a.modelId} · {a.providerRoute} · {a.endpointVersion} · {a.guidanceId ?? "no recommendation"} {a.guidanceRevision ?? ""} · {a.tag} · {a.sampleCount} observation{a.sampleCount === 1 ? "" : "s"}</p>) : <p>No local diagnostic observations.</p>}</details>
  </details>;
}
