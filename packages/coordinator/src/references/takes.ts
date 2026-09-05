import { copyFile, mkdir, readFile, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ulid, type Job, type LedgerEntry, type ReviewDecision, type Take } from "@arke-studio/contracts";
import { atomicWriteFile, renameWithRetry, withTransientRetry } from "../world/atomic.js";
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
  // Through the shared backoff: this file was being read a moment ago, and a scanner still
  // holding it fails the unlink EPERM for an instant. Swallowing that on the first attempt
  // left the duplicate for good.
  await withTransientRetry(() => rm(toExtendedLength(join(worldDir, path)), { force: true })).catch(() => {});
  // And the staging directory itself when it empties. rmdir refuses a non-empty one, so a
  // sibling still waiting to be finalized keeps it; the next landing re-creates it either way.
  await rmdir(toExtendedLength(join(worldDir, dir))).catch(() => {});
}

/**
 * The cleanup a replay owes (issue 231, Codex round 2).
 *
 * Both early returns hand back a take that already exists — and used to hand it back without
 * looking at the staging copy. If the process exited between take.json and the unlink, or the
 * unlink lost to a held handle, the duplicate was there for good: nothing would ever try
 * again. A finalization retry from Activity, and the main-photo accept path's recovery call,
 * now finish the job the first pass did not.
 *
 * Guarded on the take's own media being there, because that is what makes dropping the other
 * copy safe. A take.json whose media has gone missing is the one case where the staging copy is
 * the only copy left, and this is the last code that would ever be in a position to notice.
 */
async function discardStagingCopyForRecorded(
  store: WorldStore,
  take: Take,
  sheetId: string,
  landed: string,
): Promise<void> {
  if (!take.media) return;
  const stored = join(store.dir, "references", sheetId, "takes", take.id, take.media);
  const present = await stat(toExtendedLength(stored)).then(
    (s) => s.isFile(),
    () => false,
  );
  if (!present) return;
  await discardStagingCopy(store.dir, sheetId, landed);
}

function kindFor(job: Job): Take["kind"] | null {
  if (job.target.kind === "main-photo-candidate" || job.target.kind === "establish-candidate") return "main-photo";
  if (job.target.kind === "character-sheet") return "sheet";
  if (job.target.kind === "character-look") return "look";
  if (job.target.kind === "location-view-candidate") return "location-view";
  return null;
}

export async function recordReferenceTake(store: WorldStore, job: Job, ledgerEntry?: LedgerEntry): Promise<Take | null> {
  const kind = kindFor(job);
  const landed = job.landedFiles?.[0];
  const sheetId = job.target.id?.split("/")[0];
  if (!kind || !landed || !sheetId) return null;
  const existing = store.getBundle().referenceTakes.find((take) => take.jobId === job.id);
  if (existing) {
    await discardStagingCopyForRecorded(store, existing, sheetId, landed);
    return existing;
  }
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
    if (duplicate) {
      await discardStagingCopyForRecorded(store, duplicate, sheetId, landed);
      return duplicate;
    }
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
  kind: "main-photo" | "sheet" | "look" | "location-view",
): Take | null {
  const take = takes.find(
    (candidate) => candidate.id === takeId && candidate.kind === kind && candidate.reference?.sheetId === sheetId,
  );
  if (!take || reviews.some((review) => review.takeId === take.id)) return null;
  return take;
}

/**
 * The take a hand-carried image gets: provider "user", model "upload", cost nil and *stated*
 * nil rather than unknown, provenance frozen at the moment it came in. It is a real take for
 * the same reason a generated one is — the kit points at takes, and the history has to be able
 * to say where the bytes came from — it simply names a person instead of a provider.
 */
function uploadedTake(
  store: WorldStore,
  sheetId: string,
  kind: Take["kind"],
  media: string,
  params: Record<string, unknown>,
): Take {
  const bundle = store.getBundle();
  const sheet = bundle.sheets.find((candidate) => candidate.id === sheetId);
  if (!sheet) throw new Error(`no sheet ${sheetId}`);
  const now = store.now();
  return {
    id: `tk_${ulid()}` as Take["id"],
    coversShots: [],
    kind,
    reference: { sheetId },
    provider: "user",
    model: "upload",
    provenance: {
      canonRevision: bundle.meta.canonRevision,
      sheets: { [sheetId]: sheet.version },
      artDirectionVersion: bundle.artDirection.version,
    },
    references: [],
    params,
    cost: { estimatedMicroUsd: 0, actualMicroUsd: 0, actualSource: "local-zero" },
    dispatchedAt: now,
    completedAt: now,
    media,
  };
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
  const media = basename(candidatePath);
  const take = uploadedTake(store, sheetId, "main-photo", media, { uploadedCandidate: candidatePath });
  await store.gateOp(() =>
    writeTakeDirectory(store, sheetId, take, async (dir) => {
      // An upload keeps its candidate: the user put that file there, and `uploadedCandidate`
      // points back at it. Only a staging copy this code made is this code's to remove.
      await placeMedia(join(store.dir, candidatePath), join(dir, media));
    }),
  );
  return take;
}

/**
 * Write a take's directory whole, or leave nothing behind (PR review).
 *
 * `take.json` is what makes a take exist: `scanWorld` skips a directory without one, for good
 * reason — a half-written take is not a take. But that means media written before a failing
 * `take.json` is not merely unused, it is unreachable, and a retry mints a new id rather than
 * finding it. One 50 MB sheet that failed at the last step would sit in the world forever with
 * nothing pointing at it and nothing able to explain it.
 *
 * The media goes down first regardless, because take.json must never be the file that survives
 * alone — it would name bytes that are not there. So the ordering stays, and the failure is
 * swept instead.
 */
async function writeTakeDirectory(
  store: WorldStore,
  sheetId: string,
  take: Take,
  putMedia: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = join(store.dir, "references", sheetId, "takes", take.id);
  await mkdir(toExtendedLength(dir), { recursive: true });
  try {
    await putMedia(dir);
    await atomicWriteFile(join(dir, "take.json"), JSON.stringify(take, null, 2) + "\n");
  } catch (err) {
    // Its own directory, named for an id nothing else has yet: removing it can strand no one.
    await rm(toExtendedLength(dir), { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/**
 * A character sheet the user drew, bought, or made elsewhere (PR #241).
 *
 * Takes the bytes, not a path: the caller has already read and verified them, and passing the
 * path would mean reading the file a second time — with a window in between for it to change
 * into something that was never checked. Unlike the main photo's route there is no candidate to
 * come from and none left behind; the file the user picked is never moved or touched.
 *
 * Not deduplicated, deliberately. The same file chosen twice is two deliberate acts, and the
 * second one is usually a corrected export of the first — collapsing them would silently keep
 * the older bytes.
 */
export async function recordUploadedCharacterSheetTake(
  store: WorldStore,
  sheetId: string,
  media: string,
  data: Uint8Array,
): Promise<Take> {
  return recordUploadedImageTake(store, sheetId, "sheet", media, data);
}

/**
 * A location view the user photographed, drew or made elsewhere (#243). The same shape as an
 * uploaded character sheet, and deliberately a take rather than a loose candidate: acceptance
 * reads a pending take, so an upload that landed anywhere else would need a second accept path
 * that could disagree with the first about what a view is.
 */
export async function recordUploadedLocationViewTake(
  store: WorldStore,
  sheetId: string,
  media: string,
  data: Uint8Array,
): Promise<Take> {
  return recordUploadedImageTake(store, sheetId, "location-view", media, data);
}

async function recordUploadedImageTake(
  store: WorldStore,
  sheetId: string,
  kind: Take["kind"],
  media: string,
  data: Uint8Array,
): Promise<Take> {
  // A plain filename and nothing else. `basename` alone lets "." and ".." through — basename("..")
  // is ".." — and both name a directory that already exists, so the write would land on something
  // real instead of failing cleanly.
  if (basename(media) !== media || media === "." || media === "..") {
    throw new Error(`unsafe media name ${media}`);
  }
  const take = uploadedTake(store, sheetId, kind, media, { uploadedFile: media });
  await store.gateOp(() =>
    writeTakeDirectory(store, sheetId, take, async (dir) => {
      // Staged and renamed like every other write here, so a half-written 40 MB sheet cannot be
      // mistaken for a finished one (SPEC-002 R-13).
      await atomicWriteFile(join(dir, media), data);
    }),
  );
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
  await store.gateOp(async () => {
    let raw = "";
    let existed = false;
    try {
      raw = await readFile(toExtendedLength(join(store.dir, path)), "utf8");
      existed = true;
    } catch {
      /* first review */
    }
    await store.commitUnserialised({
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
  });
  return review;
}

export function referenceReviewDecision(
  now: string,
  take: Take,
  decision: "accept" | "reject",
  input: { field?: string; note?: string } = {},
): ReviewDecision {
  // A prop-state take is a reference take that names no sheet (issue 535): it is decided the
  // same way, and a rejection of one has no sheet field to cite.
  if (!take.reference && !take.prop) throw new Error(`${take.id} is not a reference take`);
  const review: ReviewDecision = {
    ts: now,
    takeId: take.id,
    decision,
    by: "user",
    ...(decision === "reject" && take.reference
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

/** A prop-state take waiting on its accept (issue 535): the main photo's pending rule, keyed by prop and state. */
export function pendingPropStateTake(
  takes: readonly Take[],
  reviews: readonly ReviewDecision[],
  takeId: Take["id"],
  propId: string,
  stateId: string,
): Take | null {
  const take = takes.find(
    (candidate) =>
      candidate.id === takeId &&
      candidate.kind === "prop-state" &&
      candidate.prop?.propId === propId &&
      candidate.prop.stateId === stateId,
  );
  if (!take || reviews.some((review) => review.takeId === take.id)) return null;
  return take;
}

/**
 * The take a hand-carried prop reference gets (issue 535): `uploadedTake`'s shape without a
 * sheet to version — a prop is not one, and the record the accept commits is its identity.
 * Filed under `references/<propId>/takes/`, the directory shape the scan already walks.
 */
export async function recordUploadedPropTake(
  store: WorldStore,
  propId: string,
  stateId: string,
  candidatePath: string,
): Promise<Take> {
  const bundle = store.getBundle();
  const existing = bundle.referenceTakes.find(
    (take) =>
      take.kind === "prop-state" &&
      take.prop?.propId === propId &&
      take.prop.stateId === stateId &&
      take.provider === "user" &&
      take.params["uploadedCandidate"] === candidatePath,
  );
  if (existing) return existing;
  const now = store.now();
  const media = basename(candidatePath);
  const take: Take = {
    id: `tk_${ulid()}` as Take["id"],
    coversShots: [],
    kind: "prop-state",
    prop: { propId, stateId },
    provider: "user",
    model: "upload",
    provenance: {
      canonRevision: bundle.meta.canonRevision,
      sheets: {},
      artDirectionVersion: bundle.artDirection.version,
    },
    references: [],
    params: { uploadedCandidate: candidatePath },
    cost: { estimatedMicroUsd: 0, actualMicroUsd: 0, actualSource: "local-zero" },
    dispatchedAt: now,
    completedAt: now,
    media,
  };
  await store.gateOp(() =>
    writeTakeDirectory(store, propId, take, async (dir) => {
      await placeMedia(join(store.dir, candidatePath), join(dir, media));
    }),
  );
  return take;
}
