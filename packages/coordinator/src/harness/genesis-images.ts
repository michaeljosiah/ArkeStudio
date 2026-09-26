import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import {
  GenesisImagesSchema, estimateMicroUsd, imageOutputFor, imageConstraintSuffix,
  type GenesisBlueprint, type GenesisImageCandidate, type GenesisImagePlan, type GenesisImages,
  type Job, type ManifestModel,
} from "@arke-studio/contracts";
import { atomicWriteFile, serializeFileMutation } from "../world/atomic.js";
import { conversationActionDigest } from "../arke-actions/digest.js";
import { genesisControlDir, genesisConversation } from "./genesis-conversation.js";
import { sandboxAttachments } from "../artifacts/genesis-attachments.js";
import type { EnqueueInput } from "../queue/dispatcher.js";
import { referenceBudgetFor } from "../references/generate.js";
import { imageFormatOf } from "../queue/verify.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const statePath = (dir: string) => join(genesisControlDir(dir), "images.json");
const empty = (): GenesisImages => ({ plans: [], candidates: [], selections: [], rejected: [], problems: [] });
export async function savedGenesisImages(dir: string): Promise<GenesisImages> {
  const state = await readFile(statePath(dir), "utf8").then(raw => GenesisImagesSchema.parse(JSON.parse(raw)))
    .catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return empty(); throw err; });
  const { events, problems } = await (await genesisConversation(dir)).read();
  if (problems.length) throw new Error("The image decision history needs repair.");
  state.selections = []; state.rejected = [];
  for (const { event } of events) {
    if (event.type !== "founding.image-decision") continue;
    // The flushed journal owns reviewed bytes even if the derived candidate cache is lost.
    if (event.candidate && !state.candidates.some(candidate => candidate.id === event.candidate!.id)) state.candidates.push(event.candidate);
    if (event.decision === "unassign") state.selections = state.selections.filter(selection => selection.target !== event.target);
    else if (event.candidate && event.decision === "approve") {
      state.selections = [...state.selections.filter(selection => selection.target !== event.target), { target: event.target, candidate: event.candidate }];
      state.rejected = state.rejected.filter(id => id !== `${event.target}/${event.candidate!.id}`);
    } else if (event.candidate) {
      state.selections = state.selections.filter(selection => selection.target !== event.target || selection.candidate.id !== event.candidate!.id);
      state.rejected.push(`${event.target}/${event.candidate.id}`);
    }
  }
  return state;
}

async function containedBytes(root: string, path: string): Promise<Buffer> {
  const resolvedRoot = await realpath(root), resolvedFile = await realpath(path);
  const rel = relative(resolvedRoot, resolvedFile);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("The image is outside this conversation.");
  const info = await stat(resolvedFile);
  if (!info.isFile() || info.size > 50 * 1024 * 1024) throw new Error("The image cannot be previewed.");
  return readFile(resolvedFile);
}

async function freezeImage(dir: string, path: string, info: Omit<GenesisImageCandidate, "file" | "hash">): Promise<GenesisImageCandidate> {
  const bytes = await containedBytes(dir, path);
  const ext = extname(path).toLowerCase().replace(".jpeg", ".jpg");
  if (![".png", ".jpg", ".webp"].includes(ext)) throw new Error("Use a PNG, JPEG or WebP image.");
  if (imageFormatOf(bytes)?.extension !== ext) throw new Error("The image bytes do not match a supported image format.");
  const digest = hash(bytes), file = `media/${digest}${ext}`;
  const destination = join(genesisControlDir(dir), file);
  await atomicWriteFile(destination, bytes);
  return { ...info, file, hash: `sha256:${digest}` };
}

export function genesisImageTarget(blueprint: GenesisBlueprint, target: string) {
  const [kind, slug, stateSlug] = target.split(":");
  if (kind === "prop") {
    const prop = blueprint.props?.find(prop => prop.slug === slug);
    const state = prop?.states.find(state => state.slug === stateSlug);
    if (!prop || !state) throw new Error("The proposed image no longer has a prop state.");
    return { entity: { name: `${prop.name} · ${state.name}` }, role: "Prop state reference" as const };
  }
  const entity = kind === "character" ? blueprint.characters.find(entity => entity.slug === slug)
    : kind === "location" ? blueprint.locations.find(entity => entity.slug === slug) : undefined;
  if (!entity) throw new Error("The proposed image no longer has a character or location.");
  if ("neverDepicted" in entity && entity.neverDepicted) throw new Error(`${entity.name} is never depicted.`);
  return { entity, role: kind === "character" ? "Main photo" as const : "Establishing view" as const };
}

/** Capture review bytes outside the harness boundary before showing or authorizing them. */
export async function reviewGenesisImages(dir: string, blueprint: GenesisBlueprint, jobs: readonly Job[], model: ManifestModel | null): Promise<GenesisImages> {
  return serializeFileMutation(statePath(dir), async () => {
    const state = await savedGenesisImages(dir);
    const problems: string[] = [];
    for (const path of await sandboxAttachments(dir)) {
      if (!/\.(png|jpe?g|webp)$/i.test(path)) continue;
      try {
        const image = await freezeImage(dir, path, { id: "", label: basename(path), source: "upload", createdAt: new Date().toISOString() });
        image.id = `upload:${image.hash.slice(7)}:${basename(path)}`;
        if (!state.candidates.some(candidate => candidate.id === image.id)) state.candidates.push(image);
      } catch { problems.push(`${basename(path)} could not be previewed.`); }
    }
    for (const job of jobs) {
      if (job.target.kind !== "genesis-image" || job.status !== "succeeded" || state.candidates.some(candidate => candidate.jobId === job.id)) continue;
      const file = job.landedFiles?.[0];
      if (!file || !job.target.id) continue;
      try {
        state.candidates.push(await freezeImage(dir, join(dir, file), {
          id: job.id, label: String(job.params["label"] ?? "Generated image"), source: "generated", target: job.target.id,
          jobId: job.id, prompt: String(job.params["prompt"] ?? ""), provider: job.provider, model: job.model,
          ...(job.recipe ? { recipe: job.recipe } : {}), params: job.params, estimatedMicroUsd: job.estimatedMicroUsd, createdAt: job.createdAt,
        }));
      } catch { problems.push("A generated image could not be preserved. Resolve this before founding."); }
    }
    const plans: GenesisImagePlan[] = [];
    for (const intent of blueprint.images ?? []) {
      try {
        const { entity, role } = genesisImageTarget(blueprint, intent.target);
        if (!model) throw new Error("Choose an available image model in Settings.");
        const references = intent.references.map(name => {
          const candidate = state.candidates.findLast(candidate => candidate.source === "upload" && candidate.label === name);
          if (!candidate) throw new Error(`The reference ${name} is unavailable.`);
          return candidate;
        });
        if (references.length > referenceBudgetFor(model)) throw new Error(`${model.displayName} cannot use all ${references.length} references. Choose another model or revise the references.`);
        const output = imageOutputFor(model, { landscape: intent.target.startsWith("location:") });
        const prompt = `${intent.prompt}${imageConstraintSuffix(undefined)}`;
        const plan = { intent, title: entity.name, role, model: model.id, provider: model.provider, modelName: model.displayName, prompt, output: { ...output }, references,
          estimatedMicroUsd: estimateMicroUsd(model, { images: 1, megapixels: output.width * output.height / 1_000_000, referenceImages: references.length,
            ...(output.resolution ? { resolution: output.resolution } : {}) }) };
        plans.push({ ...plan, digest: conversationActionDigest(plan) });
      } catch (err) { problems.push(err instanceof Error ? err.message : "The image proposal needs revision."); }
    }
    const result = GenesisImagesSchema.parse({ ...state, plans, problems });
    await atomicWriteFile(statePath(dir), JSON.stringify(result) + "\n");
    return result;
  });
}

export function genesisImageRequest(genesisId: string, plan: GenesisImagePlan, requestId: string): EnqueueInput {
  return { worldId: genesisId, idempotencyKey: requestId, target: { kind: "genesis-image", id: plan.intent.target }, capability: "image",
    provider: plan.provider, model: plan.model,
    params: { prompt: plan.prompt, references: plan.references.map(reference => reference.file), output: plan.output,
      label: `${plan.title} — ${plan.role}`, previewDigest: plan.digest },
    estimatedMicroUsd: plan.estimatedMicroUsd, landing: { dir: "generated", name: `${requestId}.png` } };
}

export async function decideGenesisImage(dir: string, blueprint: GenesisBlueprint,
  input: { target: string; requestId: string; candidateId?: string; hash?: string; decision: "approve" | "reject" | "unassign" }): Promise<GenesisImages> {
  return serializeFileMutation(statePath(dir), async () => {
    if (input.decision !== "unassign") genesisImageTarget(blueprint, input.target);
    const state = await savedGenesisImages(dir);
    const log = await genesisConversation(dir);
    if (input.decision === "unassign") {
      const selected = state.selections.find(selection => selection.target === input.target)?.candidate;
      if (!selected || selected.id !== input.candidateId || selected.hash !== input.hash) throw new Error("The selected image changed. Review the current assignment before removing it.");
      await log.append({ type: "founding.image-decision", target: input.target, decision: input.decision }, { at: new Date().toISOString(), requestId: input.requestId });
      state.selections = state.selections.filter(selection => selection.target !== input.target);
    } else {
      const candidate = state.candidates.find(candidate => candidate.id === input.candidateId && candidate.hash === input.hash);
      if (!candidate) throw new Error("Review the current image before deciding.");
      if (candidate.source === "generated" && candidate.target !== input.target) throw new Error("This generation was proposed for a different character or location.");
      const bytes = await containedBytes(join(genesisControlDir(dir), "media"), join(genesisControlDir(dir), candidate.file));
      if (`sha256:${hash(bytes)}` !== candidate.hash) throw new Error("The image changed. Review it again.");
      await log.append({ type: "founding.image-decision", target: input.target, candidate, decision: input.decision }, { at: new Date().toISOString(), requestId: input.requestId });
      if (input.decision === "approve") {
        state.selections = [...state.selections.filter(selection => selection.target !== input.target), { target: input.target, candidate }];
        state.rejected = state.rejected.filter(id => id !== `${input.target}/${candidate.id}`);
      } else {
        state.selections = state.selections.filter(selection => selection.target !== input.target || selection.candidate.id !== candidate.id);
        state.rejected = [...new Set([...state.rejected, `${input.target}/${candidate.id}`])];
      }
    }
    await atomicWriteFile(statePath(dir), JSON.stringify(state) + "\n");
    return savedGenesisImages(dir);
  });
}

export async function reviewedGenesisImages(dir: string, approved: GenesisBlueprint, jobs: readonly Job[]): Promise<GenesisBlueprint> {
  if (jobs.some(job => job.target.kind === "genesis-image" && !["succeeded", "failed", "cancelled"].includes(job.status))) {
    throw new Error("Wait for image generation to finish or cancel it before founding.");
  }
  const state = await savedGenesisImages(dir);
  if (jobs.some(job => job.target.kind === "genesis-image" && job.status === "succeeded" && !state.candidates.some(candidate => candidate.jobId === job.id))) {
    throw new Error("Review the finished images before founding so their results can be preserved.");
  }
  for (const candidate of state.candidates) {
    const bytes = await containedBytes(join(genesisControlDir(dir), "media"), join(genesisControlDir(dir), candidate.file))
      .catch(() => { throw new Error("A retained image needs repair before founding."); });
    if (`sha256:${hash(bytes)}` !== candidate.hash) throw new Error("A retained image needs repair before founding.");
  }
  for (const selection of state.selections) genesisImageTarget(approved, selection.target);
  return state.selections.length ? { ...approved, selectedImages: state.selections } : approved;
}
