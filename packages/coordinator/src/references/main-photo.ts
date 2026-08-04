import { basename, join } from "node:path";
import { rm, stat } from "node:fs/promises";
import type { ReviewDecision, Sheet, Take, WorldBundle } from "@arke-studio/contracts";
import { toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { chooseAnchor } from "./kit.js";
import { pendingReferenceTake, recordUploadedReferenceTake, referenceReviewDecision } from "./takes.js";

export type MainPhotoAcceptanceStage =
  | "candidate-validation"
  | "take-recording"
  | "kit-commit"
  | "candidate-cleanup";

export type MainPhotoSelection =
  | { source: "take"; takeId: Take["id"] }
  | { source: "candidate"; file: string };

export type MainPhotoAcceptanceResult =
  | { status: "accepted"; candidateRetained: boolean; cleanupError?: string }
  | { status: "failed"; stage: Exclude<MainPhotoAcceptanceStage, "candidate-cleanup">; candidateRetained: boolean; error: string };

export interface MainPhotoAcceptanceDeps {
  recordUpload?: typeof recordUploadedReferenceTake;
  commitAnchor?: (
    store: WorldStore,
    sheetId: string,
    input: {
      file: string;
      jobId?: Take["jobId"];
      takeId: Take["id"];
      sheetVersion: number;
      artDirectionVersion: number;
      source: "generated" | "upload";
      acceptedAt: string;
      review: ReviewDecision;
    },
  ) => Promise<void>;
  removeCandidate?: (path: string) => Promise<void>;
}

export function mainPhotoFailureReason(stage: Exclude<MainPhotoAcceptanceStage, "candidate-cleanup">): string {
  if (stage === "take-recording") {
    return "The main photo was not changed because its permanent copy could not be made. The candidate is still here; try again.";
  }
  return "The main photo was not changed. The candidate is still here; try again.";
}

/** Safe operational context only: never accepts raw errors, paths, prompts, or provider payloads. */
export function mainPhotoLogRecord(
  worldId: string,
  sheetId: string,
  stage: MainPhotoAcceptanceStage,
  source: "upload" | "generated",
): Record<string, unknown> {
  return {
    kind: stage === "candidate-cleanup" ? "main-photo.cleanup-failed" : "main-photo.accept-failed",
    worldId,
    sheetId,
    stage,
    source,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function mediaExists(store: WorldStore, sheetId: string, take: Take): Promise<boolean> {
  if (!take.media || basename(take.media) !== take.media) return false;
  const path = join(store.dir, "references", sheetId, "takes", take.id, take.media);
  return (await stat(toExtendedLength(path)).catch(() => null))?.isFile() === true;
}

/** Candidate -> immutable take -> atomic kit/review commit -> best-effort staging cleanup. */
export async function acceptMainPhoto(
  store: WorldStore,
  sheet: Sheet,
  bundle: WorldBundle,
  selection: MainPhotoSelection,
  sourceCandidatePath: string | null = null,
  deps: MainPhotoAcceptanceDeps = {},
): Promise<MainPhotoAcceptanceResult> {
  const recordUpload = deps.recordUpload ?? recordUploadedReferenceTake;
  const commitAnchor = deps.commitAnchor ?? chooseAnchor;
  const removeCandidate = deps.removeCandidate ?? ((path) => rm(toExtendedLength(path)));
  let take: Take | null = null;
  let candidatePath: string | null = sourceCandidatePath;

  if (selection.source === "take") {
    take = pendingReferenceTake(bundle.referenceTakes, bundle.referenceReviews, selection.takeId, sheet.id, "main-photo");
    if (!take || !(await mediaExists(store, sheet.id, take))) {
      return {
        status: "failed",
        stage: "candidate-validation",
        candidateRetained: true,
        error: "the selected main-photo take is unavailable or already decided",
      };
    }
  } else {
    candidatePath = `references/${sheet.id}/candidates/${selection.file}`;
    if (!(bundle.referenceCandidates[sheet.id] ?? []).includes(candidatePath)) {
      return {
        status: "failed",
        stage: "candidate-validation",
        candidateRetained: true,
        error: "the selected candidate is no longer available",
      };
    }
    try {
      take = await recordUpload(store, sheet.id, candidatePath);
    } catch (err) {
      return { status: "failed", stage: "take-recording", candidateRetained: true, error: message(err) };
    }
    if (!(await mediaExists(store, sheet.id, take))) {
      return {
        status: "failed",
        stage: "take-recording",
        candidateRetained: true,
        error: "the immutable take was not written",
      };
    }
  }

  try {
    await commitAnchor(store, sheet.id, {
      file: `takes/${take.id}/${take.media}`,
      ...(take.jobId ? { jobId: take.jobId } : {}),
      takeId: take.id,
      sheetVersion: sheet.version,
      artDirectionVersion: take.provenance.artDirectionVersion ?? bundle.artDirection.version,
      source: take.provider === "user" ? "upload" : "generated",
      acceptedAt: store.now(),
      review: referenceReviewDecision(store.now(), take, "accept"),
    });
  } catch (err) {
    return { status: "failed", stage: "kit-commit", candidateRetained: candidatePath !== null, error: message(err) };
  }

  if (candidatePath) {
    try {
      await removeCandidate(join(store.dir, candidatePath));
    } catch (err) {
      return { status: "accepted", candidateRetained: true, cleanupError: message(err) };
    }
  }
  return { status: "accepted", candidateRetained: false };
}
