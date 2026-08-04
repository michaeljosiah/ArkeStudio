import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ulid, type Job, type ReviewDecision, type Take } from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";
import type { WorldStore } from "../world/store.js";

function kindFor(job: Job): Take["kind"] | null {
  if (job.target.kind === "main-photo-candidate" || job.target.kind === "establish-candidate") return "main-photo";
  if (job.target.kind === "character-sheet") return "sheet";
  if (job.target.kind === "character-look") return "look";
  return null;
}

export async function recordReferenceTake(store: WorldStore, job: Job): Promise<Take | null> {
  const kind = kindFor(job);
  const landed = job.landedFiles?.[0];
  const sheetId = job.target.id?.split("/")[0];
  if (!kind || !landed || !sheetId) return null;
  const existing = store.getBundle().referenceTakes.find((take) => take.jobId === job.id);
  if (existing) return existing;
  const frozen = job.params["provenance"] as
    | { canonRevision?: number; sheets?: Record<string, number>; artDirectionVersion?: number; anchorFile?: string }
    | undefined;
  const sheetVersion = frozen?.sheets?.[sheetId];
  if (frozen?.canonRevision === undefined || sheetVersion === undefined) return null;
  const id = `tk_${ulid()}` as Take["id"];
  const media = basename(landed);
  const artDirection = job.params["artDirection"] as { version?: number } | undefined;
  const take: Take = {
    id,
    jobId: job.id,
    coversShots: [],
    kind,
    reference: { sheetId },
    provider: job.provider,
    model: job.model,
    provenance: {
      canonRevision: frozen.canonRevision,
      sheets: { [sheetId]: sheetVersion },
      ...(frozen.artDirectionVersion ?? artDirection?.version
        ? { artDirectionVersion: frozen.artDirectionVersion ?? artDirection!.version }
        : {}),
    },
    ...(typeof job.params["prompt"] === "string" ? { prompt: job.params["prompt"] as string } : {}),
    references: (job.params["references"] as string[] | undefined) ?? [],
    params: {
      ...job.params,
      ...(kind === "main-photo" && landed.startsWith(`references/${sheetId}/candidates/`)
        ? { sourceCandidate: landed }
        : {}),
    },
    cost: { estimatedMicroUsd: job.estimatedMicroUsd, actualMicroUsd: null },
    dispatchedAt: job.createdAt,
    completedAt: store.now(),
    media,
  };
  await store.gateOp(async () => {
    const dir = join(store.dir, "references", sheetId, "takes", id);
    await mkdir(toExtendedLength(dir), { recursive: true });
    await copyFile(toExtendedLength(join(store.dir, landed)), toExtendedLength(join(dir, media)));
    await atomicWriteFile(join(dir, "take.json"), JSON.stringify(take, null, 2) + "\n");
  });
  return take;
}

/** Resolve one undecided reference take by durable identity, never by its non-unique media name. */
export function pendingReferenceTake(
  takes: readonly Take[],
  reviews: readonly ReviewDecision[],
  takeId: Take["id"],
  sheetId: string,
  kind: "main-photo" | "sheet" | "look",
): Take | null {
  const take = takes.find(
    (candidate) => candidate.id === takeId && candidate.kind === kind && candidate.reference?.sheetId === sheetId,
  );
  if (!take || reviews.some((review) => review.takeId === take.id)) return null;
  return take;
}

export async function recordUploadedReferenceTake(
  store: WorldStore,
  sheetId: string,
  candidatePath: string,
): Promise<Take> {
  const existing = store
    .getBundle()
    .referenceTakes.find(
      (take) =>
        take.kind === "main-photo" &&
        take.reference?.sheetId === sheetId &&
        take.provider === "user" &&
        take.params["uploadedCandidate"] === candidatePath,
    );
  if (existing) return existing;
  const sheet = store.getBundle().sheets.find((candidate) => candidate.id === sheetId);
  if (!sheet) throw new Error(`no sheet ${sheetId}`);
  const id = `tk_${ulid()}` as Take["id"];
  const media = basename(candidatePath);
  const now = store.now();
  const take: Take = {
    id,
    coversShots: [],
    kind: "main-photo",
    reference: { sheetId },
    provider: "user",
    model: "upload",
    provenance: {
      canonRevision: store.getBundle().meta.canonRevision,
      sheets: { [sheetId]: sheet.version },
      artDirectionVersion: store.getBundle().artDirection.version,
    },
    references: [],
    params: { uploadedCandidate: candidatePath },
    cost: { estimatedMicroUsd: 0, actualMicroUsd: 0, actualSource: "local-zero" },
    dispatchedAt: now,
    completedAt: now,
    media,
  };
  await store.gateOp(async () => {
    const dir = join(store.dir, "references", sheetId, "takes", id);
    await mkdir(toExtendedLength(dir), { recursive: true });
    await copyFile(toExtendedLength(join(store.dir, candidatePath)), toExtendedLength(join(dir, media)));
    await atomicWriteFile(join(dir, "take.json"), JSON.stringify(take, null, 2) + "\n");
  });
  return take;
}

export async function recordReferenceReview(
  store: WorldStore,
  take: Take,
  decision: "accept" | "reject",
  input: { field?: string; note?: string } = {},
): Promise<ReviewDecision> {
  const review = referenceReviewDecision(store.now(), take, decision, input);
  const path = "references/reviews.jsonl";
  let raw = "";
  let existed = false;
  try {
    raw = await readFile(toExtendedLength(join(store.dir, path)), "utf8");
    existed = true;
  } catch {
    /* first review */
  }
  await store.commit({
    kind: "reference-review",
    source: "review:user",
    files: [
      {
        path,
        action: existed ? "replace" : "create",
        content: raw + JSON.stringify(review) + "\n",
        baseHash: existed ? sha256(raw) : null,
      },
    ],
  });
  return review;
}

export function referenceReviewDecision(
  now: string,
  take: Take,
  decision: "accept" | "reject",
  input: { field?: string; note?: string } = {},
): ReviewDecision {
  if (!take.reference) throw new Error(`${take.id} is not a reference take`);
  const review: ReviewDecision = {
    ts: now,
    takeId: take.id,
    decision,
    by: "user",
    ...(decision === "reject"
      ? {
          citation: {
            sheet: take.reference.sheetId,
            field: input.field ?? "identity",
            ...(input.note ? { note: input.note } : {}),
          },
        }
      : {}),
  };
  return review;
}
