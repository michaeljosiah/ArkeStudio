import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import {
  type ArtifactSidecar,
  type BenchSession,
  type BenchTake,
  type ProductionBundle,
  type ReviewDecision,
  type Selections,
  type Take,
  type TakeCost,
  orderedShots,
} from "@arke-studio/contracts";
import { applyTakeAcceptance } from "../takes/review.js";
import { chainBoundaryFrame, type BoundaryChainResult, type BoundaryFrameMaker } from "../takes/boundary.js";
import { posterNameFor } from "../takes/poster.js";
import { atomicWriteFile } from "../world/atomic.js";
import { toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";
import type { WorldStore } from "../world/store.js";
import { sessionMediaDir } from "./store.js";
import { boardSubjectIsCurrent } from "./subject.js";

export interface SubjectFilingOutcome {
  productionTakeIds: string[];
  affectedShotIds: string[];
  artifactId?: string;
  takes: Take[];
  decisions: ReviewDecision[];
  boundaryFrame?: BoundaryChainResult;
}

async function readOr(store: WorldStore, path: string, fallback: string): Promise<{ raw: string; existed: boolean }> {
  try {
    return { raw: await readFile(toExtendedLength(join(store.dir, path)), "utf8"), existed: true };
  } catch {
    return { raw: fallback, existed: false };
  }
}

async function productionReferencePaths(
  store: WorldStore,
  session: BenchSession,
  take: BenchTake,
  productionId: string,
  productionTakeId: string,
): Promise<string[]> {
  const bundle = store.getBundle();
  const paths: string[] = [];
  for (const reference of [...take.request.references, ...take.request.keyframes]) {
    const source = reference.source;
    if (source.source === "world-file") {
      paths.push(source.path);
      continue;
    }
    if (source.source === "artifact") {
      const artifact = bundle.artifacts.find((candidate) => candidate.id === source.artifactId);
      if (artifact) paths.push(`artifacts/${artifact.file}`);
      continue;
    }
    const referenced = session.takes.find((candidate) => candidate.id === source.takeId);
    if (!referenced?.media) continue;
    if (referenced.keptArtifactId !== undefined) {
      const artifact = bundle.artifacts.find((candidate) => candidate.id === referenced.keptArtifactId);
      if (artifact) {
        paths.push(`artifacts/${artifact.file}`);
        continue;
      }
    }
    const name = `${referenced.id}-${basename(referenced.media.file)}`;
    const path = `productions/${productionId}/takes/${productionTakeId}/references/${name}`;
    const bytes = await readFile(
      toExtendedLength(join(store.dir, sessionMediaDir(session.id, referenced.id), referenced.media.file)),
    );
    await writeIfMissing(join(store.dir, path), bytes);
    paths.push(path);
  }
  return paths;
}

function costOf(take: BenchTake): TakeCost {
  return take.cost ?? { estimatedMicroUsd: 0, actualMicroUsd: null };
}

function baseTake(
  take: BenchTake,
  id: string,
  coversShots: string[],
  kind: "frame" | "clip",
  references: string[],
): Take {
  if (take.request.productionProvenance === undefined) throw new Error("the Bench take has no production provenance");
  return {
    id: id as Take["id"],
    ...(take.jobId !== undefined ? { jobId: take.jobId } : {}),
    coversShots: coversShots as Take["coversShots"],
    kind,
    provider: take.request.provider,
    model: take.request.model,
    provenance: {
      ...take.request.productionProvenance,
      ...(take.request.recipeVersion !== undefined ? { recipeVersion: take.request.recipeVersion } : {}),
    },
    prompt: take.request.brief,
    references,
    params: take.request.params,
    cost: costOf(take),
    dispatchedAt: take.createdAt,
    ...(take.completedAt !== undefined ? { completedAt: take.completedAt } : {}),
  };
}

/**
 * A filing belongs to its subject by kind — except a shot's clip, which files as a board of one
 * (SPEC-036 R-36): the board shape covering exactly that shot is that shot's own filing.
 */
function filingFitsSubject(
  filing: NonNullable<BenchTake["request"]["filing"]>,
  subject: NonNullable<BenchSession["subject"]>,
): boolean {
  if (filing.kind === subject.kind) return true;
  return (
    subject.kind === "shot" &&
    filing.kind === "board" &&
    filing.members.length === 1 &&
    filing.members[0]!.shotId === subject.shotId
  );
}

/** A production commit that landed before the Bench log caught up, or null if it did not. */
export function existingBenchSubjectFiling(
  store: WorldStore,
  session: BenchSession,
  take: BenchTake,
): SubjectFilingOutcome | null {
  const filing = take.request.filing;
  if (session.subject === undefined || filing === undefined || !filingFitsSubject(filing, session.subject)) return null;
  const production = store.getBundle().productions.find((candidate) => candidate.meta.id === filing.productionId);
  if (production === undefined) return null;
  const productionTakeIds =
    filing.kind === "shot"
      ? [filing.productionTakeId]
      : [filing.productionTakeId, ...filing.members.map((member) => member.takeId)];
  const takes = productionTakeIds.map((id) => production.takes.find((candidate) => candidate.id === id));
  if (takes.some((candidate) => candidate === undefined)) return null;
  return {
    productionTakeIds,
    affectedShotIds: filing.kind === "shot" ? [filing.shotId] : filing.members.map((member) => member.shotId),
    ...(filing.kind === "shot" ? { artifactId: filing.frameArtifactId } : {}),
    takes: takes as Take[],
    decisions: production.reviews.filter((decision) => productionTakeIds.includes(decision.takeId)),
  };
}

async function imageArtifactBytes(
  store: WorldStore,
  source: string,
  extension: string,
  toPng: BoundaryFrameMaker | undefined,
): Promise<{ bytes: Buffer; extension: string }> {
  const original = await readFile(toExtendedLength(source));
  if (extension === ".png" || toPng === undefined) return { bytes: original, extension };
  const staging = join(store.dir, ".cache", "frames", `bench-${createHash("sha256").update(source).digest("hex").slice(0, 16)}.png`);
  try {
    await mkdir(toExtendedLength(join(store.dir, ".cache", "frames")), { recursive: true });
    const converted = await toPng.write(source, staging, 0);
    if (!converted.ok) return { bytes: original, extension };
    const bytes = await readFile(toExtendedLength(staging));
    return bytes.byteLength > 0 ? { bytes, extension: ".png" } : { bytes: original, extension };
  } finally {
    await rm(toExtendedLength(staging), { force: true }).catch(() => {});
  }
}

async function writeIfMissing(path: string, bytes: Buffer): Promise<void> {
  const exists = await stat(toExtendedLength(path)).then((value) => value.isFile()).catch(() => false);
  if (!exists) await atomicWriteFile(path, bytes);
}

/** Repair the durable copy after a late Bench poster backfill; absence remains best-effort. */
export async function copyBenchSubjectPoster(
  store: WorldStore,
  session: BenchSession,
  take: BenchTake,
): Promise<void> {
  const filing = take.request.filing;
  const media = take.media?.file;
  if (filing === undefined || media === undefined) return;
  const posterName = posterNameFor(basename(media));
  if (posterName === basename(media)) return;
  try {
    const posterBytes = await readFile(
      toExtendedLength(join(store.dir, sessionMediaDir(session.id, take.id), posterName)),
    );
    if (posterBytes.byteLength === 0) return;
    await writeIfMissing(
      join(store.dir, "productions", filing.productionId, "takes", filing.productionTakeId, posterName),
      posterBytes,
    );
  } catch {
    // Posters are best-effort in both Bench and production; a later open retries this copy.
  }
}

function mediaInfoFile(take: BenchTake, fullHash: string): string | null {
  return take.media?.info === undefined
    ? null
    : JSON.stringify(
        { sourceHash: `sha256:${fullHash}`, mediaInfo: take.media.info, probedAt: take.completedAt ?? take.createdAt },
        null,
        2,
      ) + "\n";
}

/** Copy a completed Bench take into production and land every decision in one metadata commit. */
export async function fileBenchSubjectTake(
  store: WorldStore,
  session: BenchSession,
  take: BenchTake,
  options: { toPng?: BoundaryFrameMaker } = {},
): Promise<SubjectFilingOutcome> {
  // Validation, media copies and metadata share the world's mutation gate. Otherwise a scene
  // edit can move a board boundary after validation and before its stale segments are selected.
  const filed = await store.ownedWrite(() => fileBenchSubjectTakeUnserialised(store, session, take, options));
  const boundaryFrame = await chainBenchSubjectBoundary(store, take, options.toPng);
  return boundaryFrame === undefined ? filed : { ...filed, boundaryFrame };
}

/** Retryable continuity work that must run outside subject filing's non-reentrant world gate. */
export async function chainBenchSubjectBoundary(
  store: WorldStore,
  take: BenchTake,
  maker: BoundaryFrameMaker | undefined,
): Promise<BoundaryChainResult | undefined> {
  const filing = take.request.filing;
  if (filing?.kind !== "board") return undefined;

  /*
   * Extraction enters the world gate to install its artifact, so it must run after ownedWrite
   * releases. The final child is the accepted source fence while its parent owns the footage.
   */
  const last = filing.members.at(-1);
  const production = store.getBundle().productions.find((candidate) => candidate.meta.id === filing.productionId);
  const scene = production?.scenes.find((candidate) => candidate.id === filing.sceneId);
  const shots = scene === undefined ? [] : orderedShots(scene);
  const index = last === undefined ? -1 : shots.findIndex((shot) => shot.id === last.shotId);
  const following = index >= 0 ? shots[index + 1] : undefined;
  const sourceTake = last === undefined ? undefined : production?.takes.find((candidate) => candidate.id === last.takeId);
  if (production === undefined || last === undefined || following === undefined || sourceTake === undefined) return undefined;
  if (production.selections[last.shotId]?.acceptedTakeId !== sourceTake.id) return undefined;
  const boundaryArtifactId = production.selections[following.id]?.startFrameArtifactId;
  const boundaryArtifact = boundaryArtifactId === undefined
    ? undefined
    : store.getBundle().artifacts.find((candidate) => candidate.id === boundaryArtifactId);
  if (
    boundaryArtifact?.boundaryExtraction?.sourceTakeId === sourceTake.id &&
    boundaryArtifact.boundaryExtraction.mediaTakeId === sourceTake.segment?.passTakeId
  ) {
    return { ok: true, artifactId: boundaryArtifact.id, followingShotId: following.id };
  }

  return chainBoundaryFrame(store, production, {
    take: sourceTake,
    sourceShotId: last.shotId,
    followingShotId: following.id,
    maker,
    clock: () => store.now(),
  }).catch((error): BoundaryChainResult => ({
    ok: false,
    reason: error instanceof Error ? error.message : String(error),
  }));
}

async function fileBenchSubjectTakeUnserialised(
  store: WorldStore,
  session: BenchSession,
  take: BenchTake,
  options: { toPng?: BoundaryFrameMaker },
): Promise<SubjectFilingOutcome> {
  if (session.subject === undefined) throw new Error("this Bench session has no production subject");
  if (take.media === undefined || take.status !== "succeeded") throw new Error("that Bench take has no completed media to accept");
  const filing = take.request.filing;
  if (filing === undefined || !filingFitsSubject(filing, session.subject)) {
    throw new Error("that Bench take has no filing plan for this subject");
  }
  const production = store.getBundle().productions.find((candidate) => candidate.meta.id === filing.productionId);
  if (production === undefined) throw new Error("the subject production is no longer available");
  const scene = production.scenes.find((candidate) => candidate.id === filing.sceneId);
  if (scene === undefined) throw new Error("the subject scene is no longer available");
  const currentShots = orderedShots(scene);
  const shotIds = new Set(currentShots.map((shot) => shot.id));
  const affectedShotIds = filing.kind === "shot" ? [filing.shotId] : filing.members.map((member) => member.shotId);
  if (affectedShotIds.some((shotId) => !shotIds.has(shotId))) {
    throw new Error("the subject shots are no longer available");
  }
  const boardSubject = session.subject.kind === "board" ? session.subject : null;
  // A shot's clip is held to its own length the way a board is held to its members'.
  const shotSubject = session.subject.kind === "shot" ? session.subject : null;
  if (filing.kind === "board" && shotSubject !== null) {
    const shot = currentShots.find((candidate) => candidate.id === shotSubject.shotId);
    if ((shot?.durationSec ?? 4) !== shotSubject.durationSec) {
      throw new Error("the shot timing changed in this scene; rebuild and generate a current take");
    }
    // The take was asked for at one length; a subject rebuilt to another since then passes the
    // check above, and would file a clip made for a different shot than the one it lands on.
    const asked = take.request.params;
    if (filing.members[0]!.startSec !== 0 || asked.kind !== "video" || asked.durationSec !== shotSubject.durationSec) {
      throw new Error("the shot timing changed since this take; rebuild and generate a current take");
    }
  }
  if (filing.kind === "board" && boardSubject !== null) {
    const first = currentShots.findIndex((shot) => shot.id === filing.members[0]?.shotId);
    const members = first < 0 ? [] : currentShots.slice(first, first + filing.members.length);
    if (
      members.length !== filing.members.length ||
      members.some((shot, index) => shot.id !== filing.members[index]?.shotId)
    ) {
      throw new Error("the board members are no longer contiguous in this scene; rebuild and generate a current take");
    }
    if (
      members.some(
        (shot, index) => (shot.durationSec ?? 4) !== boardSubject.members[index]?.durationSec,
      )
    ) {
      throw new Error("the board timing changed in this scene; rebuild and generate a current take");
    }
    if (!boardSubjectIsCurrent(store.getBundle(), boardSubject)) {
      throw new Error("the board boundaries changed in this scene; rebuild and generate a current take");
    }
    let cursor = 0;
    const frozenFilingIsCurrent =
      take.request.params.kind === "video" &&
      take.request.params.durationSec === boardSubject.durationSec &&
      filing.members.length === boardSubject.members.length &&
      filing.members.every((member, index) => {
        const subjectMember = boardSubject.members[index]!;
        const startSec = cursor;
        cursor += subjectMember.durationSec;
        return (
          member.shotId === subjectMember.shotId &&
          member.number === subjectMember.number &&
          member.startSec === startSec &&
          (index === filing.members.length - 1 ? member.endSec >= cursor : member.endSec === cursor)
        );
      });
    if (!frozenFilingIsCurrent) {
      throw new Error("that take belongs to older board timing; rebuild and generate a current take");
    }
  }
  const plannedIds =
    filing.kind === "shot"
      ? [filing.productionTakeId]
      : [filing.productionTakeId, ...filing.members.map((member) => member.takeId)];
  const recovered = existingBenchSubjectFiling(store, session, take);
  if (recovered !== null) {
    await copyBenchSubjectPoster(store, session, take);
    return recovered;
  }
  const existing = plannedIds.map((id) => production.takes.find((candidate) => candidate.id === id));
  if (existing.some((candidate) => candidate !== undefined)) {
    throw new Error("the production filing is incomplete; reopen the world so its commit can recover");
  }

  const sourcePath = join(store.dir, sessionMediaDir(session.id, take.id), take.media.file);
  const sourceBytes = await readFile(toExtendedLength(sourcePath));
  if (sourceBytes.byteLength === 0) throw new Error("the Bench take's media is empty");
  const fullHash = createHash("sha256").update(sourceBytes).digest("hex");
  const mediaName = basename(take.media.file);
  const parentMediaPath = join(store.dir, "productions", filing.productionId, "takes", filing.productionTakeId, mediaName);
  await writeIfMissing(parentMediaPath, sourceBytes);
  await copyBenchSubjectPoster(store, session, take);
  const referencePaths = await productionReferencePaths(
    store,
    session,
    take,
    filing.productionId,
    filing.productionTakeId,
  );

  const reviewsPath = `productions/${filing.productionId}/reviews.jsonl`;
  const selectionsPath = `productions/${filing.productionId}/selections.json`;
  const reviews = await readOr(store, reviewsPath, "");
  const selectionFile = await readOr(store, selectionsPath, "{}");
  const at = store.now();

  if (filing.kind === "shot") {
    const extension = extname(mediaName).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
      throw new Error("the accepted shot result is not an image");
    }
    const productionTake = {
      ...baseTake(take, filing.productionTakeId, [filing.shotId], "frame", referencePaths),
      media: mediaName,
    } satisfies Take;
    const decision: ReviewDecision = {
      ts: at,
      takeId: filing.productionTakeId,
      shotId: filing.shotId,
      decision: "accept",
      by: `bench:${session.id}`,
    };
    const artifactMedia = await imageArtifactBytes(store, sourcePath, extension, options.toPng);
    const artifactFile = `frame-${filing.shotId}-${filing.frameArtifactId.slice(-8).toLowerCase()}${artifactMedia.extension}`;
    await writeIfMissing(join(store.dir, "artifacts", artifactFile), artifactMedia.bytes);
    const artifact: ArtifactSidecar = {
      id: filing.frameArtifactId,
      kind: "image",
      file: artifactFile,
      hash: `sha256:${createHash("sha256").update(artifactMedia.bytes).digest("hex").slice(0, 16)}`,
      origin: { by: "system", producedBy: `bench:${session.id}/${take.id}` },
      links: [filing.productionId, filing.sceneId, filing.shotId, filing.productionTakeId],
      production: filing.productionId,
      created: at,
    };
    const selections = JSON.parse(selectionFile.raw) as Selections;
    selections[filing.shotId] = {
      trimInSec: 0,
      ...selections[filing.shotId],
      startFrameArtifactId: filing.frameArtifactId,
      startFrameTakeId: null,
    };
    const info = mediaInfoFile(take, fullHash);
    await store.commitUnserialised({
      kind: "bench-subject-accept",
      source: `bench:${session.id}`,
      raiseSchemaVersion: 2,
      files: [
        {
          path: `productions/${filing.productionId}/takes/${filing.productionTakeId}/take.json`,
          action: "create",
          content: JSON.stringify(productionTake, null, 2) + "\n",
          baseHash: null,
        },
        ...(info === null
          ? []
          : [{
              path: `productions/${filing.productionId}/takes/${filing.productionTakeId}/media-info.json`,
              action: "create" as const,
              content: info,
              baseHash: null,
            }]),
        {
          path: `artifacts/${artifactFile}.json`,
          action: "create",
          content: JSON.stringify(artifact, null, 2) + "\n",
          baseHash: null,
        },
        {
          path: reviewsPath,
          action: reviews.existed ? "replace" : "create",
          content: reviews.raw + JSON.stringify(decision) + "\n",
          baseHash: reviews.existed ? sha256(reviews.raw) : null,
        },
        {
          path: selectionsPath,
          action: selectionFile.existed ? "replace" : "create",
          content: JSON.stringify(selections, null, 2) + "\n",
          baseHash: selectionFile.existed ? sha256(selectionFile.raw) : null,
        },
      ],
    });
    return {
      productionTakeIds: plannedIds,
      affectedShotIds: [filing.shotId],
      artifactId: filing.frameArtifactId,
      takes: [productionTake],
      decisions: [decision],
    };
  }

  const parent = {
    ...baseTake(take, filing.productionTakeId, filing.members.map((member) => member.shotId), "clip", referencePaths),
    media: mediaName,
  } satisfies Take;
  const totalSec = filing.members.reduce((sum, member) => sum + member.endSec - member.startSec, 0);
  const estimatedCharge = take.cost?.estimatedMicroUsd ?? 0;
  const actualCharge = take.cost?.actualMicroUsd ?? null;
  let allocatedEstimate = 0;
  let allocatedActual = 0;
  const children = filing.members.map((member, index): Take => {
    const last = index === filing.members.length - 1;
    const durationSec = member.endSec - member.startSec;
    const estimatedShare = last
      ? estimatedCharge - allocatedEstimate
      : Math.floor((estimatedCharge * durationSec) / totalSec);
    const actualShare =
      actualCharge === null
        ? null
        : last
          ? actualCharge - allocatedActual
          : Math.floor((actualCharge * durationSec) / totalSec);
    allocatedEstimate += estimatedShare;
    allocatedActual += actualShare ?? 0;
    return {
      ...baseTake(take, member.takeId, [member.shotId], "clip", referencePaths),
      cost: {
        estimatedMicroUsd: estimatedShare,
        actualMicroUsd: actualShare,
        ...(take.cost?.actualSource !== undefined ? { actualSource: take.cost.actualSource } : {}),
        allocated: true,
      },
      segment: { passTakeId: filing.productionTakeId, inSec: member.startSec, outSec: member.endSec },
    };
  });
  const withFiledTakes: ProductionBundle = { ...production, takes: [...production.takes, parent, ...children] };
  let selections = JSON.parse(selectionFile.raw) as Selections;
  const decisions: ReviewDecision[] = [
    {
      ts: at,
      takeId: parent.id,
      decision: "accept",
      by: `bench:${session.id}`,
    },
  ];
  for (const [index, member] of filing.members.entries()) {
    const applied = applyTakeAcceptance(withFiledTakes, store.getBundle().artifacts, selections, {
      takeId: member.takeId,
      shotId: member.shotId,
      by: `bench:${session.id}`,
      at,
    });
    decisions.push(applied.decision);
    selections = applied.selections;
    if (index < filing.members.length - 1) {
      // Every member is selected in this same commit; only the final member may seed outside the board.
      selections[filing.members[index + 1]!.shotId] = {
        trimInSec: 0,
        ...selections[filing.members[index + 1]!.shotId],
        startFrameTakeId: production.selections[filing.members[index + 1]!.shotId]?.startFrameTakeId ?? null,
      };
    }
  }
  const info = mediaInfoFile(take, fullHash);
  await store.commitUnserialised({
    kind: "bench-subject-accept",
    source: `bench:${session.id}`,
    files: [
      ...[parent, ...children].map((filed) => ({
        path: `productions/${filing.productionId}/takes/${filed.id}/take.json`,
        action: "create" as const,
        content: JSON.stringify(filed, null, 2) + "\n",
        baseHash: null,
      })),
      ...(info === null
        ? []
        : [{
            path: `productions/${filing.productionId}/takes/${filing.productionTakeId}/media-info.json`,
            action: "create" as const,
            content: info,
            baseHash: null,
          }]),
      {
        path: reviewsPath,
        action: reviews.existed ? "replace" : "create",
        content: reviews.raw + decisions.map((decision) => JSON.stringify(decision)).join("\n") + "\n",
        baseHash: reviews.existed ? sha256(reviews.raw) : null,
      },
      {
        path: selectionsPath,
        action: selectionFile.existed ? "replace" : "create",
        content: JSON.stringify(selections, null, 2) + "\n",
        baseHash: selectionFile.existed ? sha256(selectionFile.raw) : null,
      },
    ],
  });
  return {
    productionTakeIds: plannedIds,
    affectedShotIds: filing.members.map((member) => member.shotId),
    takes: [parent, ...children],
    decisions,
  };
}
