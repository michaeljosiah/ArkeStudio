import { createHash } from "node:crypto";
import type { ConversationActionPrepareIntent, ProductionBundle, Take } from "@arke-studio/contracts";
import { readContainedMediaBytes } from "../world/reference-files.js";
import type { WorldStore } from "../world/store.js";
import { productionTakeImageSource } from "./production-take-images.js";
import { conversationDir, WorldChatStore } from "./store.js";

/** A prepared handoff alone is insufficient: only this completed turn's served reads count. */
export async function takeReviewInspectionReason(store: WorldStore, intent: ConversationActionPrepareIntent, production: ProductionBundle, take: Take) {
  const journal = await new WorldChatStore(conversationDir(store.dir, intent.conversationId)).read();
  const completion = journal.problems.length === 0 ? journal.events.findLast(({ event }) =>
    event.type === "turn.completed" && event.run.turnId === intent.turnId &&
    event.actionPrepareIntents?.some(prepared => prepared.actionId === intent.actionId))?.event : undefined;
  const receipts = completion?.type === "turn.completed" ? completion.receipts.filter(receipt =>
    receipt.tool === "view-image" && receipt.status === "complete" && receipt.runId === completion.run.id) : [];
  const supplied = async (frame: "poster" | "start-frame") => {
    try {
      const source = productionTakeImageSource(store.getBundle(), { kind: "production-take", productionId: production.meta.id, takeId: take.id, frame });
      const receipt = receipts.find(receipt => receipt.image?.id === source.id && receipt.image.posterOnly === source.video);
      if (!receipt?.image) return false;
      const hash = `sha256:${createHash("sha256").update(await readContainedMediaBytes(store.dir, source.path)).digest("hex")}`;
      return hash === receipt.image.sourceHash && (!source.expected || hash.startsWith(source.expected));
    } catch { return false; }
  };
  const poster = await supplied("poster"), start = await supplied("start-frame");
  if (!poster && !start) return "Metadata-only review; no current take image or poster was supplied to this turn. Audio was not inspected.";
  const source = poster ? `${take.kind === "clip" ? "Poster frame" : "Take image"}${start ? " and frozen start frame" : ""}` : "Frozen start frame only";
  const omissions = `${!poster ? "The take image was not inspected. " : ""}${take.kind === "clip" ? "Video motion and audio were not inspected." : "Audio was not inspected."}`;
  return `${source} supplied for this review. ${omissions}${take.startFrame && !start ? " The frozen start frame was not inspected." : ""}`;
}
