import { readFile, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { createHash } from "node:crypto";
import { JobSchema, genesisSheetIds, type GenesisBlueprint, type GenesisImageCandidate, type GenesisImageSelection, type LedgerEntry } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { atomicWriteFile } from "../world/atomic.js";
import { fileArtifact, fileGeneratedArtifact } from "../artifacts/filing.js";
import { genesisControlDir } from "./genesis-conversation.js";
import { savedGenesisImages } from "./genesis-images.js";
import { recordReferenceTake, recordUploadedMainPhotoTake, recordUploadedLocationViewTake, referenceReviewDecision } from "../references/takes.js";
import { acceptMainPhoto } from "../references/main-photo.js";
import { acceptLocationView, readKit } from "../references/kit.js";

async function candidateBytes(workspace: string, candidate: GenesisImageCandidate): Promise<Buffer> {
  const bytes = await readFile(join(genesisControlDir(workspace), candidate.file));
  if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== candidate.hash) throw new Error("The founding image changed after approval.");
  return bytes;
}

/** Provider inputs were sandbox-relative; permanent take provenance must travel with the world. */
async function worldImageParams(workspace: string, candidate: GenesisImageCandidate, store: WorldStore): Promise<Record<string, unknown>> {
  const params = { ...candidate.params };
  if (params.references === undefined) return params;
  if (!Array.isArray(params.references)) throw new Error("The image reference provenance is unreadable.");
  const references: string[] = [];
  for (const file of params.references) {
    if (typeof file !== "string" || !/^media\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(file)) throw new Error("The founding reference path is invalid.");
    const sourcePath = join(genesisControlDir(workspace), file);
    const bytes = await readFile(sourcePath);
    if (createHash("sha256").update(bytes).digest("hex") !== basename(file, extname(file))) throw new Error("A founding input image changed.");
    const filed = await fileArtifact(store, { sourcePath });
    if (filed.outcome === "refused" || filed.outcome === "needs-consent") throw new Error(filed.reason);
    references.push(`artifacts/${filed.artifact.file}`);
  }
  return { ...params, references };
}

export async function carryGenesisImageArtifacts(workspace: string, genesisId: string, blueprint: GenesisBlueprint, store: WorldStore,
  ledger: (jobId: string) => Promise<LedgerEntry | undefined>): Promise<void> {
  const images = await savedGenesisImages(workspace);
  const ids = genesisSheetIds(blueprint);
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
        provider: candidate.provider!, model: candidate.model!, prompt: candidate.prompt ?? "", params: await worldImageParams(workspace, candidate, store),
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
      capability: "image", provider: candidate.provider, model: candidate.model, params: { ...await worldImageParams(workspace, candidate, store),
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
    if (kit?.mainPhoto?.sourceTakeId === take.id) {
      if (sourceCandidate) await store.ownedWrite(() => rm(join(store.dir, sourceCandidate!), { force: true }));
      return;
    }
    const result = await acceptMainPhoto(store, sheet, store.getBundle(), { source: "take", takeId: take.id }, sourceCandidate);
    if (result.status !== "accepted") throw new Error("The approved main photo could not be assigned.");
  } else {
    if (kit?.locationViews?.some(view => view.sourceTakeId === take.id && view.id === kit.establishingViewId)) return;
    await acceptLocationView(store, sheet, { id: take.id, name: "Establishing view", file: `takes/${take.id}/${take.media}`, takeId: take.id,
      sheetVersion: sheet.version, artDirectionVersion: store.getBundle().artDirection.version, establishing: true,
      review: referenceReviewDecision(store.now(), take, "accept") });
  }
}
