import { relative } from "node:path";
import type { BenchSession, BenchTake } from "@arke-studio/contracts";
import { acceptMainPhoto } from "../references/main-photo.js";
import { acceptCharacterSheet, chooseAnchor } from "../references/kit.js";
import { recordUploadedCharacterSheetTake, recordUploadedMainPhotoTake, referenceReviewDecision } from "../references/takes.js";
import { readContainedImageReferences } from "../world/reference-files.js";
import { sha256 } from "../world/text-files.js";
import type { WorldStore } from "../world/store.js";
import { benchTakeMediaPath, readBenchSession } from "./chat-reads.js";

/** An explicit kit selection copies verified saved bytes; it never dispatches generation. */
export async function applyBenchCharacterImage(store: WorldStore, session: BenchSession, take: BenchTake,
  sheetId: string, kind: "main-photo" | "character-sheet", requestId: string, unavailable: () => string | null): Promise<void> {
  const sheet = store.getBundle().sheets.find(sheet => sheet.id === sheetId);
  if (!sheet || sheet.type !== "character" || sheet.retired || sheet.neverDepicted) throw new Error("That character is unavailable for pictures.");
  if (take.request.mode !== "image" || take.status !== "succeeded" || !take.media || take.disposition === "discarded") throw new Error("Choose a completed image take.");
  const precondition = () => {
    const reason = unavailable();
    if (reason) return reason;
    const current = store.getBundle().sheets.find(candidate => candidate.id === sheetId);
    if (!current || current.type !== "character" || current.retired || current.neverDepicted || current.version !== sheet.version) return "That character changed. Choose the image again.";
    const source = readBenchSession(store.dir, session.id)?.takes.find(candidate => candidate.id === take.id);
    return source?.status === "succeeded" && source.disposition !== "discarded" && source.media?.hash === take.media!.hash
      ? null : "That saved Bench image is no longer available.";
  };
  const stale = precondition();
  if (stale) throw new Error(stale);
  const identity = `bench-kit:${requestId}`;
  let copied = store.getBundle().referenceTakes.find(candidate => candidate.params["requestId"] === identity);
  if (copied && (copied.reference?.sheetId !== sheetId || copied.kind !== (kind === "main-photo" ? "main-photo" : "sheet") || copied.params["benchSessionId"] !== session.id || copied.params["benchTakeId"] !== take.id)) throw new Error("That image selection changed. Choose it again.");
  // A repeated acknowledgement must not undo a later deliberate kit selection.
  if (copied && store.getBundle().referenceReviews.some(review => review.takeId === copied!.id && review.decision === "accept")) return;
  if (!copied) {
    const file = relative(store.dir, benchTakeMediaPath(store.dir, session.id, take)).replace(/\\/g, "/");
    const image = (await readContainedImageReferences(store.dir, [file]))[0]!;
    // Bench finalization records a 16-digit digest prefix; imports may retain the full digest.
    if (sha256(image.data).slice(0, take.media.hash.length) !== take.media.hash) throw new Error("The saved Bench image changed. Choose it again.");
    const record = kind === "main-photo" ? recordUploadedMainPhotoTake : recordUploadedCharacterSheetTake;
    copied = await record(store, sheetId, take.media.file, image.data, { requestId: identity, precondition,
      source: { provider: take.request.provider, model: take.request.model, ...(take.jobId ? { jobId: take.jobId } : {}),
        prompt: take.request.brief, params: { ...take.request.params, benchSessionId: session.id, benchTakeId: take.id, benchReferences: take.request.references },
        cost: take.cost ?? { estimatedMicroUsd: 0, actualMicroUsd: null }, dispatchedAt: take.createdAt } });
  }
  if (kind === "main-photo") {
    const result = await acceptMainPhoto(store, sheet, store.getBundle(), { source: "take", takeId: copied.id }, null,
      { commitAnchor: (owned, id, input) => chooseAnchor(owned, id, input, { precondition }) });
    if (result.status === "failed") throw new Error(result.error);
  } else {
    await acceptCharacterSheet(store, sheet, { file: `takes/${copied.id}/${copied.media}`, takeId: copied.id,
      sheetVersion: sheet.version, artDirectionVersion: copied.provenance.artDirectionVersion ?? store.getBundle().artDirection.version,
      review: referenceReviewDecision(store.now(), copied, "accept") }, { precondition });
  }
}
