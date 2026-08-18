import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  canDeleteJob,
  credentialKindOf,
  formatMicroUsd,
  PROVIDERS,
  REFERENCE_FINALIZATION_TARGETS,
  REPLAYABLE_FINALIZATION_TARGETS,
  ulid,
  type Capability,
  type ClientDeclarations,
  type ComfyUiRecoveryDecision,
  type DomainEvent,
  type Job,
  type JobEngineIdentity,
  type JobTarget,
  type LedgerEntry,
  type QueueStatus,
  type RecipeIdentity,
  type ReconcileAction,
} from "@arke-studio/contracts";
import { toExtendedLength } from "../world/paths.js";
import { backoffMs, classifyError, isRateLimit, type FailureClass } from "./classify.js";
import { JobJournal } from "./journal.js";
import { imageFormatOf, verifyArtifact } from "./verify.js";

/**
 * The dispatch engine (SPEC-009): durable before the network, and never trust silence. Every
 * state transition is appended to the journal before the action it authorises (D1), and a gap
 * in observation is an unknown to reconcile, never a failure to retry (D2).
 */

// ---- the provider surface this engine dispatches through --------------------

export interface DispatchArtifact {
  name: string;
  contentType: string;
  data: Uint8Array;
}

export interface DispatchImageReference {
  name: string;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  data: Uint8Array;
}

export interface DispatchClient {
  readonly declarations: ClientDeclarations;
  submit(
    key: string,
    request: {
      model: string;
      capability: Capability;
      params: Record<string, unknown>;
      imageReferences?: DispatchImageReference[];
      idempotencyKey?: string;
      /** The recipe identity frozen at enqueue, so the client can refuse a moved catalogue (R-15). */
      recipe?: RecipeIdentity;
    },
    context?: { jobId?: string; attempt?: number; model?: string },
  ): Promise<{ remoteId: string; artifacts?: DispatchArtifact[] }>;
  poll(
    key: string,
    remoteId: string,
    context?: { jobId?: string; attempt?: number; model?: string },
  ): Promise<{ state: "queued" | "running" | "succeeded" | "failed" | "cancelled"; costMicroUsd?: number; error?: string }>;
  fetchArtifacts(key: string, remoteId: string, context?: { jobId?: string; attempt?: number; model?: string }): Promise<DispatchArtifact[]>;
  cancel(key: string, remoteId: string, context?: { jobId?: string; attempt?: number; model?: string }): Promise<void>;
  /** Reconciliation strategy A (SPEC-008 declarations): found → adopt; null → provably absent. */
  lookupByKey?(key: string, idempotencyKey: string, context?: { jobId?: string; attempt?: number; model?: string }): Promise<{ remoteId: string } | null>;
  /** Reconciliation strategy B: recent jobs, newest first, carrying the caller's key. */
  listRecent?(key: string, context?: { jobId?: string; attempt?: number; model?: string }): Promise<Array<{ remoteId: string; idempotencyKey?: string; createdAt: string }>>;
}

export interface EnqueueInput {
  worldId: string;
  productionId?: string;
  target: JobTarget;
  capability: Capability;
  provider: string;
  model: string;
  params: Record<string, unknown>;
  estimatedMicroUsd: number;
  landing?: { dir: string; name?: string };
  /** Frozen recipe identity for a local-recipe dispatch (SPEC-021 §2.11, R-15). */
  recipe?: RecipeIdentity;
  /** Frozen engine identity — source kind and opaque instance digest, never a path. */
  engine?: JobEngineIdentity;
}

export interface JobQueueOptions {
  journalPath: string;
  clients: Record<string, DispatchClient>;
  getKey: (provider: string) => Promise<string | null>;
  emit: (event: DomainEvent) => void;
  /** The idempotency seam (R-16): startup snapshots once; runtime checks the live ledger. */
  ledger: {
    readJobIds(): Promise<ReadonlySet<string>>;
    has(jobId: string): Promise<boolean>;
    append(entry: LedgerEntry): Promise<void>;
  };
  /**
   * Run landing under the owning world's lock. False means the destination is temporarily
   * unavailable; provider success stays running and retries locally without another submit.
   */
  landInWorld: (worldId: string, fn: (worldDir: string) => Promise<void>) => Promise<boolean>;
  /** Resolve durable portable paths into ephemeral verified bytes before paid provider I/O. */
  readImageReferences?: (worldId: string, paths: readonly string[]) => Promise<DispatchImageReference[]>;
  /** A provider fault surfaced once, in provider terms (SPEC-008 R-4). */
  onProviderFault?: (provider: string, message: string) => void;
  /** Fired after a job reaches terminal state and its ledger entry landed (SPEC-010 tile flows). */
  onTerminal?: (job: Job) => void | Promise<void>;
  /** Safe operational notice for a persisted domain-finalization failure. */
  onFinalizationFailure?: (job: Job) => void;
  /**
   * Coordinator enqueue admission (SPEC-021 §2.12, R-16): consulted before anything is
   * journalled, so a stale picker can never commit work the coordinator knows cannot run.
   * A refusal's reason is the readiness reason, and it reaches the caller as the failure.
   */
  admit?: (input: EnqueueInput) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Recovery policy for a local provider's non-terminal jobs (SPEC-021 §2.11): a decision per
   * engine source instead of the declaration-driven default. Null means "no policy — use the
   * standing behaviour", which is what every cloud job gets.
   */
  recoverLocal?: (job: Job, prior: Job | undefined) => ComfyUiRecoveryDecision | null;
  /**
   * Last transform before verification and landing (SPEC-021 §2.10): media sanitisation for
   * providers whose engines embed workflow metadata. A refusal fails the job with the reason —
   * an unsanitisable artifact is never landed as-is.
   */
  prepareArtifact?: (
    job: Job,
    artifact: DispatchArtifact,
  ) => { ok: true; artifact: DispatchArtifact } | { ok: false; reason: string };
  clock?: () => string;
  rng?: () => number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  pollIntervalMs?: number;
  /** How long after an offline pause the lane retries by itself (R-17). */
  offlineRetryMs?: number;
  baseConcurrency?: number;
  baseIntervalMs?: number;
}

interface Lane {
  provider: string;
  fifo: string[];
  inFlight: Set<string>;
  paused: { kind: "fault" | "offline" | "credential"; reason: string } | null;
  maxConcurrent: number;
  minIntervalMs: number;
  nextAllowedAt: number;
  successStreak: number;
  timer: NodeJS.Timeout | null;
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const FORMAT_PRESERVING_IMAGE_TARGETS = new Set([
  "main-photo-candidate",
  "establish-candidate",
  "character-sheet",
  "character-look",
  "reference-tile",
]);
const FOLLOW_ON_TARGETS = new Set([
  ...REFERENCE_FINALIZATION_TARGETS,
  "reference-tile",
  "shot",
  "scene-pass",
  "voice-line",
  "voice-preview",
]);

/**
 * Fold current state, prior state, and durable submission count in one history pass. A job whose
 * latest record carries `deletedAt` is dropped: the user removed it from Activity, and recovery
 * has nothing to do with a row that no longer exists. Its ledger entry is unaffected.
 */
export function foldJobHistory(history: Iterable<Job>): Array<{ job: Job; prior: Job | undefined }> {
  const byId = new Map<string, { latest: Job; prior: Job | undefined; submitting: number }>();
  for (const row of history) {
    const folded = byId.get(row.id);
    if (folded) {
      folded.prior = folded.latest;
      folded.latest = row;
      if (row.status === "submitting") folded.submitting += 1;
    } else {
      byId.set(row.id, {
        latest: row,
        prior: undefined,
        submitting: row.status === "submitting" ? 1 : 0,
      });
    }
  }
  return [...byId.values()]
    .filter(({ latest }) => latest.deletedAt === undefined)
    .map(({ latest, prior, submitting }) => ({
      job: submitting > latest.attempt ? { ...latest, attempt: submitting } : latest,
      prior,
    }));
}

function landedName(job: Job, artifact: DispatchArtifact, index: number): string {
  const requested = index === 0 && job.landing?.name !== undefined ? job.landing.name : artifact.name;
  if (!FORMAT_PRESERVING_IMAGE_TARGETS.has(job.target.kind)) return requested;
  const format = imageFormatOf(artifact.data);
  if (format === null) return requested;
  const extension = extname(requested);
  return `${extension.length > 0 ? requested.slice(0, -extension.length) : requested}${format.extension}`;
}

export class JobQueue {
  private readonly journal: JobJournal;
  private readonly jobs = new Map<string, Job>();
  private readonly lanes = new Map<string, Lane>();
  private readonly clock: () => string;
  private readonly rng: () => number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly pollIntervalMs: number;
  private readonly offlineRetryMs: number;
  private readonly baseConcurrency: number;
  private readonly baseIntervalMs: number;
  private disposed = false;
  private accepting = false;
  private readonly resolvingHeld = new Set<string>();
  private readonly finalizing = new Set<string>();
  private readonly activeRuns = new Set<Promise<void>>();

  constructor(private readonly opts: JobQueueOptions) {
    this.journal = new JobJournal(opts.journalPath);
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.rng = opts.rng ?? Math.random;
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
    this.backoffCapMs = opts.backoffCapMs ?? 30_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1500;
    this.offlineRetryMs = opts.offlineRetryMs ?? 15_000;
    this.baseConcurrency = opts.baseConcurrency ?? 2;
    this.baseIntervalMs = opts.baseIntervalMs ?? 200;
  }

  // ---- plumbing -------------------------------------------------------------

  private lane(provider: string): Lane {
    let lane = this.lanes.get(provider);
    if (!lane) {
      lane = {
        provider,
        fifo: [],
        inFlight: new Set(),
        paused: null,
        maxConcurrent: this.baseConcurrency,
        minIntervalMs: this.baseIntervalMs,
        nextAllowedAt: 0,
        successStreak: 0,
        timer: null,
      };
      this.lanes.set(provider, lane);
    }
    return lane;
  }

  /** Durable transition: journal first, then memory, then the event (D1). */
  private async transition(job: Job): Promise<void> {
    if (this.disposed) return;
    await this.journal.append(job);
    if (this.disposed) return; // killed mid-write: the journal decides on recovery
    this.jobs.set(job.id, job);
    this.opts.emit({ at: this.clock(), type: "job.updated", job });
  }

  private emitQueueStatus(provider: string): void {
    if (this.disposed) return;
    this.opts.emit({ at: this.clock(), type: "queue.status", queue: this.queueStatus(provider) });
  }

  queueStatus(provider: string): QueueStatus {
    const lane = this.lane(provider);
    let held = 0;
    for (const job of this.jobs.values()) {
      if (job.provider !== provider) continue;
      if (job.status === "needs-reconciliation") held += 1;
      else if (lane.paused && !TERMINAL.has(job.status)) held += 1;
    }
    return {
      provider,
      paused: lane.paused !== null,
      ...(lane.paused ? { pauseKind: lane.paused.kind } : {}),
      ...(lane.paused ? { reason: lane.paused.reason } : {}),
      held,
    };
  }

  /** FIFO position among not-yet-running jobs of this provider (R-11). 0 = next up. */
  queuePosition(jobId: string): number | null {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "queued") return null;
    const lane = this.lane(job.provider);
    const i = lane.fifo.indexOf(jobId);
    return i === -1 ? null : i;
  }

  listJobs(): Job[] {
    return [...this.jobs.values()];
  }

  // ---- enqueue and pump -----------------------------------------------------

  /** Durable before any network call (R-1): the returned job is already journalled. */
  async enqueue(input: EnqueueInput): Promise<Job> {
    if (!this.accepting) throw new Error("the queue is not accepting work yet (recovery first, R-18)");
    // Admission before durability (SPEC-021 R-16): a dispatch the coordinator knows cannot run
    // is refused with the readiness reason, and nothing is journalled for it.
    const admitted = await this.opts.admit?.(input);
    if (admitted !== undefined && !admitted.ok) throw new Error(admitted.reason);
    const now = this.clock();
    const job: Job = {
      id: `jb_${ulid()}`,
      idempotencyKey: ulid(), // generated and persisted before submission (R-2)
      worldId: input.worldId,
      ...(input.productionId !== undefined ? { productionId: input.productionId } : {}),
      target: input.target,
      capability: input.capability,
      provider: input.provider,
      model: input.model,
      params: input.params,
      estimatedMicroUsd: input.estimatedMicroUsd,
      // Identity frozen before the journal line exists (SPEC-021 §2.11): what this job IS can
      // never depend on what the catalogue or Settings hold by the time it runs.
      ...(input.recipe !== undefined ? { recipe: input.recipe } : {}),
      ...(input.engine !== undefined ? { engine: input.engine } : {}),
      status: "queued",
      providerJobId: null,
      attempt: 0,
      ...(input.landing !== undefined ? { landing: input.landing } : {}),
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.transition(job);
    this.lane(job.provider).fifo.push(job.id);
    this.pump(job.provider);
    return job;
  }

  private pump(provider: string): void {
    if (this.disposed) return;
    const lane = this.lane(provider);
    if (lane.paused) return;
    const now = Date.now();
    if (now < lane.nextAllowedAt) {
      this.schedule(lane, lane.nextAllowedAt - now);
      return;
    }
    while (lane.inFlight.size < lane.maxConcurrent && lane.fifo.length > 0) {
      const jobId = lane.fifo.shift()!;
      const job = this.jobs.get(jobId);
      if (!job || job.status !== "queued") continue;
      lane.inFlight.add(jobId);
      lane.nextAllowedAt = Date.now() + lane.minIntervalMs;
      const run = this.runJob(job).finally(() => {
        lane.inFlight.delete(jobId);
        this.pump(provider);
        this.activeRuns.delete(run);
      });
      this.activeRuns.add(run);
      if (Date.now() < lane.nextAllowedAt) {
        this.schedule(lane, lane.nextAllowedAt - Date.now());
        break;
      }
    }
  }

  private schedule(lane: Lane, delayMs: number): void {
    if (this.disposed || lane.timer) return;
    lane.timer = setTimeout(() => {
      lane.timer = null;
      this.pump(lane.provider);
    }, Math.max(1, delayMs));
    lane.timer.unref?.();
  }

  private trackRun(work: Promise<void>): void {
    this.activeRuns.add(work);
    void work.finally(() => this.activeRuns.delete(work)).catch(() => {});
  }

  private pauseLane(provider: string, kind: "fault" | "offline" | "credential", reason: string): void {
    const lane = this.lane(provider);
    const previousKind = lane.paused?.kind;
    lane.paused = { kind, reason };
    if (previousKind !== kind) {
      // Told once (R-8) — and only a real fault is a provider fault upstream.
      if (kind === "fault") this.opts.onProviderFault?.(provider, reason);
      this.emitQueueStatus(provider);
    }
    if (kind === "offline") {
      // Offline resumes by itself when connectivity returns (R-17): the retry is the probe.
      const timer = setTimeout(() => {
        if (this.disposed) return;
        const current = this.lane(provider);
        if (current.paused?.kind === "offline") this.resume(provider);
      }, this.offlineRetryMs);
      timer.unref?.();
    }
  }

  /** Resume a paused lane. For fault pauses this is the user's explicit confirmation (D7). */
  resume(provider: string): void {
    const lane = this.lane(provider);
    if (!lane.paused) return;
    lane.paused = null;
    // Whatever was mid-flight when the pause hit went back to queued; rebuild the FIFO.
    this.rebuildFifo(provider);
    this.emitQueueStatus(provider);
    this.pump(provider);
  }

  private rebuildFifo(provider: string): void {
    const lane = this.lane(provider);
    const queued = [...this.jobs.values()]
      .filter((j) => j.provider === provider && j.status === "queued" && !lane.inFlight.has(j.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    lane.fifo = queued.map((j) => j.id);
  }

  // ---- the outbox protocol (§2.3) ------------------------------------------

  private async runJob(job: Job): Promise<void> {
    if (this.disposed) return;
    const client = this.opts.clients[job.provider];
    if (!client) {
      await this.terminalize({ ...job, attempt: job.attempt }, "failed", `no client for provider "${job.provider}"`);
      return;
    }
    const key = await this.keyFor(job.provider);
    if (key === null) {
      // Not the job's fault: hold the lane, keep the job queued (R-8 posture).
      await this.transition({ ...job, status: "queued", updatedAt: this.clock() });
      this.lane(job.provider).fifo.unshift(job.id);
      this.pauseLane(job.provider, "credential", "no credential stored for this provider");
      return;
    }
    if (this.jobs.get(job.id)?.status !== "queued") return;

    let imageReferences: DispatchImageReference[] | undefined;
    const referencePaths = job.params["references"];
    if (Array.isArray(referencePaths) && referencePaths.length > 0) {
      if (!referencePaths.every((path): path is string => typeof path === "string")) {
        await this.terminalize(job, "failed", "image reference paths are invalid");
        return;
      }
      if (!this.opts.readImageReferences) {
        await this.terminalize(job, "failed", "image reference transport is not configured");
        return;
      }
      try {
        imageReferences = await this.opts.readImageReferences(job.worldId, referencePaths);
      } catch (error) {
        await this.terminalize(
          job,
          "failed",
          error instanceof Error ? error.message : "image references could not be prepared",
        );
        return;
      }
      if (imageReferences.length !== referencePaths.length || imageReferences.length > 16) {
        await this.terminalize(job, "failed", "not every image reference could be prepared safely");
        return;
      }
    }
    if (this.jobs.get(job.id)?.status !== "queued") return;

    // Persist the physical call before I/O. A crash may overcount one authorized call, but the
    // journal can never undercount requests that may have reached a paid provider.
    const submitting: Job = { ...job, status: "submitting", attempt: job.attempt + 1, updatedAt: this.clock() };
    await this.transition(submitting);
    if (this.disposed) return;
    if (this.jobs.get(job.id)?.status !== "submitting") return;

    try {
      // ③ the point of uncertainty.
      const accepted = await client.submit(
        key,
        {
          model: job.model,
          capability: job.capability,
          params: job.params,
          ...(imageReferences ? { imageReferences } : {}),
          ...(client.declarations.supportsIdempotencyKey ? { idempotencyKey: job.idempotencyKey } : {}),
          // What this job IS, frozen before it was journalled (R-15). Carried unconditionally:
          // a client that does not use it ignores it, and one that does can refuse a graph that
          // is no longer the one the job was accepted as.
          ...(job.recipe !== undefined ? { recipe: job.recipe } : {}),
        },
        { jobId: job.id, attempt: submitting.attempt, model: job.model },
      );
      if (this.disposed) return; // killed between accept and the record landing → reconciliation
      if (this.jobs.get(job.id)?.status === "cancelled") {
        // Cancelled while the submit was in flight: cancel remotely, never resurrect (§2.10).
        await client.cancel(key, accepted.remoteId, { jobId: job.id, attempt: submitting.attempt, model: job.model }).catch(() => {});
        return;
      }
      if (accepted.artifacts) {
        await this.landAndSucceed(
          { ...submitting, providerJobId: accepted.remoteId },
          client,
          key,
          undefined,
          accepted.artifacts,
        );
        return;
      }
      // ④ the uncertainty closes.
      const running: Job = { ...submitting, status: "running", providerJobId: accepted.remoteId, updatedAt: this.clock() };
      await this.transition(running);
      this.noteSuccess(job.provider);
      await this.pollToTerminal(running, client, key);
    } catch (err) {
      if (this.disposed) return;
      if (this.jobs.get(job.id)?.status === "cancelled") return; // already terminal by the user
      await this.handleSubmitError(submitting, client, err);
    }
  }

  private async handleSubmitError(job: Job, client: DispatchClient, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const klass: FailureClass = classifyError(err);
    if (isRateLimit(err)) this.noteRateLimit(job.provider);
    const local = (PROVIDERS as Record<string, { local: boolean } | undefined>)[job.provider]?.local === true;
    if (typeof err === "object" && err !== null && "submissionRejected" in err) {
      await this.terminalize(job, "failed", message);
      return;
    }
    if (!local && !client.declarations.supportsIdempotencyKey) {
      await this.holdForUser(job);
      if (klass === "provider-fault") this.pauseLane(job.provider, "fault", message);
      return;
    }
    switch (klass) {
      case "provider-fault": {
        // The job was never wrong — the credential was (R-8). Back to queued, lane paused.
        await this.transition({ ...job, status: "queued", updatedAt: this.clock() });
        this.lane(job.provider).fifo.unshift(job.id);
        this.pauseLane(job.provider, "fault", message);
        return;
      }
      case "offline": {
        if (job.attempt >= this.maxAttempts) {
          await this.terminalize(job, "failed", `gave up after ${job.attempt} attempts: ${message}`);
          return;
        }
        await this.transition({ ...job, status: "queued", updatedAt: this.clock() });
        this.lane(job.provider).fifo.unshift(job.id);
        this.pauseLane(job.provider, "offline", "offline — jobs stay queued and resume with connectivity");
        return;
      }
      case "transient": {
        if (job.attempt >= this.maxAttempts) {
          await this.terminalize(job, "failed", `gave up after ${job.attempt} attempts: ${message}`);
          return;
        }
        await this.transition({ ...job, status: "queued", updatedAt: this.clock() });
        const lane = this.lane(job.provider);
        lane.fifo.push(job.id);
        this.schedule(lane, backoffMs(job.attempt, this.backoffBaseMs, this.backoffCapMs, this.rng));
        return;
      }
      case "terminal": {
        await this.terminalize(job, "failed", message);
        return;
      }
    }
  }

  private async pollToTerminal(job: Job, client: DispatchClient, key: string): Promise<void> {
    let current = job;
    for (;;) {
      if (this.disposed) return;
      const cancelled = this.jobs.get(job.id)?.status === "cancelled";
      if (cancelled) return; // cancel() already terminalized; discard whatever arrives (§2.10)
      let poll;
      try {
        poll = await client.poll(key, current.providerJobId!, { jobId: job.id, attempt: job.attempt, model: job.model });
      } catch (err) {
        if (this.disposed) return;
        const klass = classifyError(err);
        if (klass === "provider-fault") {
          // Keep the job running (the remote work exists); pause the lane for new work.
          this.pauseLane(job.provider, "fault", err instanceof Error ? err.message : String(err));
          return;
        }
        // Transient/offline/unknown poll noise: keep polling — never resubmit (R-5).
        await this.sleep(this.pollIntervalMs);
        continue;
      }
      if (this.disposed) return;
      if (poll.state === "succeeded") {
        await this.landAndSucceed(current, client, key, poll.costMicroUsd);
        return;
      }
      if (poll.state === "failed") {
        await this.terminalize(current, "failed", poll.error ?? "the provider reported failure", poll.costMicroUsd);
        return;
      }
      if (poll.state === "cancelled") {
        await this.terminalize(current, "cancelled", null, poll.costMicroUsd);
        return;
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  // ---- artifacts (§2.9) ----------------------------------------------------

  private async landAndSucceed(
    job: Job,
    client: DispatchClient,
    key: string,
    costMicroUsd: number | undefined,
    suppliedArtifacts?: DispatchArtifact[],
  ): Promise<void> {
    let landed: string[] = [];
    if (job.landing) {
      let artifacts: DispatchArtifact[];
      try {
        artifacts = suppliedArtifacts ?? (await client.fetchArtifacts(key, job.providerJobId!, { jobId: job.id, attempt: job.attempt, model: job.model }));
      } catch (err) {
        if (this.disposed) return;
        // An interrupted download restarts the fetch (R-12); nothing partial exists yet.
        const klass = classifyError(err);
        if (klass === "terminal") {
          await this.terminalize(job, "failed", `artifact fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        } else {
          await this.sleep(this.pollIntervalMs);
          if (!this.disposed) await this.landAndSucceed(job, client, key, costMicroUsd, suppliedArtifacts);
        }
        return;
      }
      if (this.disposed) return;
      if (this.jobs.get(job.id)?.status === "cancelled") return; // discard on arrival (§2.10)
      // Sanitisation before verification (SPEC-021 §2.10): an engine that embeds workflow
      // metadata has it stripped here, and a container the sanitiser cannot process fails the
      // job with the reason — never landed as-is.
      if (this.opts.prepareArtifact) {
        const prepared: DispatchArtifact[] = [];
        for (const artifact of artifacts) {
          const result = this.opts.prepareArtifact(job, artifact);
          if (!result.ok) {
            await this.terminalize(job, "failed", `artifact "${artifact.name}" was refused: ${result.reason}`);
            return;
          }
          prepared.push(result.artifact);
        }
        artifacts = prepared;
      }
      // Verify everything before anything lands (R-13): all-or-nothing.
      for (const artifact of artifacts) {
        const verified = verifyArtifact(artifact);
        const problem =
          verified ??
          (job.capability === "image" && imageFormatOf(artifact.data) === null
            ? "not a supported PNG, JPEG, or WebP image"
            : null);
        if (problem !== null) {
          await this.terminalize(job, "failed", `artifact "${artifact.name}" failed verification: ${problem}`);
          return;
        }
      }
      // Stage outside the visible dir, rename in (R-12) — the SPEC-002 discipline. The whole
      // landing runs inside the world's suppression envelope when one is supplied, so our own
      // writes never trip the external-edit watcher.
      const landing = job.landing;
      const available = await this.opts.landInWorld(job.worldId, async (worldDir) => {
        const stagingDir = join(worldDir, ".staging", job.id);
        const targetDir = join(worldDir, job.landing!.dir);
        try {
          await mkdir(toExtendedLength(stagingDir), { recursive: true });
          await mkdir(toExtendedLength(targetDir), { recursive: true });
          const staged: Array<{ from: string; to: string; rel: string }> = [];
          for (const [index, artifact] of artifacts.entries()) {
            const name = landedName(job, artifact, index);
            const from = join(stagingDir, name);
            await writeFile(toExtendedLength(from), artifact.data);
            staged.push({ from, to: join(targetDir, name), rel: `${landing.dir}/${name}` });
          }
          if (this.disposed) return; // killed during download/staging: nothing visible (R-12)
          for (const s of staged) {
            await rename(toExtendedLength(s.from), toExtendedLength(s.to));
            landed.push(s.rel);
          }
        } finally {
          await rm(toExtendedLength(stagingDir), { recursive: true, force: true }).catch(() => {});
        }
      });
      if (!available) {
        const waiting: Job = {
          ...job,
          status: "running",
          error: "the provider completed; waiting for the owning world to become available for landing",
          updatedAt: this.clock(),
        };
        await this.transition(waiting);
        await this.sleep(this.pollIntervalMs);
        if (!this.disposed) await this.landAndSucceed(waiting, client, key, costMicroUsd, artifacts);
        return;
      }
    }
    if (this.disposed) return;
    const landedJob = { ...job, ...(landed.length > 0 ? { landedFiles: landed } : {}) };
    const needsFollowOn = FOLLOW_ON_TARGETS.has(landedJob.target.kind) && landedJob.landedFiles?.[0] !== undefined;
    await this.terminalize(
      needsFollowOn
        ? {
            ...landedJob,
            finalization: { status: "pending", error: null, updatedAt: this.clock() },
          }
        : landedJob,
      "succeeded",
      null,
      costMicroUsd,
    );
  }

  // ---- terminal states and the ledger (§2.11) ------------------------------

  /** ⑦ terminal row first, then exactly one ledger entry (R-15, R-16). */
  private async terminalize(
    job: Job,
    outcome: "succeeded" | "failed" | "cancelled",
    error: string | null,
    costMicroUsd?: number,
  ): Promise<void> {
    const terminal: Job = { ...job, status: outcome, error, updatedAt: this.clock() };
    await this.transition(terminal);
    if (this.disposed) return;
    await this.appendLedgerOnce(terminal, costMicroUsd);
    if (this.disposed) return;
    if (terminal.finalization?.status === "pending" && !(await this.opts.ledger.has(terminal.id))) {
      await this.failFinalization(terminal);
      return;
    }
    try {
      await this.opts.onTerminal?.(terminal);
      if (terminal.finalization?.status === "pending") await this.completeFinalization(terminal);
      else if (terminal.status === "succeeded") this.emitReady(terminal);
    } catch {
      if (terminal.finalization?.status === "pending") await this.failFinalization(terminal);
    }
  }

  private async appendLedgerOnce(
    job: Job,
    costMicroUsd?: number,
    startupJobIds?: Set<string>,
  ): Promise<boolean> {
    try {
      if (startupJobIds ? startupJobIds.has(job.id) : await this.opts.ledger.has(job.id)) return false;
      await this.appendLedgerEntry(job, costMicroUsd);
      startupJobIds?.add(job.id);
      return true;
    } catch {
      // A failed ledger write is the ⑦ crash window: the terminal row is already durable, and
      // the next start-up completes the missing entry idempotently (R-16). Never crash a pump.
      if (startupJobIds && (await this.opts.ledger.has(job.id).catch(() => false))) {
        startupJobIds.add(job.id);
        return true;
      }
      return false;
    }
  }

  private async appendLedgerEntry(job: Job, costMicroUsd?: number): Promise<void> {
    const outcome = job.status as "succeeded" | "failed" | "cancelled";
    const client = this.opts.clients[job.provider];
    const local = (PROVIDERS as Record<string, { local: boolean } | undefined>)[job.provider]?.local === true;
    let actualMicroUsd: number | null;
    let actualSource: LedgerEntry["actualSource"];
    if (local) {
      actualMicroUsd = 0;
      actualSource = "local-zero"; // unmetered (SPEC-008 R-18)
    } else if (client?.declarations.reportsCost && costMicroUsd !== undefined) {
      actualMicroUsd = Math.round(costMicroUsd);
      actualSource = "provider-reported";
    } else if (outcome === "succeeded") {
      actualMicroUsd = job.estimatedMicroUsd;
      actualSource = "manifest-derived"; // derived, not measured (SPEC-008 R-17)
    } else {
      // Failed or cancelled with no provider figure: the charge is unknown, recorded as such.
      actualMicroUsd = null;
      actualSource = undefined;
    }
    await this.opts.ledger.append({
      ts: this.clock(),
      worldId: job.worldId,
      ...(job.productionId !== undefined ? { productionId: job.productionId } : {}),
      jobId: job.id,
      provider: job.provider,
      model: job.model,
      outcome,
      estimatedMicroUsd: job.estimatedMicroUsd,
      actualMicroUsd,
      ...(actualSource !== undefined ? { actualSource } : {}),
    });
  }

  // ---- cancellation (§2.10) ------------------------------------------------

  async cancel(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || TERMINAL.has(job.status)) return;
    const lane = this.lane(job.provider);
    lane.fifo = lane.fifo.filter((id) => id !== jobId);
    // Attempt the remote cancel where there is remote work to cancel; best-effort.
    if (job.providerJobId) {
      const client = this.opts.clients[job.provider];
      const key = await this.keyFor(job.provider);
      // `key !== null`, not a truthiness test: keyFor returns the EMPTY STRING for every
      // provider whose credential is not ours to hold — every local runtime, and Higgsfield,
      // whose credential lives in its own CLI. An empty string is falsy, so the truthiness
      // test skipped the remote cancel for all of them: a Higgsfield job kept running after
      // the user cancelled it, and SPEC-021 R-17's targeted cancellation was unreachable.
      // Only a genuinely missing in-app credential (null) means there is nobody to ask.
      if (client && key !== null) {
        await client
          .cancel(key, job.providerJobId, { jobId: job.id, attempt: job.attempt, model: job.model })
          .catch(() => {});
      }
    }
    // A cancelled job still writes a ledger entry (R-15, D10).
    await this.terminalize(job, "cancelled", null);
    this.emitQueueStatus(job.provider);
  }

  // ---- deletion from history (SPEC-014 R-13) -------------------------------

  /**
   * Drop a finished job from Activity's history. Journal first, like every other transition (D1):
   * the tombstone is a full row carrying `deletedAt`, so the file stays append-only and the fold
   * stops returning the id. Refused for anything `canDeleteJob` says the state cannot perform —
   * work in flight is cancelled, not deleted, and an unfinished finalization still owes the user
   * an outcome. The ledger entry and any landed files are untouched: this removes a row, not what
   * it produced or what it cost.
   */
  async delete(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || !canDeleteJob(job)) return;
    const tombstone: Job = { ...job, deletedAt: this.clock(), updatedAt: this.clock() };
    if (this.disposed) return;
    await this.journal.append(tombstone);
    if (this.disposed) return; // killed mid-write: the journal decides on recovery
    this.jobs.delete(jobId);
    this.opts.emit({ at: this.clock(), type: "job.deleted", jobId: tombstone.id });
  }

  // ---- reconciliation (§2.5) and start-up (R-18) ---------------------------

  async start(): Promise<ReconcileAction[]> {
    const history = await this.journal.readHistory();
    const folded = foldJobHistory(history);
    const ledgerJobIds = new Set(await this.opts.ledger.readJobIds());
    const missingLedger: Job[] = [];
    for (const { job } of folded) this.jobs.set(job.id, job);
    const report: ReconcileAction[] = [];

    for (const { job, prior } of folded) {
      if (TERMINAL.has(job.status)) {
        // Crash window ⑦: terminal without its ledger entry → append exactly one (R-16).
        if (!ledgerJobIds.has(job.id)) missingLedger.push(job);
        if (
          job.status === "succeeded" &&
          ledgerJobIds.has(job.id) &&
          this.needsReplayableFinalization(job) &&
          this.finalizationUnsettled(job)
        ) {
          await this.retryFinalization(job.id);
        } else if (job.status === "succeeded" && job.finalization?.status === "pending") {
          // Non-reference follow-ons are not replay-safe. Surface the interrupted preparation
          // honestly instead of duplicating takes or mutating a reference kit on startup.
          await this.failFinalization(job);
        }
        continue;
      }
      if (job.status === "needs-reconciliation") {
        report.push({ jobId: job.id, action: "held-for-user", detail: job.error ?? "awaiting your answer" });
        continue;
      }
      if (job.status === "queued") {
        const client = this.opts.clients[job.provider];
        const local = (PROVIDERS as Record<string, { local: boolean } | undefined>)[job.provider]?.local === true;
        if (!local && !client?.declarations.supportsIdempotencyKey && prior?.status === "submitting") {
          const action = await this.holdForUser(job);
          report.push(action);
          continue;
        }
        this.lane(job.provider).fifo.push(job.id);
        report.push({ jobId: job.id, action: "requeued" });
        continue;
      }
      if (job.status === "running") {
        // A local engine's job first consults the per-source policy (SPEC-021 §2.11): a spawned
        // engine's old prompt id means nothing, and an old id is never polled against a
        // different engine. Cloud jobs keep the standing behaviour untouched.
        const decision = this.opts.recoverLocal?.(job, prior) ?? null;
        if (decision !== null && decision.action !== "resume") {
          report.push(await this.applyLocalRecovery(job, decision));
          continue;
        }
        // R-5: a recorded remote id resumes by polling, never by resubmitting.
        report.push({ jobId: job.id, action: "resumed-polling" });
        this.trackRun(this.resumePolling(job));
        continue;
      }
      if (job.status === "submitting") {
        // "resume" cannot apply to a job with no recorded remote id; it falls through to the
        // standing reconciliation, which for an all-false local provider is the honest hold.
        const decision = this.opts.recoverLocal?.(job, prior) ?? null;
        if (decision !== null && decision.action !== "resume") {
          report.push(await this.applyLocalRecovery(job, decision));
          continue;
        }
        const action = await this.reconcileSubmitting(job);
        report.push(action);
      }
    }

    for (const job of missingLedger) {
      if (await this.appendLedgerOnce(job, undefined, ledgerJobIds)) {
        report.push({ jobId: job.id, action: "ledger-completed" });
      }
    }

    this.accepting = true; // new work only after every non-terminal job is resolved (R-18)
    if (report.length > 0) this.opts.emit({ at: this.clock(), type: "queue.reconciled", report });
    for (const provider of this.lanes.keys()) this.pump(provider);
    return report;
  }

  private async resumePolling(job: Job): Promise<void> {
    const client = this.opts.clients[job.provider];
    const key = await this.keyFor(job.provider);
    if (!client || key === null) {
      this.pauseLane(job.provider, "credential", "no credential stored for this provider");
      return;
    }
    await this.pollToTerminal(job, client, key);
  }

  /** The unwitnessed-submission window (§2.4 rows ②→③ and ④): observe, never guess (D2). */
  private async reconcileSubmitting(job: Job): Promise<ReconcileAction> {
    const client = this.opts.clients[job.provider];
    const key = client ? await this.keyFor(job.provider) : null;
    if (!client || key === null) {
      this.pauseLane(job.provider, "credential", "no credential stored for this provider");
      return { jobId: job.id, action: "held-for-user", detail: "no credential to reconcile with" };
    }

    // Strategy A — definite in both directions.
    if (client.declarations.supportsIdempotencyKey && client.declarations.supportsLookupByKey && client.lookupByKey) {
      let found;
      try {
        found = await client.lookupByKey(key, job.idempotencyKey, { jobId: job.id, attempt: job.attempt, model: job.model });
      } catch {
        return this.holdForUser(job);
      }
      if (found) {
        const running: Job = { ...job, status: "running", providerJobId: found.remoteId, updatedAt: this.clock() };
        await this.transition(running);
        this.trackRun(this.pollToTerminal(running, client, key));
        return { jobId: job.id, action: "adopted", detail: found.remoteId };
      }
      await this.requeueSafely(job);
      return { jobId: job.id, action: "resubmitted", detail: "provably absent remotely" };
    }

    // Strategy B — conclusive on a match; bounded by how far the listing reaches.
    if (client.declarations.supportsIdempotencyKey && client.declarations.supportsListRecent && client.listRecent) {
      const recent = await client.listRecent(key, { jobId: job.id, attempt: job.attempt, model: job.model }).catch(() => null);
      if (recent) {
        const match = recent.find((r) => r.idempotencyKey === job.idempotencyKey);
        if (match) {
          const running: Job = { ...job, status: "running", providerJobId: match.remoteId, updatedAt: this.clock() };
          await this.transition(running);
          this.trackRun(this.pollToTerminal(running, client, key));
          return { jobId: job.id, action: "adopted", detail: match.remoteId };
        }
        // Absence only means anything if the listing would have shown our key at all.
        const carriesKeys = recent.some((r) => r.idempotencyKey !== undefined);
        const oldest = recent.length > 0 ? recent[recent.length - 1]!.createdAt : null;
        if (carriesKeys && oldest !== null && oldest <= job.updatedAt) {
          // The listing reaches back past the submission: absence is definite in-window.
          await this.requeueSafely(job);
          return { jobId: job.id, action: "resubmitted", detail: "absent within the listing window" };
        }
      }
      // Outside the window, a keyless listing, or a failed listing: escalate to C, never guess.
      return this.holdForUser(job);
    }

    // Strategy C — the honest position (D4).
    return this.holdForUser(job);
  }

  private async requeueSafely(job: Job): Promise<void> {
    await this.transition({ ...job, status: "queued", updatedAt: this.clock() });
    this.lane(job.provider).fifo.push(job.id);
  }

  /** The per-source policy's outcome, applied (SPEC-021 §2.11). `resume` is handled by the caller. */
  private async applyLocalRecovery(
    job: Job,
    decision: Exclude<ComfyUiRecoveryDecision, { action: "resume" }>,
  ): Promise<ReconcileAction> {
    if (decision.action === "requeue") {
      await this.requeueSafely(job);
      return { jobId: job.id, action: "requeued", detail: "the engine was relaunched and holds no old work" };
    }
    if (decision.action === "fail") {
      await this.terminalize(job, "failed", decision.reason);
      return { jobId: job.id, action: "failed", detail: decision.reason };
    }
    return this.holdForUser(job);
  }

  private async holdForUser(job: Job): Promise<ReconcileAction> {
    const local = (PROVIDERS as Record<string, { local: boolean } | undefined>)[job.provider]?.local === true;
    // A duplicate on a local engine costs this machine's own GPU time and nothing else (R-12) —
    // wording that said "charge" here would be a hold nobody can price honestly.
    const duplicateCost = local
      ? "re-runs it on this machine's own GPU time — no charge"
      : job.estimatedMicroUsd > 0
        ? `may charge about ${formatMicroUsd(job.estimatedMicroUsd)} again`
        : "may create another charge of unknown size";
    const held: Job = {
      ...job,
      status: "needs-reconciliation",
      error: local
        ? `Arke did not witness the submission result — the engine kept running while Arke restarted, and cannot confirm what happened. No automatic retry was made. Resubmitting ${duplicateCost}.`
        : `Arke did not witness the submission result. ${job.provider} may have accepted and charged it, and cannot confirm what happened. No automatic retry was made. Resubmitting ${duplicateCost}; the prior actual cost is unknown.`,
      updatedAt: this.clock(),
    };
    await this.transition(held);
    this.emitQueueStatus(job.provider);
    return { jobId: job.id, action: "held-for-user", detail: held.error ?? undefined };
  }

  private needsReferenceFinalization(job: Job): boolean {
    return REFERENCE_FINALIZATION_TARGETS.has(job.target.kind) && job.landedFiles?.[0] !== undefined;
  }

  private needsReplayableFinalization(job: Job): boolean {
    return REPLAYABLE_FINALIZATION_TARGETS.has(job.target.kind) && job.landedFiles?.[0] !== undefined;
  }

  /**
   * A finalization nobody has an answer for yet: never attempted (a legacy row carries no record
   * of one) or interrupted mid-flight by a crash. Both are worth replaying unasked. One that has
   * already failed is not — it is a needs-you row carrying its own retry (`canDeleteJob`), and a
   * permanent cause replays identically every launch and every world open, refilling the app log
   * with an outcome the user has already been told about.
   */
  private finalizationUnsettled(job: Job): boolean {
    const status = job.finalization?.status;
    return status === undefined || status === "pending";
  }

  private async completeFinalization(job: Job): Promise<void> {
    const completed: Job = {
      ...job,
      finalization: { status: "complete", error: null, updatedAt: this.clock() },
      updatedAt: this.clock(),
    };
    await this.transition(completed);
    this.emitReady(completed);
  }

  private emitReady(job: Job): void {
    this.opts.emit({ at: this.clock(), type: "job.ready", job });
  }

  private async failFinalization(job: Job): Promise<void> {
    const error = this.needsReferenceFinalization(job)
      ? "Generation completed, but its result could not be prepared. Retry finalization; this will not contact the provider or charge again."
      : "Generation completed, but its result could not be prepared. Open Activity for details; no additional provider charge was made.";
    const failed: Job = {
      ...job,
      finalization: { status: "failed", error, updatedAt: this.clock() },
      updatedAt: this.clock(),
    };
    await this.transition(failed);
    this.opts.onFinalizationFailure?.(failed);
  }

  async retryFinalization(jobId: string): Promise<void> {
    if (this.finalizing.has(jobId)) return;
    this.finalizing.add(jobId);
    try {
      const job = this.jobs.get(jobId);
      if (!job || job.status !== "succeeded" || !this.needsReplayableFinalization(job)) return;
      const pending: Job = {
        ...job,
        finalization: { status: "pending", error: null, updatedAt: this.clock() },
        updatedAt: this.clock(),
      };
      await this.transition(pending);
      try {
        await this.opts.onTerminal?.(pending);
        await this.completeFinalization(pending);
      } catch {
        await this.failFinalization(pending);
      }
    } finally {
      this.finalizing.delete(jobId);
    }
  }

  async retryFinalizationsForWorld(worldId: string): Promise<void> {
    const jobs = [...this.jobs.values()].filter(
      (job) =>
        job.worldId === worldId &&
        job.status === "succeeded" &&
        this.needsReplayableFinalization(job) &&
        this.finalizationUnsettled(job),
    );
    for (const job of jobs) await this.retryFinalization(job.id);
  }

  /**
   * Terminate non-terminal work that belonged to an engine that is no longer configured
   * (SPEC-021 §2.11). Settings changing under running work is the same "different instance"
   * case recovery handles at start-up, except nothing restarts — so it has to be handled the
   * moment the location changes, or a poll loop keeps asking a *new* engine about an id only
   * the old one ever knew.
   *
   * `stillOurs` answers whether a job's frozen engine identity matches what is configured now.
   */
  async failJobsForRetiredEngine(
    provider: string,
    stillOurs: (job: Job) => boolean,
    reason: string,
  ): Promise<Job[]> {
    const orphans = [...this.jobs.values()].filter(
      (job) => job.provider === provider && !TERMINAL.has(job.status) && job.status !== "needs-reconciliation" && !stillOurs(job),
    );
    for (const job of orphans) {
      const lane = this.lane(job.provider);
      lane.fifo = lane.fifo.filter((id) => id !== job.id);
      // Deliberately no remote cancel: the engine that holds this work is the one we can no
      // longer address, and the engine we CAN address never had it.
      await this.terminalize(job, "failed", reason);
    }
    if (orphans.length > 0) this.emitQueueStatus(provider);
    return orphans;
  }

  /** The user's answer to strategy C (D4): resubmit with eyes open, or abandon honestly. */
  async resolveHeld(jobId: string, decision: "resubmit" | "discard"): Promise<void> {
    if (this.resolvingHeld.has(jobId)) return;
    this.resolvingHeld.add(jobId);
    try {
      const job = this.jobs.get(jobId);
      if (!job || job.status !== "needs-reconciliation") return;
      if (decision === "resubmit") {
        await this.transition({ ...job, status: "queued", error: null, updatedAt: this.clock() });
        this.lane(job.provider).fifo.push(job.id);
        this.emitQueueStatus(job.provider);
        this.pump(job.provider);
        return;
      }
      // Abandoned — but the ledger still records it (R-15): the charge is unknown, not zero.
      await this.terminalize(job, "cancelled", "abandoned after an unwitnessed submission");
      this.emitQueueStatus(job.provider);
    } finally {
      this.resolvingHeld.delete(jobId);
    }
  }

  // ---- adaptive rate (§2.8) ------------------------------------------------

  private noteRateLimit(provider: string): void {
    const lane = this.lane(provider);
    lane.maxConcurrent = 1;
    lane.minIntervalMs = Math.min(Math.max(lane.minIntervalMs * 4, 1000), 10_000);
    lane.successStreak = 0;
  }

  private noteSuccess(provider: string): void {
    const lane = this.lane(provider);
    lane.successStreak += 1;
    if (lane.successStreak >= 5) {
      lane.successStreak = 0;
      // Gradual recovery (R-10): interval first, then concurrency.
      if (lane.minIntervalMs > this.baseIntervalMs) {
        lane.minIntervalMs = Math.max(this.baseIntervalMs, Math.floor(lane.minIntervalMs * 0.7));
      } else if (lane.maxConcurrent < this.baseConcurrency) {
        lane.maxConcurrent += 1;
      }
    }
  }

  // ---- misc -----------------------------------------------------------------

  private async keyFor(provider: string): Promise<string | null> {
    // Only an in-app credential is ours to hand over. A local runtime takes none, and an
    // external one is held by the tool the client drives — both dispatch with an empty key
    // rather than being held for a credential that was never going to be in `credentials.dat`.
    if (credentialKindOf(provider) !== "in-app") return "";
    return this.opts.getKey(provider);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  /** Simulated kill for the crash suite, and clean shutdown: no further writes or events. */
  dispose(): void {
    this.disposed = true;
    for (const lane of this.lanes.values()) {
      if (lane.timer) clearTimeout(lane.timer);
      lane.timer = null;
    }
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled(this.activeRuns);
  }

  drain(): Promise<void> {
    return this.journal.drain();
  }
}
