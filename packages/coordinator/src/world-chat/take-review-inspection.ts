import { createHash } from "node:crypto";
import type { ConversationActionPrepareIntent, ProductionBundle, Take } from "@arke-studio/contracts";
import { readContainedMediaBytes, hashContainedProductionMedia } from "../world/reference-files.js";
import type { WorldStore } from "../world/store.js";
import { productionTakeImageSource } from "./production-take-images.js";
import { agentMediaSource } from "./media-inspection.js";
import { conversationDir, WorldChatStore } from "./store.js";

/** A prepared handoff alone is insufficient: only this completed turn's served reads count. */
export async function takeReviewInspectionReason(store: WorldStore, intent: ConversationActionPrepareIntent, production: ProductionBundle, take: Take) {
  const journal = await new WorldChatStore(conversationDir(store.dir, intent.conversationId)).read();
  const completion = journal.problems.length === 0 ? journal.events.findLast(({ event }) =>
    event.type === "turn.completed" && event.run.turnId === intent.turnId &&
    event.actionPrepareIntents?.some(prepared => prepared.actionId === intent.actionId))?.event : undefined;
  const receipts = completion?.type === "turn.completed" ? completion.receipts.filter(receipt =>
    receipt.status === "complete" && receipt.runId === completion.run.id) : [];
  const verifiedMedia = [];
  try {
    const source = await agentMediaSource(store, { kind: "production-take", productionId: production.meta.id, takeId: take.id });
    const current = await hashContainedProductionMedia(store.dir, source.path, source.expectedHash, store.closingSignal);
    for (const receipt of receipts) {
      const media = receipt.media;
      if (media?.source.kind === "production-take" && media.source.productionId === production.meta.id && media.source.takeId === take.id &&
        media.sourceHash === current.sourceHash && media.sourceStartSec === source.startSec && (source.endSec === null || media.sourceEndSec === source.endSec)) verifiedMedia.push(media);
    }
  } catch { /* Hashless, changed or missing media cannot establish inspected evidence. */ }
  const supplied = async (frame: "poster" | "start-frame") => {
    try {
      const source = productionTakeImageSource(store.getBundle(), { kind: "production-take", productionId: production.meta.id, takeId: take.id, frame });
      const receipt = receipts.find(receipt => receipt.image?.id === source.id && receipt.image.posterOnly === source.video);
      if (!receipt?.image) return false;
      const hash = source.video ? (await hashContainedProductionMedia(store.dir, source.path, source.expected, store.closingSignal)).sourceHash
        : `sha256:${createHash("sha256").update(await readContainedMediaBytes(store.dir, source.path, store.closingSignal)).digest("hex")}`;
      return hash === receipt.image.sourceHash && (!source.expected || hash.startsWith(source.expected));
    } catch { return false; }
  };
  const poster = await supplied("poster"), start = await supplied("start-frame");
  if (verifiedMedia.some(media => media.frames || media.audio || media.transcript)) {
    const frames = new Map(verifiedMedia.flatMap(media => (media.frames ?? []).map(frame => [
      `${media.sourceHash}:${frame.streamIndex}:${frame.sourceTimeSec}:${frame.image.renditionHash}`, frame] as const))), audio = verifiedMedia.filter(media => media.audio);
    const speech = verifiedMedia.some(media => media.transcript);
    return `${frames.size ? `${frames.size} unique timestamped still frames supplied; gaps between frames remain unreviewed. ` : "No take frames were supplied. "}${audio.length ? "Original-channel audio sample measurements supplied; no listening or performance judgment. " : speech ? "Original-channel audio signal was not measured. " : "Audio was not inspected. "}${speech ? "Local automatic speech transcript supplied; content interpretation is transcript-grounded. Music, voice quality, emotion and delivery were not reviewed. " : ""}Continuous motion and audiovisual sync were not reviewed.${start ? " Frozen start frame supplied." : " Frozen start frame was not inspected."}`;
  }
  if (!poster && !start) return "Metadata-only review; no current take image or poster was supplied to this turn. Audio was not inspected.";
  const source = poster ? `${take.kind === "clip" ? "Poster frame" : "Take image"}${start ? " and frozen start frame" : ""}` : "Frozen start frame only";
  const omissions = `${!poster ? "The take image was not inspected. " : ""}${take.kind === "clip" ? "Video motion and audio were not inspected." : "Audio was not inspected."}`;
  return `${source} supplied for this review. ${omissions}${take.startFrame && !start ? " The frozen start frame was not inspected." : ""}`;
}
