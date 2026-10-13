import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  audiobookMotionDurations,
  audiobookMotionModel,
  audiobookMotionPrice,
  pickableArtifacts,
  placePictures,
  worldImageReferences,
  type AudiobookMotionQuote,
  type AudiobookPicture,
  type BenchVideoParams,
  type ManifestModel,
  type ListeningChapter,
} from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { toExtendedLength } from "../world/paths.js";
import { containedWorldFile } from "./interactive.js";
import { planAudiobook, updateAudiobook } from "./audiobook.js";
import { anyNarrator } from "./audiobook-listening.js";

async function hashFile(store: WorldStore, file: string): Promise<string> {
  const real = await containedWorldFile(store.dir, file);
  if (real === null) throw new Error("the file is no longer inside this world");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(toExtendedLength(real))) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

/** Freeze the quoted bytes into the Bench token before any reservation can spend. */
export async function quotedMotionSource(store: WorldStore, file: string, expectedHash: string): Promise<{ hash: string } | { refused: string }> {
  try {
    const hash = await hashFile(store, file);
    return hash === expectedHash ? { hash: hash.slice(0, 23) } : { refused: "the source picture changed · review a new quote" };
  } catch { return { refused: "the source picture is no longer inside this world" }; }
}

async function context(store: WorldStore, productionId: string, chapterFile: string, block: string) {
  const summary = store
    .getBundle()
    .productions.find((p) => p.meta.id === productionId)
    ?.chapters.find((c) => c.file === chapterFile || c.id === chapterFile);
  if (summary === undefined) throw new Error("that chapter is no longer in this production");
  const plan = await planAudiobook(store, productionId, summary.id, {
    narrator: await anyNarrator(store, productionId),
  });
  const blocks = plan.blocks.map((p) => p.block);
  const index = blocks.findIndex((p) => p.key === block);
  if (index < 0) throw new Error("that block is no longer in the chapter");
  return { plan, blocks, index };
}

function source(
  pictures: Record<string, AudiobookPicture>,
  blocks: Parameters<typeof placePictures>[0],
  index: number,
) {
  const placed = placePictures(blocks, pictures).placed.find((p) => p.index === index);
  if (placed === undefined) throw new Error("choose a picture here first");
  return placed;
}

export async function quoteAudiobookMotion(
  store: WorldStore,
  productionId: string,
  chapterFile: string,
  block: string,
  model: ManifestModel,
  params: BenchVideoParams,
  prompt: string,
): Promise<AudiobookMotionQuote> {
  if (!audiobookMotionModel(model)) throw new Error("this model cannot start from a picture");
  if (prompt.trim() === "" || prompt.length > (model.limits.maxPromptChars ?? 10000))
    throw new Error("the motion prompt is too long for this model");
  if (params.resolution !== undefined && !model.limits.resolutions?.includes(params.resolution))
    throw new Error("choose a supported resolution");
  if (!audiobookMotionDurations(model).includes(params.durationSec ?? 5))
    throw new Error("choose a supported clip length");
  const { plan, blocks, index } = await context(store, productionId, chapterFile, block);
  const picture = source(
    plan.record === "unreadable" ? {} : (plan.record?.pictures ?? {}),
    blocks,
    index,
  ).picture;
  if (!worldImageReferences(store.getBundle()).some((p) => p.file === picture.file))
    throw new Error("this source picture is unavailable");
  const sourceHash = await hashFile(store, picture.file);
  return {
    sourceFile: picture.file,
    sourceAt: picture.at,
    sourceHash,
    model: { id: model.id, provider: model.provider, label: model.displayName },
    params,
    prompt,
    estimatedMicroUsd: audiobookMotionPrice(model, params),
    ...(model.pricing.kind === "unmetered" && model.pricing.typicalRunSec !== undefined
      ? { typicalRunSec: model.pricing.typicalRunSec }
      : {}),
  };
}

/** The generation files its output first. A changed source refuses attachment and leaves that artifact in Library. */
export async function saveAudiobookMotionCandidate(
  store: WorldStore,
  productionId: string,
  chapterFile: string,
  block: string,
  quote: AudiobookMotionQuote,
  artifactId: string,
) {
  const { plan, blocks, index } = await context(store, productionId, chapterFile, block);
  const artifact = store.getBundle().artifacts.find((p) => p.id === artifactId);
  const media = artifact?.mediaInfo;
  if (
    artifact === undefined ||
    media?.hasVideo !== true ||
    media.durationSec === undefined ||
    media.width === undefined ||
    media.height === undefined
  )
    throw new Error("the made clip has no measured video size or duration · it remains in Library");
  const file = `artifacts/${artifact.file}`;
  await hashFile(store, file);
  return updateAudiobook(store, productionId, plan.chapter, async (current) => {
    const shown = source(current.pictures ?? {}, blocks, index);
    if (
      shown.picture.file !== quote.sourceFile ||
      shown.picture.at !== quote.sourceAt ||
      (await hashFile(store, shown.picture.file)) !== quote.sourceHash
    )
      throw new Error("the source picture changed · the clip remains in Library");
    return {
      ...current,
      updatedAt: store.now(),
      pictures: {
        ...current.pictures,
        [shown.key]: {
          ...shown.picture,
          motionCandidate: {
            artifactId,
            file,
            seconds: media.durationSec!,
            width: media.width!,
            height: media.height!,
            sourceHash: quote.sourceHash,
            sourceAt: quote.sourceAt,
            behavior: "repeat",
            active: false,
          },
        },
      },
    };
  });
}

export async function chooseAudiobookMotion(
  store: WorldStore,
  productionId: string,
  chapterFile: string,
  block: string,
  choice: "candidate" | "still" | "behavior",
  behavior: "repeat" | "hold",
  artifactId?: string,
) {
  const { plan, blocks, index } = await context(store, productionId, chapterFile, block);
  return updateAudiobook(store, productionId, plan.chapter, async (current) => {
    const shown = source(current.pictures ?? {}, blocks, index);
    let picture = shown.picture;
    if (choice === "candidate") {
      const candidate = picture.motionCandidate ?? picture.motion;
      if (candidate === undefined || candidate.artifactId !== artifactId)
        throw new Error("that clip is no longer the one awaiting review");
      if (
        !pickableArtifacts(store.getBundle().artifacts).some(
          (p) => p.id === candidate.artifactId && `artifacts/${p.file}` === candidate.file,
        )
      )
        throw new Error("that clip is no longer available in Library");
      if (candidate.sourceAt !== picture.at || candidate.sourceHash !== (await hashFile(store, picture.file)))
        throw new Error("the source picture changed · make a new clip");
      await hashFile(store, candidate.file);
      const { motionCandidate: _candidate, ...rest } = picture;
      picture = { ...rest, motion: { ...candidate, active: true, behavior } };
    } else if (choice === "still") {
      const { motionCandidate: _discarded, ...retained } = picture;
      picture = {
        ...retained,
        ...(picture.motion !== undefined ? { motion: { ...picture.motion, active: false } } : {}),
      };
    } else if (picture.motion !== undefined)
      picture = { ...picture, motion: { ...picture.motion, behavior } };
    return { ...current, updatedAt: store.now(), pictures: { ...current.pictures, [shown.key]: picture } };
  });
}

/** A player can fall back visibly. Export sees the problem and refuses a silent substitution. */
export async function checkAudiobookMotion(store: WorldStore, chapter: ListeningChapter): Promise<void> {
  for (const picture of chapter.pictures) {
    const clip = picture.motion;
    if (clip === undefined) continue;
    const listed = pickableArtifacts(store.getBundle().artifacts).some(
      (p) => p.id === clip.artifactId && `artifacts/${p.file}` === clip.file,
    );
    if (!listed || (await containedWorldFile(store.dir, clip.file)) === null)
      picture.motionProblem = "clip unavailable · showing the still";
    else if ((await hashFile(store, picture.file).catch(() => "")) !== clip.sourceHash)
      picture.motionProblem = "source picture changed · showing the still";
  }
}
