import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";
import {
  ArkeGenerationBodySchema, JobSchema, ModelWorldChatActionSchema, ulid,
  type ArkeGenerationBody, type ConversationActionCard, type ModelWorldChatAction,
} from "@arke-studio/contracts";
import type { EnqueueInput } from "../queue/dispatcher.js";
import type { WorldStore } from "../world/store.js";
import type { ConversationActionExecutionOutcome } from "../arke-actions/lifecycle.js";
import { conversationActionDigest } from "../arke-actions/lifecycle.js";
import { atomicWriteFile } from "../world/atomic.js";
import { readContainedImageReferences, readContainedVideoReferences } from "../world/reference-files.js";

export interface GenerationQuoteSource {
  compile(action: ModelWorldChatAction, actionId: string, createdAt: string): Promise<{
    body: ArkeGenerationBody;
    inputs: readonly EnqueueInput[];
    /** Source-owned authority, such as a founding item, participates in staleness checks. */
    authority?: unknown;
    materialization?: unknown;
  }>;
  /** Bench reserves new take identities; those names do not change the authorized request. */
  compareInputs?(inputs: readonly EnqueueInput[]): unknown;
  beforeDispatch?(action: ModelWorldChatAction, actionId: string, inputs: readonly EnqueueInput[], materialization: unknown, createdAt: string): Promise<void>;
  dispatch?(action: ModelWorldChatAction, actionId: string, inputs: readonly EnqueueInput[], materialization: unknown): Promise<ConversationActionExecutionOutcome>;
  reconcile?(card: ConversationActionCard, action: ModelWorldChatAction, inputs: readonly EnqueueInput[]): Promise<ConversationActionExecutionOutcome | null>;
}

const InputSchema = JobSchema.pick({
  worldId: true, productionId: true, target: true, capability: true, provider: true, model: true,
  params: true, estimatedMicroUsd: true, landing: true, recipe: true, engine: true,
}).extend({ voiceReference: z.boolean().optional(), voiceUploadConfirmedFor: z.string().optional() }).strict();
const QuoteSchema = z.object({
  action: ModelWorldChatActionSchema, actionDigest: z.string(), createdAt: z.string(), fingerprint: z.string(),
  body: ArkeGenerationBodySchema,
  inputs: z.array(InputSchema.extend({ idempotencyKey: JobSchema.shape.idempotencyKey })),
  dispatchStarted: z.boolean().default(false), admissionComplete: z.boolean().default(false),
  admissionIndex: z.number().int().min(0).optional(),
  materialization: z.unknown().optional(),
}).strict();
type Quote = z.infer<typeof QuoteSchema>;
function sealedDigest(quote: Quote): string {
  const { quoteDigest: _quoteDigest, ...body } = quote.body;
  return conversationActionDigest({ action: quote.action, fingerprint: quote.fingerprint, inputs: quote.inputs,
    materialization: quote.materialization ?? null, body });
}

const admissions = new WeakMap<WorldStore, Map<string, Promise<void>>>();
async function serialiseAdmission<T>(store: WorldStore, key: string, work: () => Promise<T>): Promise<T> {
  let pending = admissions.get(store);
  if (!pending) { pending = new Map(); admissions.set(store, pending); }
  const previous = pending.get(key) ?? Promise.resolve();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  pending.set(key, barrier);
  await previous.catch(() => {});
  try { return await work(); }
  finally { release(); if (pending.get(key) === barrier) pending.delete(key); }
}

/** The pending card, rather than a process-local cache, owns the price and the dispatch inputs
 * (SPEC-050 R-11, SPEC-041 R-76). Recompilation never replaces an existing authorization. */
export class GenerationQuotes {
  constructor(private readonly store: WorldStore, private readonly source: GenerationQuoteSource,
    private readonly ports: { enqueue(input: EnqueueInput): Promise<unknown>; jobs(): readonly z.infer<typeof JobSchema>[]; actualCost?(jobId: string): Promise<number | null> }) {}

  private path(id: string) { return join(this.store.dir, ".history", "world", "prepared", `${id}.generation.json`); }
  private async read(id: string): Promise<Quote | null> {
    const raw = await readFile(this.path(id), "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    return raw === null ? null : QuoteSchema.parse(JSON.parse(raw));
  }
  private write(id: string, quote: Quote) {
    return this.store.ownedWrite(() => atomicWriteFile(this.path(id), JSON.stringify(QuoteSchema.parse(quote)) + "\n"));
  }
  async abandon(id: string) {
    const quote = await this.read(id);
    // A dispatched quote is recovery evidence, even after its preparation payload is gone.
    if (!quote?.dispatchStarted) await this.store.ownedWrite(() => rm(this.path(id), { force: true }));
  }
  private async compile(action: ModelWorldChatAction, id: string, at: string) {
    const resolved = await this.source.compile(action, id, at);
    // These screens own one pending candidate set. Keep it until selection/discard, and
    // serialize quote admissions so two cards cannot buy outputs at the same filenames.
    for (const kind of new Set(resolved.inputs.map(input => input.target.kind))) {
      if (kind !== "world-image" && kind !== "master-look") continue;
      const active = this.ports.jobs().some(job => job.worldId === this.store.worldId && job.target.kind === kind && !["succeeded", "failed", "cancelled"].includes(job.status));
      const names = await readdir(join(this.store.dir, "incoming", kind)).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      });
      if (active || names.some(name => [".png", ".jpg", ".jpeg", ".webp"].includes(extname(name).toLowerCase()))) {
        throw new Error(`The ${kind} surface already has work or pending candidates. Select, discard or reconcile them before preparing new generation.`);
      }
    }
    const inputs: EnqueueInput[] = [];
    for (const input of resolved.inputs) {
      if (input.worldId !== this.store.worldId) throw new Error("The generation quote belongs to another world.");
      const paths = input.params.references ?? [];
      if (!Array.isArray(paths) || !paths.every((path): path is string => typeof path === "string")) throw new Error("Invalid image references.");
      const files = await readContainedImageReferences(this.store.dir, paths);
      const videoPaths = input.params.videoReferences ?? [];
      if (!Array.isArray(videoPaths) || !videoPaths.every((path): path is string => typeof path === "string")) throw new Error("Invalid video references.");
      const videos = await readContainedVideoReferences(this.store.dir, videoPaths);
      inputs.push({ ...input, params: { ...input.params,
        generationQuoteReferences: paths.map((file, index) => ({ file, hash: createHash("sha256").update(files[index]!.data).digest("hex") })),
        ...(videoPaths.length ? { generationQuoteVideoReferences: videoPaths.map((file, index) => ({ file, hash: createHash("sha256").update(videos[index]!.data).digest("hex") })) } : {}),
      } });
    }
    const estimatedMicroUsd = inputs.reduce((sum, input) => sum + input.estimatedMicroUsd, 0);
    const quoteExpiresAt = new Date(Date.parse(at) + 15 * 60_000).toISOString();
    const fingerprint = conversationActionDigest({ action, inputs: this.source.compareInputs?.(inputs) ?? inputs, authority: resolved.authority ?? null, body: resolved.body, quoteExpiresAt });
    const body = ArkeGenerationBodySchema.parse({ ...resolved.body, quoteDigest: fingerprint, quoteExpiresAt,
      estimatedMicroUsd, currency: "USD", cost: estimatedMicroUsd === 0 ? "No provider charge" : `$${(estimatedMicroUsd / 1_000_000).toFixed(4)} estimated; actual cost may differ`,
      estimateMayVary: estimatedMicroUsd !== 0,
    });
    return { fingerprint, inputs, body, materialization: resolved.materialization };
  }
  async prepare(action: ModelWorldChatAction, id: string, at: string): Promise<ArkeGenerationBody> {
    const compiled = await this.compile(action, id, at);
    const existing = await this.read(id);
    if (existing) {
      if (existing.actionDigest !== conversationActionDigest(action) || existing.fingerprint !== compiled.fingerprint || existing.body.quoteDigest !== sealedDigest(existing)) throw new Error("Generation inputs changed. Prepare a fresh card.");
      return existing.body;
    }
    const quote: Quote = { action, actionDigest: conversationActionDigest(action), createdAt: at, fingerprint: compiled.fingerprint,
      body: compiled.body, inputs: compiled.inputs.map(input => ({ ...input, idempotencyKey: ulid() })), materialization: compiled.materialization, dispatchStarted: false, admissionComplete: false };
    quote.body.quoteDigest = sealedDigest(quote);
    await this.write(id, quote);
    return quote.body;
  }
  async validate(action: ModelWorldChatAction, id: string): Promise<Quote> {
    const quote = await this.read(id);
    if (!quote || quote.actionDigest !== conversationActionDigest(action) || quote.body.quoteDigest !== sealedDigest(quote)) throw new Error("The durable generation quote is unavailable. Prepare a fresh card.");
    if (Date.parse(quote.body.quoteExpiresAt!) <= Date.parse(this.store.now())) throw new Error("This generation quote expired. Prepare a fresh card.");
    if ((await this.compile(action, id, quote.createdAt)).fingerprint !== quote.fingerprint) throw new Error("Generation inputs changed. Prepare a fresh card.");
    return quote;
  }
  async dispatch(action: ModelWorldChatAction, id: string): Promise<ConversationActionExecutionOutcome> {
    const quote = await this.read(id);
    const surface = quote?.inputs.find(input => input.target.kind === "world-image" || input.target.kind === "master-look")?.target.kind;
    return serialiseAdmission(this.store, surface ? `surface:${surface}` : `action:${id}`, () => this.admit(action, id));
  }
  private async admit(action: ModelWorldChatAction, id: string): Promise<ConversationActionExecutionOutcome> {
    const existing = await this.read(id);
    if (existing?.dispatchStarted && existing.actionDigest === conversationActionDigest(action) && existing.body.quoteDigest === sealedDigest(existing)) return { status: "running", detail: "Rejoining the generation already authorized by this card." };
    const quote = await this.validate(action, id);
    await this.source.beforeDispatch?.(action, id, quote.inputs, quote.materialization, quote.createdAt);
    if (this.source.beforeDispatch) await this.validate(action, id);
    quote.dispatchStarted = true;
    await this.write(id, quote);
    if (this.source.dispatch) {
      try { return await this.source.dispatch(action, id, quote.inputs, quote.materialization); }
      catch { return { status: "running", detail: "Generation admission was interrupted. Existing work needs reconciliation in Activity." }; }
    }
    // The quote's keys survive any partial admission. An uncertain append is never retried by
    // this adapter: the existing queue reconciles its jobs, and missing work needs a new card.
    try { for (const [index, input] of quote.inputs.entries()) {
      quote.admissionIndex = index;
      await this.write(id, quote);
      await this.ports.enqueue(input);
    } }
    catch { return { status: "running", detail: "Generation admission was interrupted. Existing work needs reconciliation in Activity." }; }
    quote.admissionComplete = true;
    await this.write(id, quote);
    return { status: "queued", detail: `${quote.inputs.length} generation jobs queued.` };
  }
  async reconcile(card: ConversationActionCard): Promise<ConversationActionExecutionOutcome | null> {
    const quote = await this.read(card.actionId);
    if (!quote?.dispatchStarted) return null;
    if (this.source.reconcile) return this.source.reconcile(card, quote.action, quote.inputs);
    const jobs = quote.inputs.map(input => this.ports.jobs().find(job => job.worldId === this.store.worldId && job.idempotencyKey === input.idempotencyKey));
    if (!quote.admissionComplete && (quote.admissionIndex === undefined || jobs.some((job, index) => !job && index <= quote.admissionIndex!))) {
      return { status: "running", detail: "Generation admission needs reconciliation in Activity; its uncertain purchase was not resubmitted." };
    }
    if (jobs.some(job => job && !["succeeded", "failed", "cancelled"].includes(job.status))) return { status: "running", detail: "Generation jobs are still active or need reconciliation in Activity." };
    if (jobs.some(job => job?.finalization?.status === "pending")) return { status: "running", detail: "Generation results are being filed." };
    const results = jobs.flatMap(job => {
      if (!job) return [];
      const take = this.store.getBundle().referenceTakes.find(take => take.jobId === job.id);
      const production = this.store.getBundle().productions.find(production => production.meta.id === job.productionId);
      const productionTake = job.params.generationQuoteProduction === true ? production?.takes.find(take => take.jobId === job.id && take.media) : undefined;
      const owner = take?.reference?.sheetId ?? take?.prop?.propId;
      const mediaPath = job.params.generationQuoteProduction === true ? productionTake?.media ? `productions/${job.productionId}/takes/${productionTake.id}/${productionTake.media}` : undefined
        : take?.media && owner ? `references/${owner}/takes/${take.id}/${take.media}` : job.landedFiles?.[0];
      return [{ id: productionTake?.id ?? take?.id ?? job.id, medium: job.capability === "video" ? "video" as const : "image" as const,
      status: job.status === "succeeded" && job.finalization?.status !== "failed" && mediaPath ? "completed" as const : job.status === "cancelled" ? "cancelled" as const : "failed" as const,
      description: job.error ?? (job.finalization?.status === "failed" ? "Result filing needs retry in Activity."
        : job.status === "succeeded" && !mediaPath ? "The provider returned no landed media." : "Generation settled."),
      ...(mediaPath ? { mediaPath } : {}),
    }]; });
    const completed = results.filter(result => result.status === "completed").length;
    const cancelled = results.filter(result => result.status === "cancelled").length;
    const costs = await Promise.all(jobs.map(job => job ? this.ports.actualCost?.(job.id).catch(() => null) ?? null : null));
    const actualMicroUsd = costs.every(cost => cost !== null) ? costs.reduce<number>((sum, cost) => sum + cost!, 0) : null;
    return { status: completed > 0 ? "completed" : cancelled === quote.inputs.length ? "cancelled" : "failed",
      receipt: { kind: "generation", id: card.actionId, summary: quote.admissionComplete
        ? completed > 0 ? "Generation settled; results await separate selection." : "Generation settled without a usable result."
        : "Admission was interrupted; missing work was not resubmitted.",
        generation: { authorized: quote.inputs.length, completed, failed: results.length - completed - cancelled, cancelled,
          unattempted: quote.inputs.length - results.length, actualMicroUsd, results } },
    };
  }
}
