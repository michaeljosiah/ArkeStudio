import { readFile } from "node:fs/promises";
import { PerformanceBibleEventSchema, foldPerformanceBible, type ClientMessage } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { audioWorldPath } from "./storage.js";
import { readPerformance } from "./performances.js";
import { readAudioBytes } from "./media-tools.js";
import { appendAudioRights, readAudioRights } from "./rights.js";
import { clearAudioDispatch } from "./dispatch-gate.js";
import { sha256 } from "../world/text-files.js";

type Request = Extract<ClientMessage, { kind: "designate-performance-bible" | "clear-performance-bible" }>;
export async function writePerformanceBible(store: WorldStore, request: Request) {
  const acknowledgementId = `performance-bible/${request.requestId}`;
  const priorRight = (await readAudioRights(store)).find(event => event.action === "acknowledge" && event.id === acknowledgementId);
  const at = priorRight?.at ?? store.now();
  if (request.kind === "designate-performance-bible") await appendAudioRights(store, { schemaVersion: 1, action: "acknowledge", id: acknowledgementId,
    audioHash: request.expectedPerformanceHash, basis: request.cloudBasis, scopes: ["cloud-reference-upload"], statementVersion: 1, at });
  return store.gateOp(async () => {
    const sheet = store.getBundle().sheets.find(s => s.id === request.sheetId && s.type === "character" && !s.retired);
    if (!sheet) throw new Error("This character is unavailable.");
    const path = `references/${sheet.id}/performance-bible.jsonl`;
    const raw = await readFile(await audioWorldPath(store.dir, path, true), "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error;
    });
    if (raw && !raw.endsWith("\n")) throw new Error("Performance bible history needs repair.");
    const events = (raw ?? "").split("\n").filter(Boolean).map(line => PerformanceBibleEventSchema.parse(JSON.parse(line)));
    const previous = foldPerformanceBible(events).find(e => e.slotId === request.slotId);
    const revision = request.expectedRevision + 1;
    const desired = request.kind === "clear-performance-bible" ? { slotId: request.slotId, revision, action: "clear" as const } : {
      slotId: request.slotId, revision, action: "designate" as const, label: request.label, delivery: request.delivery, role: request.role,
      productionId: request.productionId, performanceId: request.performanceId, performanceHash: request.expectedPerformanceHash, acceptedReviewAt: request.acceptedReviewAt };
    if (previous?.revision === revision && JSON.stringify({ ...previous, at: undefined }) === JSON.stringify({ ...desired, at: undefined })) return;
    if ((raw === null ? null : sha256(raw)) !== request.expectedHash || (previous?.revision ?? 0) !== request.expectedRevision) throw new Error("Performance bible changed. Reload before repeating this action.");
    if (request.kind === "designate-performance-bible") {
      const performance = await readPerformance(store, request.productionId, request.performanceId);
      const accepted = store.getBundle().productions.find(p => p.meta.id === request.productionId)?.performanceReview.reviews.filter(r => r.performanceId === performance.id).at(-1);
      if (performance.target.speakerSheetId !== sheet.id || accepted?.decision !== "accept" || accepted.ts !== request.acceptedReviewAt || performance.provenance.outputHash !== request.expectedPerformanceHash) throw new Error("Choose a currently accepted performance for this character.");
      if (request.role !== "cadence") {
        if (performance.kind === "scratch") throw new Error("A scratch recording can demonstrate cadence only.");
        if (!sheet.voice || sheet.voice.provider !== performance.voiceAssignment.provider || sheet.voice.voiceId !== performance.voiceAssignment.voiceId || sheet.voice.assignedAtVersion !== performance.voiceAssignment.assignedAtVersion) throw new Error("Identity examples must use the character's current voice assignment.");
      }
      if (!request.singleSpeaker || !request.noMusic) throw new Error("Confirm the reference speaker and absence of music.");
      const bytes = await readAudioBytes(await audioWorldPath(store.dir, `productions/${request.productionId}/performances/${performance.id}/${performance.file}`), store.closingSignal);
      clearAudioDispatch({ bytes, hash: request.expectedPerformanceHash, report: performance.provenance.qualityReport, scope: "cloud-reference-upload",
        rights: await readAudioRights(store), acknowledgementId, statementVersion: 1, warningCodes: request.warningCodes,
        requiredAttestations: ["single-speaker", "no-music"], attestations: ["single-speaker", "no-music"].map(kind => ({
          kind: kind as "single-speaker" | "no-music", audioHash: request.expectedPerformanceHash, statementVersion: 1, acknowledgedAt: at })) });
    }
    const event = PerformanceBibleEventSchema.parse({ ...desired, at });
    await store.commitUnserialised({ kind: "write-performance-bible", source: "user", requestId: request.requestId,
      files: [{ path, action: raw === null ? "create" : "replace", baseHash: request.expectedHash, content: (raw ?? "") + JSON.stringify(event) + "\n" }] });
  });
}
