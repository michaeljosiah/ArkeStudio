import { ProposalManager } from "../gate/proposals.js";
import { SceneRecordSchema, editShot, stagingRetimed, orderedShots, resolvedAuthoredDuration } from "@arke-studio/contracts";
import { readFile } from "node:fs/promises";
import { calculateDialogueTiming, dialogueSlots, dialogueTimingProblems, performanceLineKey, framesToSeconds, secondsToFrames,
  type ClientMessage, type DialogueTiming, type TimelineCommand, type ProductionBundle } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { sha256 } from "../world/text-files.js";
import { audioWorldPath } from "./storage.js";
import { readAudioBytes } from "./media-tools.js";
import { audioHash } from "./qc.js";
import { currentPerformanceTarget, readPerformance } from "./performances.js";
import { applyTimelineCommand } from "../productions/timeline.js";

/** Review placement on the existing editor authority. Selection alone never changes this source. */
export async function placeSelectedPerformance(store: WorldStore, request: Extract<ClientMessage,{kind:"place-selected-performance"}>) {
  const production = store.getBundle().productions.find(p => p.meta.id === request.productionId);
  if (!production || production.timeline?.status !== "ready") throw new Error("Open and assemble the production timeline before placing dialogue.");
  const timeline = production.timeline.timeline;
  const performance = await readPerformance(store, request.productionId, request.performanceId);
  const slots = dialogueSlots(production).filter(s => s.shotId === performance.target.shotId);
  if (slots.length !== 1) throw new Error("Place this shot exactly once on the Picture track before adding its dialogue.");
  const result = calculateDialogueTiming(slots[0]!, performance.provenance.outputTechnical.durationSec, request.leadInSec, request.timing);
  if (!result.ok) throw new Error(result.reason);
  const t = result.timing;
  const current = timeline.tracks.flatMap(track => track.clips.filter(c => c.source.kind === "performance" && c.source.shotId === performance.target.shotId));
  if (current.length > 1) throw new Error("Remove duplicate dialogue placements for this shot first.");
  const trackId = `tr_dialogue_${performance.target.shotId.replaceAll("_", "-")}` as const;
  const commands: TimelineCommand[] = current.map(clip => ({ kind: "delete", clipId: clip.id }));
  if (!timeline.tracks.some(track => track.id === trackId)) commands.push({ kind: "add-track", trackId, trackKind: "dialogue", name: `Dialogue · ${performance.target.shotId}` });
  commands.push({ kind: "place", trackId, clip: {
    id: current[0]?.id ?? `cl_performance_${request.requestId}`, startFrame: secondsToFrames(t.speechStartSec,timeline.frameRate),
    durationFrames: Math.max(1,Math.ceil(t.spokenSec / framesToSeconds(1,timeline.frameRate))),
    sourceInFrames: secondsToFrames(t.sourceInSec,timeline.frameRate),
    source: { kind: "performance", performanceId: performance.id, shotId: performance.target.shotId,
      label: `Performance ${performance.id}`, sourceHash: performance.provenance.outputHash, leadInSec: request.leadInSec, timing: request.timing },
  } });
  await applyTimelineCommand(store,request.productionId,{ kind:"commands",commands,baseRevision:request.expectedTimelineRevision,sourceFingerprint:"",label:"Place selected dialogue performance" },async latest => {
    const raw = await readFile(await audioWorldPath(store.dir,`productions/${request.productionId}/timeline.json`),"utf8");
    if (sha256(raw) !== request.expectedTimelineHash) throw new Error("The cut changed. Review the current placement before applying again.");
    if (latest.performanceReview.selectionHash !== request.expectedSelectionHash || latest.performanceReview.selections[performanceLineKey(performance.target)]?.performanceId !== performance.id) throw new Error("The performance selection changed. Review the selected source again.");
    if (!currentPerformanceTarget(store,performance.target)) throw new Error("This performance targets an earlier authored line.");
    if (performance.kind !== "scratch") {
      const voice=store.getBundle().sheets.find(s=>s.id===performance.target.speakerSheetId)?.voice, frozen=performance.voiceAssignment;
      if (!voice || voice.provider!==frozen.provider || voice.voiceId!==frozen.voiceId || voice.model!==frozen.model || voice.assignedAtVersion!==frozen.assignedAtVersion) throw new Error("This performance uses an earlier character voice. Review a current performance before placement.");
    }
    const accepted = latest.performanceReview.reviews.filter(r => r.performanceId === performance.id).at(-1);
    if (accepted?.decision !== "accept") throw new Error("Accept this performance before placing it.");
    const bytes = await readAudioBytes(await audioWorldPath(store.dir,`productions/${request.productionId}/performances/${performance.id}/${performance.file}`),store.closingSignal);
    if (audioHash(bytes) !== performance.provenance.outputHash) throw new Error("Performance bytes changed; placement refused.");
    const timings = placedPerformanceTimings(latest).filter(p => p.shotId !== t.shotId);
    const allSlots = dialogueSlots(latest);
    const end = Math.max(0,...allSlots.map(s => s.endSec));
    const problems = dialogueTimingProblems([...timings,t],allSlots,end);
    if (problems.length) throw new Error(problems.join(" "));
  });
}
export function placedPerformanceTimings(production: ProductionBundle): DialogueTiming[] {
  if (production.timeline?.status !== "ready") return [];
  const slots = dialogueSlots(production), result: DialogueTiming[] = [];
  for (const track of production.timeline.timeline.tracks) for (const clip of track.clips) {
    if (clip.source.kind !== "performance") continue;
    const source = clip.source;
    const performance = production.performances.find(p => p.id === source.performanceId);
    const slot = slots.filter(s => s.shotId === source.shotId);
    if (!performance || slot.length !== 1) throw new Error(`${clip.id}: performance or picture slot is missing or ambiguous.`);
    const timing = calculateDialogueTiming(slot[0]!,performance.provenance.outputTechnical.durationSec,source.leadInSec,source.timing);
    if (!timing.ok) throw new Error(`${clip.id}: ${timing.reason}`);
    result.push(timing.timing);
  }
  return result;
}

/** Revalidate immutable local bytes immediately before the existing export runner reads them. */
export async function validatePlacedPerformanceBytes(store: WorldStore, production: ProductionBundle): Promise<void> {
  if (production.timeline?.status !== "ready") return;
  const seen=new Set<string>();
  for (const track of production.timeline.timeline.tracks) for (const clip of track.clips) {
    if (clip.source.kind !== "performance" || seen.has(clip.source.performanceId)) continue;
    const source=clip.source; seen.add(source.performanceId);
    const performance=await readPerformance(store,production.meta.id,source.performanceId);
    const bytes=await readAudioBytes(await audioWorldPath(store.dir,`productions/${production.meta.id}/performances/${performance.id}/${performance.file}`),store.closingSignal);
    if (audioHash(bytes)!==source.sourceHash || source.sourceHash!==performance.provenance.outputHash) throw new Error(`${performance.id}: immutable performance media changed; export refused.`);
  }
}

/** Duration suggestions enter the existing scene JSON proposal/rebase path, never direct authorship. */
export async function proposePerformanceDuration(store: WorldStore, request: Extract<ClientMessage,{kind:"propose-performance-duration"}>) {
  const production=store.getBundle().productions.find(p=>p.meta.id===request.productionId);
  const performance=await readPerformance(store,request.productionId,request.performanceId);
  const scene=production?.scenes.find(s=>s.id===performance.target.sceneId);
  const stem=production?.sceneFiles[performance.target.sceneId];
  if (!production || !scene || !stem || scene.version!==request.expectedSceneVersion || !currentPerformanceTarget(store,performance.target)) throw new Error("The authored line changed. Review the current scene before proposing timing.");
  const slot=dialogueSlots(production).find(s=>s.shotId===performance.target.shotId);
  if (slot && slot.source!=="shot-duration") throw new Error("This shot has an operational picture slot. Edit that slot on the timeline; authored fallback does not change anchored picture.");
  const path=`productions/${request.productionId}/scenes/${stem}.json`;
  const raw=await readFile(await audioWorldPath(store.dir,path),"utf8");
  const record=SceneRecordSchema.parse(JSON.parse(raw));
  if (record.version!==request.expectedSceneVersion) throw new Error("The scene changed before this proposal could be prepared.");
  const shot=orderedShots(record).find(s=>s.id===performance.target.shotId);
  if (!shot) throw new Error("The shot no longer exists.");
  const calculated=calculateDialogueTiming({shotId:shot.id,startSec:0,endSec:resolvedAuthoredDuration(shot),source:"shot-duration"},performance.provenance.outputTechnical.durationSec,request.leadInSec,request.timing);
  if (!calculated.ok) throw new Error(calculated.reason);
  const durationSec=calculated.timing.requiredMinimumSec;
  if (durationSec===resolvedAuthoredDuration(shot)) throw new Error("The authored duration already fits this performance and handle exactly.");
  const retimed=shot.staging ? stagingRetimed(shot.staging,durationSec) : undefined;
  const next=editShot(record,{shotId:shot.id,change:{durationSec,...(retimed ? {staging:{...retimed,version:retimed.version+1}} : {})}});
  return new ProposalManager(store).stage({kind:"scene-edit",summary:`Set ${shot.id} to ${durationSec}s for reviewed dialogue timing`,source:"performance-timing",production:request.productionId,
    targets:[{path,content:JSON.stringify(next,null,2)+"\n",expectedBaseHash:sha256(raw)}]});
}
