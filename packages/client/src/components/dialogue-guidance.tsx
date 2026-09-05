import { useEffect, useRef, useState } from "react";
import { compilePasses, orderedShots, ShotCharacterPresentationSchema, ulid, type WorldBundle, type ProductionBundle,
  type SceneRecord, type ScenePlan, type ManifestModel, type ModelManifest, type Shot, type ShotVisualFacts } from "@arke-studio/contracts";
import { send, subscribeDialogueResults, useStore } from "../lib/store.js";
import { Button } from "./ui.js";

function VisualFactsEditor({ world, production, scene, shot }: { world: WorldBundle; production: ProductionBundle; scene: SceneRecord; shot: Shot }) {
  const [facts, setFacts] = useState<ShotVisualFacts>(shot.visualFacts ?? { onScreenCharacters: [], composition: "single", confirmedAt: new Date().toISOString() });
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), pending = useRef<string | null>(null);
  const { connection } = useStore();
  useEffect(() => subscribeDialogueResults(result => {
    if (result.requestId !== pending.current) return;
    pending.current = null; setBusy(false); setNotice(result.reason);
  }), []);
  useEffect(() => { if (connection !== "open" && busy) { pending.current = null; setBusy(false); setNotice("Disconnected. Check proposal history before retrying."); } }, [connection, busy]);
  const propose = (value: ShotVisualFacts | null) => {
    pending.current = ulid(); setBusy(true);
    if (!send({ kind: "propose-shot-visual-facts", requestId: pending.current, worldId: world.meta.worldId, productionId: production.meta.id,
      sceneId: scene.id, shotId: shot.id, expectedSceneVersion: scene.version, visualFacts: value ? { ...value, confirmedAt: new Date().toISOString() } : null })) {
      setBusy(false); setNotice("The studio is disconnected.");
    }
  };
  return <details style={{ marginBlock: 8 }}><summary>Shot {shot.number} · {shot.visualFacts ? "Authored visual facts" : "No authored visual facts"}</summary>
    <p>Select the cast you intend to show. Cited characters alone do not establish who is on screen.</p>
    <label>Composition <select aria-label={`Shot ${shot.number} composition`} value={facts.composition} onChange={e => setFacts({ ...facts, composition: e.target.value as ShotVisualFacts["composition"] })}>
      {["single", "two-shot", "group", "over-the-shoulder", "wide", "other"].map(value => <option key={value}>{value}</option>)}
    </select></label>
    {world.sheets.filter(sheet => sheet.type === "character" && !sheet.retired).map(sheet => {
      const fact = facts.onScreenCharacters.find(c => c.characterId === sheet.id);
      const change = (next: Partial<NonNullable<typeof fact>>) => setFacts({ ...facts, onScreenCharacters: facts.onScreenCharacters.map(c => c.characterId === sheet.id ? { ...c, ...next } : c) });
      return <div key={sheet.id} style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBlock: 8 }}>
        <label><input type="checkbox" checked={!!fact} onChange={e => setFacts({ ...facts, onScreenCharacters: e.target.checked
          ? [...facts.onScreenCharacters, { characterId: sheet.id, presentation: "unknown", depth: "midground" }]
          : facts.onScreenCharacters.filter(c => c.characterId !== sheet.id) })} />{sheet.name}</label>
        {fact && <><select aria-label={`${sheet.name} presentation`} value={fact.presentation} onChange={e => change({ presentation: e.target.value as typeof fact.presentation })}>
          {ShotCharacterPresentationSchema.options.map(value => <option key={value}>{value}</option>)}</select>
          <select aria-label={`${sheet.name} depth`} value={fact.depth} onChange={e => change({ depth: e.target.value as typeof fact.depth })}>
            {["foreground", "midground", "background"].map(value => <option key={value}>{value}</option>)}</select></>}
      </div>;
    })}
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <Button disabled={!shot.audio?.speaker} onClick={() => setFacts({ ...facts, composition: "single", onScreenCharacters: [{ characterId: shot.audio!.speaker!, presentation: "face-front", depth: "midground" }] })}>Draft isolated speaker</Button>
      <Button onClick={() => setFacts({ ...facts, composition: "over-the-shoulder", onScreenCharacters: facts.onScreenCharacters.map(c => c.characterId === shot.audio?.speaker
        ? { ...c, presentation: "face-front", depth: "midground" } : { ...c, presentation: "turned-away", depth: "foreground" }) })}>Draft over the shoulder</Button>
      <Button disabled={busy} onClick={() => propose(facts)}>Review visual facts proposal</Button>
      {shot.visualFacts && <Button disabled={busy} onClick={() => propose(null)}>Propose clearing facts</Button>}
    </div><p role="status">{notice}</p>
  </details>;
}

export function DialogueGuidance({ world, production, scene, plan, model, manifest, acknowledged, onAcknowledge }: {
  world: WorldBundle; production: ProductionBundle; scene: SceneRecord; plan: ScenePlan | null; model: ManifestModel | null;
  manifest: ModelManifest | null; acknowledged: string[]; onAcknowledge: (ids: string[]) => void;
}) {
  let assessments: import("@arke-studio/contracts").DialogueDispatchAssessment[] = [], error = "";
  try {
    if (plan && model) assessments = compilePasses({ world, productionId: production.meta.id, scene, plan, model, manifest: manifest ?? undefined,
      assessedAt: new Date().toISOString(), acknowledgedRecommendationIds: acknowledged,
      chainWholeSceneFrames: plan.mode === "whole-scene" && !plan.passReferences.some(p => p.audioReferences?.references.length),
    }).flatMap(pass => Object.values((pass.params.provenance as { dialogueAssessments?: Record<string, import("@arke-studio/contracts").DialogueDispatchAssessment> }).dialogueAssessments ?? {}));
  } catch (cause) { error = cause instanceof Error ? cause.message : "Assessment unavailable"; }
  const valid = assessments.flatMap(a => a.recommendations.map(r => r.id));
  const surviving = acknowledged.filter(id => valid.includes(id));
  const signature = JSON.stringify(surviving);
  useEffect(() => { if (JSON.stringify(acknowledged) !== signature) onAcknowledge(surviving); }, [signature]);
  return <details style={{ padding: 12, borderTop: "1px solid var(--border)", overflowWrap: "anywhere" }}><summary>Dialogue guidance and authored visual facts</summary>
    {error && <p role="status">Assessment unavailable: {error}</p>}
    {!error && assessments.length === 0 && <p>No video assessment available.</p>}
    {assessments.map(a => <div key={a.facts.shotId}>
      <p>{a.facts.shotId} · {a.facts.frameMode === "exact-start-frame" ? "Dedicated start-frame transport" : a.facts.frameMode === "reference-image" ? "Image reference · no exact frame-one promise" : "No image input"}</p>
      <small>{a.providerRoute} · {a.endpointVersion}</small>
      {!a.recommendations.length && <p>No matching reviewed guidance. This is not a quality guarantee.</p>}
      {a.recommendations.map(r => <div key={r.id} data-classification={r.classification} style={{ borderLeft: "3px solid var(--border)", padding: 8 }}>
        <strong>{r.classification.replaceAll("-", " ")} · advisory</strong><p>{r.message}</p>
        <p>Revision {r.guidanceRevision} · reviewed {r.guidance.reviewedAt}{r.guidance.expiresAt ? ` · expires ${r.guidance.expiresAt}` : ""}</p>
        {"url" in r.guidance.evidence ? <a href={r.guidance.evidence.url} target="_blank" rel="noreferrer">{r.guidance.evidence.title}</a>
          : <p>{r.guidance.evidence.benchmarkId} v{r.guidance.evidence.benchmarkVersion} · {r.guidance.evidence.reportFile} · {r.guidance.evidence.reportHash}</p>}
        <label><input type="checkbox" checked={acknowledged.includes(r.id)} onChange={e => onAcknowledge(e.target.checked ? [...new Set([...surviving, r.id])] : surviving.filter(id => id !== r.id))} />Reviewed recommendation</label>
        <p>Keep the shot and continue, or use the model, frame and audio controls above. Review authored alternatives below.</p>
      </div>)}
      {a.ignoredGuidance.some(g => ["expired", "endpoint-version-mismatch"].includes(g.reason)) && <p>Stale guidance was ignored.</p>}
    </div>)}
    {orderedShots(scene).map(shot => <VisualFactsEditor key={`${shot.id}/${scene.version}`} {...{ world, production, scene, shot }} />)}
  </details>;
}
