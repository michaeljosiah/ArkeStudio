import { readFile } from "node:fs/promises";
import { PerformanceReviewDecisionSchema, PerformanceSelectionsSchema, performanceLineKey, type ClientMessage, type PerformanceRecord } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { sha256 } from "../world/text-files.js";
import { applySceneCommand, SceneVersionMoved } from "../productions/scene-commands.js";
import { readPerformance, currentPerformanceTarget } from "./performances.js";
import { audioWorldPath } from "./storage.js";
import { readAudioBytes } from "./media-tools.js";
import { audioHash } from "./qc.js";

/**
 * Keep selects (SPEC-044 R-15): after a recording is kept, accept it, select it for its line and
 * make it the character's voice for the scene, in that order under Keep's request id. A step
 * that fails leaves what landed before it — the record is never removed, nothing is retried
 * against a version that moved — and names itself to the caller.
 */
export async function selectKeptPerformance(store: WorldStore, record: PerformanceRecord,
  request: Extract<ClientMessage, { kind: "keep-performance-recording" }>): Promise<void> {
  const production = store.getBundle().productions.find(p => p.meta.id === request.productionId);
  const sceneFile = production?.sceneFiles[request.sceneId];
  const scene = production?.scenes.find(s => s.id === request.sceneId);
  if (!production || !sceneFile || !scene) throw new Error("The scene is no longer available.");
  const speaker = record.target.speakerSheetId;
  const voice = { kind: "performance" as const, performanceId: record.id, hash: record.provenance.outputHash };
  // A redelivered Keep finds its own choice standing and is done: the record and the accept are
  // idempotent by request id, but the cast write moved the version this request was fenced
  // against, so retrying it would refuse a choice that already holds.
  if (JSON.stringify(scene.cast?.[speaker]?.voice) === JSON.stringify(voice)) return;
  // Fenced before anything lands (T-6): the only other check sits inside the cast write, and a
  // scene that moved between Keep and here would otherwise leave the read accepted and selected
  // for a line whose cast does not use it, while the caller reports it was not chosen.
  if (scene.version !== request.expectedSceneVersion) throw new SceneVersionMoved(request.expectedSceneVersion, scene.version);
  await acceptKeptPerformance(store, { requestId: request.requestId, worldId: request.worldId, productionId: request.productionId, performanceId: record.id });
  await applySceneCommand(store, { productionId: request.productionId, sceneFile, sceneId: request.sceneId, baseVersion: request.expectedSceneVersion,
    command: { kind: "edit-scene", cast: { [speaker]: { ...scene.cast?.[speaker], voice } } } });
}

/** Review and line selection share one existing commit transaction; neither edits picture selection. */
export async function reviewPerformance(store: WorldStore, request: Extract<ClientMessage, { kind: "review-performance" }>) {
  return review(store, request, true);
}

/**
 * Keep selects (SPEC-044 R-15): the accept and the selection a Keep composes, under Keep's own
 * request id. Keep is a fresh operation with nothing to fence against, so the review-history
 * hashes are not checked; the journal's idempotency by request id still holds.
 */
export async function acceptKeptPerformance(store: WorldStore, input: { requestId: string; worldId: string; productionId: string; performanceId: string }) {
  return review(store, { kind: "review-performance", requestId: input.requestId, worldId: input.worldId, productionId: input.productionId,
    performanceId: input.performanceId, decision: "accept", expectedReviewHash: null, expectedSelectionHash: null }, false);
}

async function review(store: WorldStore, request: Extract<ClientMessage, { kind: "review-performance" }>, fenced: boolean) {
  return store.gateOp(async () => {
    const performance = await readPerformance(store, request.productionId, request.performanceId);
    const reviewPath = `productions/${request.productionId}/performance-reviews.jsonl`;
    const selectionPath = `productions/${request.productionId}/performance-selections.json`;
    const read = async (path: string) => readFile(await audioWorldPath(store.dir, path, true), "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error;
    });
    const rawReviews = await read(reviewPath), rawSelections = await read(selectionPath);
    if (rawReviews && !rawReviews.endsWith("\n")) throw new Error("Performance review history needs repair.");
    const reviews = (rawReviews ?? "").split("\n").filter(Boolean).map(line => PerformanceReviewDecisionSchema.parse(JSON.parse(line)));
    const prior = reviews.find(r => r.requestId === request.requestId);
    if (prior) {
      if (prior.performanceId !== request.performanceId || prior.decision !== request.decision) throw new Error("Review request identity changed.");
      return;
    }
    const reviewHash = rawReviews === null ? null : sha256(rawReviews), selectionHash = rawSelections === null ? null : sha256(rawSelections);
    if (fenced && (reviewHash !== request.expectedReviewHash || selectionHash !== request.expectedSelectionHash)) throw new Error("Performance review changed. Refresh before choosing again.");
    const selections = PerformanceSelectionsSchema.parse(JSON.parse(rawSelections ?? "{}"));
    if (request.decision === "accept") {
      if (!currentPerformanceTarget(store, performance.target)) throw new Error("This performance was made for an earlier authored line. Generate a current performance before selecting it.");
      if (performance.kind !== "scratch") {
        const voice = store.getBundle().sheets.find(s => s.id === performance.target.speakerSheetId)?.voice;
        const frozen = performance.voiceAssignment;
        if (!voice || voice.provider !== frozen.provider || voice.voiceId !== frozen.voiceId || voice.assignedAtVersion !== frozen.assignedAtVersion || voice.model !== frozen.model) throw new Error("This performance uses an earlier voice assignment.");
      }
      const bytes = await readAudioBytes(await audioWorldPath(store.dir, `productions/${request.productionId}/performances/${performance.id}/${performance.file}`), store.closingSignal);
      if (audioHash(bytes) !== performance.provenance.outputHash) throw new Error("Performance audio changed. Selection refused.");
      selections[performanceLineKey(performance.target)] = { performanceId: performance.id, target: performance.target, selectedAt: store.now(), selectedBy: "user" };
    }
    const decision = PerformanceReviewDecisionSchema.parse({ requestId: request.requestId, ts: store.now(), performanceId: performance.id,
      target: performance.target, decision: request.decision, by: "user", ...(request.note ? { note: request.note } : {}) });
    await store.commitUnserialised({ kind: "review-performance", source: "user", requestId: request.requestId, files: [
      { path: reviewPath, action: rawReviews === null ? "create" : "replace", baseHash: reviewHash, content: (rawReviews ?? "") + JSON.stringify(decision) + "\n" },
      ...(request.decision === "accept" ? [{ path: selectionPath, action: rawSelections === null ? "create" as const : "replace" as const,
        baseHash: selectionHash, content: JSON.stringify(selections, null, 2) + "\n" }] : []),
    ] });
  });
}

/** Clearing repairs a broken selection without requiring its missing performance bytes. */
export async function clearPerformanceSelection(store: WorldStore, request: Extract<ClientMessage, { kind: "clear-performance-selection" }>) {
  return store.gateOp(async () => {
    if (!store.getBundle().productions.some(p => p.meta.id === request.productionId)) throw new Error("This production is unavailable.");
    const path = `productions/${request.productionId}/performance-selections.json`;
    const raw = await readFile(await audioWorldPath(store.dir, path, true), "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error;
    });
    const selections = PerformanceSelectionsSchema.parse(JSON.parse(raw ?? "{}"));
    const selection = selections[request.lineKey];
    if (!selection?.performanceId) return;
    if (sha256(raw!) !== request.expectedSelectionHash) throw new Error("Performance selection changed. Refresh before clearing it.");
    selections[request.lineKey] = { ...selection, performanceId: null, selectedAt: store.now(), selectedBy: "user" };
    await store.commitUnserialised({ kind: "clear-performance-selection", source: "user", requestId: request.requestId,
      files: [{ path, action: "replace", baseHash: request.expectedSelectionHash, content: JSON.stringify(selections, null, 2) + "\n" }] });
  });
}
