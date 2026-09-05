import { readFile } from "node:fs/promises";
import { TakeDialogueFeedbackSchema, allowedDialogueFeedback, type ClientMessage } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { audioWorldPath } from "../audio/storage.js";
import { appendFlushed } from "../flushed-append.js";

export async function recordDialogueFeedback(store: WorldStore, request: Extract<ClientMessage, { kind: "record-dialogue-feedback" }>) {
  return store.ownedWrite(async () => {
    const production = store.getBundle().productions.find(p => p.meta.id === request.productionId);
    const take = production?.takes.find(t => t.id === request.takeId);
    if (!take || !take.coversShots.includes(request.shotId)) throw new Error("The take does not cover this shot.");
    const assessment = take.provenance.dialogueAssessments?.[request.shotId];
    const allowed = allowedDialogueFeedback(take, request.shotId);
    if (request.tags.some(tag => !allowed.includes(tag)) || request.recommendationIds.some(id => !assessment?.recommendations.some(r => r.id === id)))
      throw new Error("Feedback must match this take's frozen inputs and guidance.");
    const path = await audioWorldPath(store.dir, `productions/${request.productionId}/take-feedback.jsonl`, true);
    const raw = await readFile(path, "utf8").catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; });
    if (raw && !raw.endsWith("\n")) throw new Error("Feedback history needs repair before appending.");
    const records = raw.split("\n").filter(Boolean).map(line => TakeDialogueFeedbackSchema.parse(JSON.parse(line)));
    const previous = records.find(record => record.requestId === request.requestId);
    const record = TakeDialogueFeedbackSchema.parse({ schemaVersion: 1, kind: "dialogue-diagnostic", requestId: request.requestId,
      ts: previous?.ts ?? store.now(), takeId: request.takeId, shotId: request.shotId, tags: request.tags,
      recommendationIds: request.recommendationIds, note: request.note, by: "user" });
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(record)) throw new Error("Feedback request identity changed.");
      return;
    }
    await appendFlushed(path, `${JSON.stringify(record)}\n`);
  });
}
