import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { createHash } from "node:crypto";
import { JobSchema, JobIdSchema, genesisSheetIds, type GenesisBlueprint, type GenesisImageCandidate, type GenesisImageSelection, type LedgerEntry } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { atomicWriteFile } from "../world/atomic.js";
import { fileArtifact, fileGeneratedArtifact } from "../artifacts/filing.js";
import { genesisControlDir } from "./genesis-conversation.js";
import { savedGenesisImages } from "./genesis-images.js";
import { recordReferenceTake, recordUploadedMainPhotoTake, recordUploadedLocationViewTake, recordUploadedPropImage, referenceReviewDecision } from "../references/takes.js";
import { acceptPropStateReference } from "../references/props.js";
import { genesisPropId, genesisPropStateId } from "./genesis-props.js";
import { acceptMainPhoto } from "../references/main-photo.js";
import { acceptLocationView, readKit } from "../references/kit.js";

async function candidateBytes(workspace: string, candidate: GenesisImageCandidate): Promise<Buffer> {
  const bytes = await readFile(join(genesisControlDir(workspace), candidate.file));
  if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== candidate.hash) throw new Error("The founding image changed after approval.");
  return bytes;
}

export async function carryGenesisImageArtifacts(workspace: string, genesisId: string, blueprint: GenesisBlueprint, store: WorldStore,
  ledger: (jobId: string) => Promise<LedgerEntry | undefined>): Promise<void> {
  const images = await savedGenesisImages(workspace);
  const ids = genesisSheetIds(blueprint);
  for (const prop of blueprint.props ?? []) {
    for (const state of prop.states) ids.set(`prop:${prop.slug}:${state.slug}`, genesisPropId(genesisId, prop.slug));
  }
  for (const candidate of images.candidates) {
    const bytes = await candidateBytes(workspace, candidate);
    const links = [...new Set([
      ...(candidate.target && ids.has(candidate.target) ? [ids.get(candidate.target)!] : []),
      ...images.selections.filter(selection => selection.candidate.id === candidate.id).flatMap(selection => ids.has(selection.target) ? [ids.get(selection.target)!] : []),
    ])];
    if (candidate.source === "generated" && candidate.jobId) {
      const entry = await ledger(candidate.jobId);
      await fileGeneratedArtifact(store, { sourcePath: join(genesisControlDir(workspace), candidate.file), generation: {
        source: "founding", genesisId, jobId: candidate.jobId, target: candidate.target!, label: candidate.label,
        provider: candidate.provider!, model: candidate.model!, prompt: candidate.prompt ?? "", params: candidate.params ?? {},
        estimatedMicroUsd: candidate.estimatedMicroUsd ?? 0, costMicroUsd: entry?.actualMicroUsd ?? null, links,
      } });
    } else {
      const sourcePath = join(genesisControlDir(workspace), "filing", candidate.hash.slice(7), basename(candidate.label));
      await atomicWriteFile(sourcePath, bytes);
      const outcome = await fileArtifact(store, { sourcePath, links, importedFrom: candidate.label });
      if (outcome.outcome === "refused" || outcome.outcome === "needs-consent") throw new Error(outcome.reason);
    }
  }
}

/** Reuse the selected bytes through the same reference-take and kit gates as open-world imports. */
export async function installGenesisImage(workspace: string, selection: GenesisImageSelection, blueprint: GenesisBlueprint, store: WorldStore, ledger?: LedgerEntry): Promise<void> {
  if (selection.target.startsWith("prop:")) {
    const [, slug, stateSlug] = selection.target.split(":");
    const genesisId = basename(genesisControlDir(workspace));
    const propId = genesisPropId(genesisId, slug!), stateId = genesisPropStateId(genesisId, slug!, stateSlug!);
    const state = store.getBundle().props.find(prop => prop.id === propId)?.states.find(state => state.id === stateId);
    if (!state) throw new Error("The approved prop state did not land.");
    const candidate = selection.candidate, requestId = `founding-image:${selection.target}:${candidate.id}`;
    const bytes = await candidateBytes(workspace, candidate);
    const take = await recordUploadedPropImage(store, propId, stateId, `founding-${candidate.hash.slice(7, 23)}${extname(candidate.file)}`, bytes, {
      requestId, ...(candidate.source === "generated" ? { source: {
        provider: candidate.provider!, model: candidate.model!, jobId: JobIdSchema.parse(candidate.jobId), prompt: candidate.prompt ?? "",
        params: candidate.params ?? {}, cost: { estimatedMicroUsd: candidate.estimatedMicroUsd ?? 0, actualMicroUsd: ledger?.actualMicroUsd ?? null },
        dispatchedAt: candidate.createdAt,
      } } : {}),
    });
    if (state.reference?.sourceTakeId === take.id) return;
    const accepted = await acceptPropStateReference(store, { propId, stateId, selection: { source: "take", takeId: take.id } });
    if (accepted.status !== "accepted") throw new Error(accepted.reason);
    return;
  }
  const id = genesisSheetIds(blueprint).get(selection.target);
  const sheet = store.getBundle().sheets.find(sheet => sheet.id === id);
  if (!sheet) throw new Error("The approved image's sheet did not land.");
  const candidate = selection.candidate, bytes = await candidateBytes(workspace, candidate);
  const requestId = `founding-image:${selection.target}:${candidate.id}`;
  const media = `founding-${candidate.hash.slice(7, 23)}${extname(candidate.file)}`;
  let take;
  let sourceCandidate: string | undefined;
  if (candidate.source === "generated" && candidate.jobId) {
    const path = `references/${sheet.id}/candidates/${media}`;
    sourceCandidate = path;
    await store.ownedWrite(() => atomicWriteFile(join(store.dir, path), bytes));
    const job = JobSchema.parse({
      id: candidate.jobId, idempotencyKey: candidate.jobId.slice(3), worldId: store.worldId,
      target: { kind: sheet.type === "character" ? "main-photo-candidate" : "location-view-candidate", id: `${sheet.id}/founding` },
      capability: "image", provider: candidate.provider, model: candidate.model, params: { ...candidate.params,
        provenance: { canonRevision: store.getBundle().meta.canonRevision, sheets: { [sheet.id]: sheet.version },
          artDirectionVersion: store.getBundle().artDirection.version } },
      estimatedMicroUsd: candidate.estimatedMicroUsd ?? 0, status: "succeeded", providerJobId: null, attempt: 1, error: null,
      landedFiles: [path], createdAt: candidate.createdAt, updatedAt: candidate.createdAt,
    });
    take = await recordReferenceTake(store, job, ledger);
  } else {
    take = sheet.type === "character"
      ? await recordUploadedMainPhotoTake(store, sheet.id, media, bytes, { requestId })
      : await recordUploadedLocationViewTake(store, sheet.id, media, bytes, { requestId });
  }
  if (!take?.media) throw new Error("The approved image could not be recorded.");
  const kit = (await readKit(store, sheet.id))?.kit;
  if (sheet.type === "character") {
    if (kit?.mainPhoto?.sourceTakeId === take.id && !sourceCandidate) return;
    const result = await acceptMainPhoto(store, sheet, store.getBundle(), { source: "take", takeId: take.id }, sourceCandidate);
    if (result.status !== "accepted") throw new Error("The approved main photo could not be assigned.");
  } else {
    if (kit?.locationViews?.some(view => view.sourceTakeId === take.id && view.id === kit.establishingViewId)) return;
    await acceptLocationView(store, sheet, { id: take.id, name: "Establishing view", file: `takes/${take.id}/${take.media}`, takeId: take.id,
      sheetVersion: sheet.version, artDirectionVersion: store.getBundle().artDirection.version, establishing: true,
      review: referenceReviewDecision(store.now(), take, "accept") });
  }
}
