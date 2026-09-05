import { readFile } from "node:fs/promises";
import { PerformanceReviewDecisionSchema, PerformanceSelectionsSchema, performanceLineKey, type ClientMessage } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { sha256 } from "../world/text-files.js";
import { readPerformance, currentPerformanceTarget } from "./performances.js";
import { audioWorldPath } from "./storage.js";
import { readAudioBytes } from "./media-tools.js";
import { audioHash } from "./qc.js";

/** Review and line selection share one existing commit transaction; neither edits picture selection. */
export async function reviewPerformance(store: WorldStore, request: Extract<ClientMessage, { kind: "review-performance" }>) {
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
    if (reviewHash !== request.expectedReviewHash || selectionHash !== request.expectedSelectionHash) throw new Error("Performance review changed. Refresh before choosing again.");
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
