import { copyFile, mkdir, readFile, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ulid, type Job, type LedgerEntry, type ReviewDecision, type Take } from "@arke-studio/contracts";
import { atomicWriteFile, renameWithRetry } from "../world/atomic.js";
import { toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";
import type { WorldStore } from "../world/store.js";

/**
 * Put the take's own copy in place, once (issue 231).
 *
 * Idempotent because finalization is replayable: a retry from Activity, and the main-photo
 * accept path's own recovery call, both re-enter this with the take already written. Copying
 * again would fail once the staging copy is gone, stranding a row whose media is already there.
 *
 * The copy stages and renames, like every other write here (SPEC-002 R-13), and that is what
 * makes the skip safe: a destination that exists is a destination that was renamed into place,
 * so it is whole. Copying straight to the target would leave a partial file behind if the
 * process died mid-write — and the next pass would take that partial file for a finished one,
 * skip the copy, then delete the intact staging source. That is a corrupt take, from a crash
 * the old copy-every-time code survived.
 */
async function placeMedia(from: string, to: string): Promise<void> {
  const already = await stat(toExtendedLength(to)).then(
    (s) => s.isFile(),
    () => false,
  );
  if (already) return;
  const tmp = join(dirname(to), `.tmp-${ulid()}`);
  await copyFile(toExtendedLength(from), toExtendedLength(tmp));
  try {
    await renameWithRetry(tmp, to);
  } catch (err) {
    await rm(toExtendedLength(tmp), { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * The two directories reference generation actually lands in, for one sheet. Named in full
 * rather than sniffed for a path segment: a sheet called "Incoming" slugs to `incoming`, and a
 * check for *any* segment of that name would match `references/incoming/candidates/…` and
 * delete the candidate the user is still choosing from.
 */
function stagingDirsFor(sheetId: string): string[] {
  return [`references/${sheetId}/incoming`, `references/${sheetId}/looks/incoming`];
}

/**
 * Drop the staging copy now that the take owns the bytes (issue 231).
 *
 * Production takes have always moved their media into the take directory — "one stored
 * artifact (R-3)". Reference takes copied and left the original, so every generated image was
 * stored twice: one short session left ten orphaned PNGs, 22 MB of them under one character's
 * `looks/incoming/`. A world folder is meant to be read by hand, and it showed each image twice
 * with nothing to say which one mattered.
 *
 * Only a *staging* path is dropped, which is the whole safety argument. `candidates/` is not
 * staging — the main-photo accept path reads the chosen candidate back out of it, and the scan
 * lists the ones nobody promoted. A reference-tile's kit row points into `incoming/` and is not
 * a take at all, so it never reaches this function. Deleting after take.json is written, rather
 * than moving before it, means the worst a crash can do is leave the duplicate we had before.
 */
async function discardStagingCopy(worldDir: string, sheetId: string, landed: string): Promise<void> {
  const path = landed.replace(/\\/g, "/");
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (!stagingDirsFor(sheetId).includes(dir)) return;
  await rm(toExtendedLength(join(worldDir, path)), { force: true }).catch(() => {});
  // And the staging directory itself when it empties. rmdir refuses a non-empty one, so a
  // sibling still waiting to be finalized keeps it; the next landing re-creates it either way.
  await rmdir(toExtendedLength(join(worldDir, dir))).catch(() => {});
}

function kindFor(job: Job): Take["kind"] | null {
  if (job.target.kind === "main-photo-candidate" || job.target.kind === "establish-candidate") return "main-photo";
  if (job.target.kind === "character-sheet") return "sheet";
  if (job.target.kind === "character-look") return "look";
  return null;
}

export async function recordReferenceTake(store: WorldStore, job: Job, ledgerEntry?: LedgerEntry): Promise<Take | null> {
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
  const id = `tk_${job.id.slice(3)}` as Take["id"];
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
    cost: {
      estimatedMicroUsd: job.estimatedMicroUsd,
      actualMicroUsd: ledgerEntry?.actualMicroUsd ?? null,
      ...(ledgerEntry?.actualSource ? { actualSource: ledgerEntry.actualSource } : {}),
    },
    dispatchedAt: job.createdAt,
    completedAt: store.now(),
    media,
  };
  return store.gateOp(async () => {
    const duplicate = store.getBundle().referenceTakes.find((take) => take.jobId === job.id);
    if (duplicate) return duplicate;
    const dir = join(store.dir, "references", sheetId, "takes", id);
    await mkdir(toExtendedLength(dir), { recursive: true });
    await placeMedia(join(store.dir, landed), join(dir, media));
    await atomicWriteFile(join(dir, "take.json"), JSON.stringify(take, null, 2) + "\n");
    // Last, and only once the take is durable: until take.json exists the staging copy is the
    // only copy that anything can find.
    await discardStagingCopy(store.dir, sheetId, landed);
    return take;
  });
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
    // An upload keeps its candidate: the user put that file there, and `uploadedCandidate`
    // points back at it. Only a staging copy this code made is this code's to remove.
    await placeMedia(join(store.dir, candidatePath), join(dir, media));
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
