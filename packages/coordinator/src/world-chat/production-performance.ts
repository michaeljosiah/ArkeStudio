import { type ArkeCommandBodySchema, type ModelWorldChatAction, type WorldChatPreparedAction, type ConversationActionCard } from "@arke-studio/contracts";
import type { z } from "zod";
import { calculateDialogueTiming, dialogueSlots, performanceLineKey, orderedShots, resolvedAuthoredDuration } from "@arke-studio/contracts";
import { currentPerformanceTarget } from "../audio/performances.js";
import { placeSelectedPerformance, proposePerformanceDuration } from "../audio/performance-placement.js";
import { clearPerformanceSelection } from "../audio/performance-review.js";
import { audioHash } from "../audio/qc.js";
import { audioWorldPath } from "../audio/storage.js";
import { readAudioBytes } from "../audio/media-tools.js";
import type { WorldStore } from "../world/store.js";
import type { ConversationActionExecutionOutcome } from "../arke-actions/lifecycle.js";

type Action = Extract<ModelWorldChatAction, { kind: "production-performance-command" }>;
type Prepared = Extract<WorldChatPreparedAction, { kind: "world-chat-production-performance-command" }>;
const digest = (value: unknown) => audioHash(Buffer.from(JSON.stringify(value)));
export function freezeProductionPerformance(store: WorldStore, action: Action): Prepared["frozen"] {
  const production = store.getBundle().productions.find(p => p.meta.id === action.productionId);
  if (!production) throw new Error("This production is unavailable.");
  const command = action.command;
  const performance = "performanceId" in command ? production.performances.find(p => p.id === command.performanceId) : undefined;
  if ("performanceId" in action.command && !performance) throw new Error("This performance is unavailable.");
  const scene = performance && production.scenes.find(s => s.id === performance.target.sceneId);
  const timeline = action.command.operation === "place-selected" && production.timeline?.status === "ready" ? production.timeline : null;
  if (action.command.operation === "place-selected" && (!timeline || !timeline.hash)) throw new Error("Assemble the production timeline before placing dialogue.");
  return { sceneVersion: scene?.version ?? null, selectionHash: production.performanceReview.selectionHash,
    reviewHash: production.performanceReview.reviewHash,
    timelineRevision: timeline?.timeline.revision ?? null, timelineHash: timeline?.hash ?? null,
    performanceHash: performance ? digest(performance) : null };
}
export async function productionPerformanceBody(store: WorldStore, prepared: Prepared): Promise<z.infer<typeof ArkeCommandBodySchema>> {
  if (JSON.stringify(freezeProductionPerformance(store, prepared.action)) !== JSON.stringify(prepared.frozen)) throw new Error("The performance, scene, timeline or selection changed. Prepare a fresh card.");
  const production = store.getBundle().productions.find(p => p.meta.id === prepared.action.productionId)!;
  const command = prepared.action.command;
  if ("performanceId" in command) {
    const performance = production.performances.find(p => p.id === command.performanceId)!;
    if (!currentPerformanceTarget(store, performance.target)) throw new Error("This performance targets an earlier authored line.");
    const latestReview = production.performanceReview.reviews.filter(review => review.performanceId === performance.id).at(-1);
    if (latestReview?.decision !== "accept") throw new Error("Audition and accept this performance before changing its timing.");
    if (performance.kind !== "scratch") {
      const current = store.getBundle().sheets.find(sheet => sheet.id === performance.target.speakerSheetId)?.voice;
      if (JSON.stringify(current) !== JSON.stringify(performance.voiceAssignment)) throw new Error("The speaking character's voice changed.");
    }
    if (command.operation === "place-selected" && production.performanceReview.selections[performanceLineKey(performance.target)]?.performanceId !== performance.id) throw new Error("Choose this performance for its line before placement.");
    const slots = dialogueSlots(production).filter(slot => slot.shotId === performance.target.shotId);
    const scene = production.scenes.find(value => value.id === performance.target.sceneId);
    const shot = scene && orderedShots(scene).find(value => value.id === performance.target.shotId);
    if (!shot || performance.provenance.outputTechnical.durationSec === null) throw new Error("The performance's timing is unavailable.");
    if (command.operation === "place-selected" && slots.length !== 1) throw new Error("Place the shot once on the picture track before dialogue placement.");
    if (command.operation === "propose-duration" && slots.some(slot => slot.source !== "shot-duration")) throw new Error("This picture has an operational slot. Edit its timeline timing instead.");
    const timing = calculateDialogueTiming(command.operation === "place-selected" ? slots[0]! : { shotId: shot.id, startSec: 0, endSec: resolvedAuthoredDuration(shot), source: "shot-duration" }, performance.provenance.outputTechnical.durationSec, command.leadInSec, command.timing);
    if (!timing.ok) throw new Error(timing.reason);
    const bytes = await readAudioBytes(await audioWorldPath(store.dir, `productions/${production.meta.id}/performances/${performance.id}/${performance.file}`), store.closingSignal);
    if (audioHash(bytes) !== performance.provenance.outputHash) throw new Error("The immutable performance audio changed.");
  }
  return { family: "command", commands: [{ label: command.operation,
    detail: command.operation === "clear-selection" ? command.lineKey : `${command.performanceId} · lead in ${command.leadInSec}s · ${JSON.stringify(command.timing)}` }],
    expectedResult: command.operation === "propose-duration" ? "A scene duration proposal for human review; the scene remains unchanged until accepted."
      : command.operation === "place-selected" ? "Place the reviewed, selected performance using the shown timing in one undoable timeline revision."
        : "Clear this line's performance selection; existing timeline audio remains unchanged.",
    undoAvailable: command.operation === "place-selected" };
}
export async function executeProductionPerformance(store: WorldStore, prepared: Prepared, card: ConversationActionCard): Promise<ConversationActionExecutionOutcome> {
  await productionPerformanceBody(store, prepared);
  const common = { worldId: store.worldId, requestId: card.actionId, productionId: prepared.action.productionId };
  const command = prepared.action.command;
  if (command.operation === "propose-duration") {
    const proposal = await proposePerformanceDuration(store, { ...common, ...command, kind: "propose-performance-duration", expectedSceneVersion: prepared.frozen.sceneVersion! },
      [{ conversationId: card.conversationId, requestId: card.actionId, candidateId: card.actionId, candidateRevision: 1,
        targetPaths: [], fields: ["durationSec"] }]);
    return { status: "completed", receipt: { kind: "proposal", id: proposal.id, summary: "Duration proposal staged for human review." } };
  }
  if (command.operation === "place-selected") await placeSelectedPerformance(store, { ...common, ...command, kind: "place-selected-performance",
    expectedTimelineRevision: prepared.frozen.timelineRevision!, expectedTimelineHash: prepared.frozen.timelineHash!, expectedSelectionHash: prepared.frozen.selectionHash });
  else await clearPerformanceSelection(store, { ...common, ...command, kind: "clear-performance-selection", expectedSelectionHash: prepared.frozen.selectionHash });
  return { status: "completed", receipt: { kind: "performance-command", id: card.actionId, summary: "The approved performance command completed." } };
}
