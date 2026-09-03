import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import {
  canDeleteJob,
  credentialKindOf,
  formatMicroUsd,
  PROVIDERS,
  REFERENCE_FINALIZATION_TARGETS,
  isReplayableFinalization,
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
import { atomicWriteFile } from "../world/atomic.js";

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

export interface DispatchVoiceReference {
  name: string;
  contentType: "audio/wav" | "audio/mpeg";
  data: Uint8Array;
}

/** The footage a continuation extends (SPEC-019 R-50), resolved immediately before submit. */
export interface DispatchVideoSource {
  contentType: "video/mp4" | "video/quicktime" | "video/webm";
  data: Uint8Array;
}

export interface DispatchClient {
  readonly declarations: ClientDeclarations;
  /** Drop source-bound optional transports while keeping the client reusable. */
  resetTransport?(): void;
  /** Release optional long-lived transports when the queue shuts down. */
  dispose?(): void;
  submit(
    key: string,
    request: {
      model: string;
      capability: Capability;
      signal?: AbortSignal;
      params: Record<string, unknown>;
      imageReferences?: DispatchImageReference[];
      voiceReference?: DispatchVoiceReference;
      videoSource?: DispatchVideoSource;
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
  ): Promise<{
    state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    costMicroUsd?: number;
    error?: string;
    /** What the engine is counting, where it counts anything (SPEC-021 D16). */
    step?: { stage: string; done: number; total: number };
  }>;
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
  /** Host-only hint. Converted to `params.voiceReference = true` in the durable row. */
  voiceReference?: boolean;
  /** Opaque engine instance explicitly approved as a remote voice-upload destination. */
  voiceUploadConfirmedFor?: string;
  estimatedMicroUsd: number;
  landing?: { dir: string; name?: string };
  /** Frozen recipe identity for a local-recipe dispatch (SPEC-021 §2.11, R-15). */
  recipe?: RecipeIdentity;
  /** Frozen engine identity — source kind and opaque instance digest, never a path. */
  engine?: JobEngineIdentity;
  /**
   * A pre-allocated idempotency key (SPEC-024 D2). A dispatch-plan pass mints its key at plan
   * creation so the crash window between materialisation and enqueue has nothing to invent —
   * re-enqueueing the same key returns the existing job rather than journalling a second spend.
   * Absent means the queue mints one, exactly as before.
   */
  idempotencyKey?: string;
}

export interface JobQueueOptions {
  journalPath: string;
  clients: Record<string, DispatchClient>;
  getKey: (provider: string) => Promise<string | null>;
  emit: (event: DomainEvent) => void;
  /**
   * The idempotency seam (R-16): startup snapshots once; runtime checks the live ledger.
   * The reads MUST reject when the ledger exists but cannot be read, never answer empty —
   * "empty" here means "never billed", and the queue would append a duplicate entry for work
   * that was. The queue treats a rejection as unknown: it parks the ledger-gated reconciliation
   * and appends nothing, leaving entries missing rather than doubled, because a missing entry
   * is completed idempotently by the next start-up and a duplicate is permanent.
   */
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
  /** Resolve a durable voice id into ephemeral confined bytes immediately before provider I/O. */
  readVoiceReference?: (worldId: string, provider: string, model: string, voiceId: string) => Promise<DispatchVoiceReference>;
  /**
   * Resolve the footage a continuation extends into bytes, cutting a pass segment out of its
   * backing file first where the predecessor is one (SPEC-019 R-50, T-32).
   *
   * A seam rather than inline work for the reason the other two are: the dispatcher owns when
   * paid I/O happens and nothing else, and cutting video needs a world lock and ffmpeg, neither
   * of which belongs in a queue.
   */
  readVideoSource?: (job: Job) => Promise<DispatchVideoSource>;
  /** A provider fault surfaced once, in provider terms (SPEC-008 R-4). */
  onProviderFault?: (provider: string, message: string) => void;
  /** Fired after a job reaches terminal state and its ledger entry landed (SPEC-010 tile flows). */
  onTerminal?: (job: Job) => void | Promise<void>;
  /** Safe operational notice for a persisted domain-finalization failure. */
  onFinalizationFailure?: (job: Job, cause: string) => void;
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
  /** Provider-specific safe caps. A local GPU runtime normally supplies one here. */
  providerConcurrency?: Readonly<Record<string, number>>;
  /** Recovered work for this provider is not pumped until the runtime has settled. */
  awaitRecoveryReady?: (provider: string) => Promise<boolean>;
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
  /** Earliest dispatch time per queued job — a retry's backoff (R-9), held by the job itself. */
  notBefore: Map<string, number>;
  successStreak: number;
  timer: NodeJS.Timeout | null;
  /** When `timer` fires, so an earlier request can replace it. */
  timerAt: number;
  recoveryGate: Promise<void> | null;
  recoveryBlocked: boolean;
  deferredRecovery: Array<() => Promise<void>>;
}

interface DurableInlineArtifacts {
  remoteId: string;
  artifacts: DispatchArtifact[];
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const FORMAT_PRESERVING_IMAGE_TARGETS = new Set([
  "main-photo-candidate",
  "establish-candidate",
  "character-sheet",
  "character-look",
  "reference-tile",
  // The look preview may be promoted to the master look (SPEC-031 R-54); a JPEG under a
  // .png name would then be carried under a name its bytes contradict.
  "look-preview",
]);
const FOLLOW_ON_TARGETS = new Set([
  ...REFERENCE_FINALIZATION_TARGETS,
  "reference-tile",
  "shot",
  "board-sheet",
  "scene-pass",
  "voice-line",
  "voice-preview",
]);
const COORDINATOR_ONLY_PARAMS = new Set(["frameRun", "frameRunStep", "landing", "request"]);

function providerParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([key]) => !COORDINATOR_ONLY_PARAMS.has(key)));
}

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
  private readonly providerConcurrency: Readonly<Record<string, number>>;
  private readonly baseIntervalMs: number;
  private disposed = false;
  private accepting = false;
  private admissionClosed = false;
  private readonly resolvingHeld = new Set<string>();
  private readonly finalizing = new Set<string>();
  private readonly activeRuns = new Set<Promise<void>>();
  private readonly sleepTimers = new Map<NodeJS.Timeout, () => void>();
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  /** Submits without a remote id can still be interrupted, notably queue-backed local speech. */
  private readonly submitAborts = new Map<string, AbortController>();
  /**
   * Jobs whose cancellation is underway, held from the moment the abort fires until the terminal
   * row is written. The abort makes the in-flight submit reject, and that rejection reaches the
   * submit catch before `cancel()` has written `cancelled` — one microtask is not enough for a
   * transition. Reading the status alone therefore saw `submitting` and sent a *deliberate* user
   * cancellation into `handleSubmitError`, where a paid non-idempotent provider takes the hold
   * branch: the job settled as needs-reconciliation, telling the user Arke could not witness the
   * outcome and might charge again for something they had just called off. The intent is the fact
   * the error path needs, and the status is only a lagging record of it.
   */
  private readonly cancelling = new Set<string>();
  /** Old spawned-engine runs fenced off before their durable requeue is awaited. */
  private readonly retiredEngineRuns = new Set<string>();

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
    this.providerConcurrency = opts.providerConcurrency ?? {};
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
        maxConcurrent: this.concurrencyFor(provider),
        minIntervalMs: this.baseIntervalMs,
        nextAllowedAt: 0,
        notBefore: new Map(),
        successStreak: 0,
        timer: null,
        timerAt: 0,
        recoveryGate: null,
        recoveryBlocked: false,
        deferredRecovery: [],
      };
      this.lanes.set(provider, lane);
    }
    return lane;
  }

  /**
   * Re-associate a conversation-scoped job with the world its conversation became
   * (SPEC-031 R-55): one appended row folding latest-wins, like every other transition.
   * The ledger entry is untouched — it keeps the scope the money was actually spent under.
   */
  async adoptWorld(jobId: string, worldId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || job.worldId === worldId) return;
    await this.transition({ ...job, worldId, updatedAt: this.clock() });
  }

  /** Durable transition: journal first, then memory, then the event (D1). */
  private async transition(job: Job): Promise<boolean> {
    if (this.disposed) return false;
    await this.journal.append(job);
    if (this.disposed) return true; // killed mid-write: the journal decides on recovery
    this.jobs.set(job.id, job);
    this.opts.emit({ at: this.clock(), type: "job.updated", job });
    return true;
  }

  /**
   * A step count from the engine (SPEC-021 D16). Memory and the event, never the journal.
   *
   * `transition` exists to make a state change durable, and this is not one: progress is
   * whatever the last poll saw, it is meaningless after a restart, and journalling twenty-five
   * of them per line would write a file per step to record something already stale.
   */
  private progressed(job: Job, step: Job["step"]): void {
    if (this.disposed) return;
    const updated = { ...job, step };
    this.jobs.set(job.id, updated);
    this.opts.emit({ at: this.clock(), type: "job.updated", job: updated });
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
    const i = this.dispatchOrder(this.lane(job.provider)).indexOf(jobId);
    return i === -1 ? null : i;
  }

  /**
   * The FIFO as the pump will take it, walked gate by gate: the pump dispatches one job per
   * lane interval, taking the first queued job whose backoff has ended by that gate, so a retry
   * whose backoff ends between two gates goes out ahead of the FIFO entries behind it. The raw
   * FIFO put a backing-off retry ahead of the job that was actually next, and a one-off split
   * into ready and waiting put it behind jobs it would in fact precede; "0 = next up" (R-11)
   * was wrong either way for the length of every backoff.
   */
  private dispatchOrder(lane: Lane): string[] {
    const remaining = lane.fifo.filter((id) => this.jobs.get(id)?.status === "queued");
    const order: string[] = [];
    let gate = Math.max(Date.now(), lane.nextAllowedAt);
    while (remaining.length > 0) {
      const at = remaining.findIndex((id) => (lane.notBefore.get(id) ?? 0) <= gate);
      if (at === -1) {
        gate = Math.min(...remaining.map((id) => lane.notBefore.get(id) ?? 0));
        continue;
      }
      order.push(remaining.splice(at, 1)[0]!);
      gate += lane.minIntervalMs;
    }
    return order;
  }

  listJobs(): Job[] {
    return [...this.jobs.values()];
  }

  // ---- enqueue and pump -----------------------------------------------------

  private requireAccepting(): void {
    if (!this.accepting || this.disposed) throw new Error("the queue is not accepting new work");
  }

  /** Permanently close admission while allowing already-journalled work to finish. */
  stopAccepting(): void {
    this.admissionClosed = true;
    this.accepting = false;
  }

  /** Durable before any network call (R-1): the returned job is already journalled. */
  async enqueue(input: EnqueueInput): Promise<Job> {
    this.requireAccepting();
    // A pre-allocated key that already journalled a job is a redelivery, not a request
    // (SPEC-024 R-19): the crash between a plan's materialised event and this call must land on
    // the same job, never a second spend. Serialised per key — the map check alone was
    // check-then-act across the admit and journal awaits, so two concurrent enqueues with one
    // key both missed it and both journalled.
    if (input.idempotencyKey !== undefined) {
      const key = input.idempotencyKey;
      const existing = [...this.jobs.values()].find((job) => job.idempotencyKey === key);
      if (existing !== undefined) return existing;
      const inFlight = this.enqueueingByKey.get(key);
      if (inFlight !== undefined) return inFlight;
      const promise = this.enqueueNew(input).finally(() => this.enqueueingByKey.delete(key));
      this.enqueueingByKey.set(key, promise);
      return promise;
    }
    return this.enqueueNew(input);
  }

  private readonly enqueueingByKey = new Map<string, Promise<Job>>();

  private async enqueueNew(input: EnqueueInput): Promise<Job> {
    if ("speakerFile" in input.params) {
      throw new Error(
        "absolute voice clip paths cannot be stored in jobs; use the host voice-reference seam",
      );
    }
    if (
      input.voiceReference === true &&
      (typeof input.params["voiceId"] !== "string" || input.params["voiceId"].length === 0)
    ) {
      throw new Error("a voice reference requires a voice id");
    }
    if (
      input.voiceReference === true &&
      input.engine?.source === "user-url" &&
      input.engine.locality !== "local" &&
      input.voiceUploadConfirmedFor !== input.engine.instanceId
    ) {
      throw new Error("a remote voice upload requires explicit confirmation for this engine destination");
    }
    const durableParams = { ...input.params };
    if (input.voiceReference === true) durableParams["voiceReference"] = true;
    // Admission before durability (SPEC-021 R-16): a dispatch the coordinator knows cannot run
    // is refused with the readiness reason, and nothing is journalled for it.
    const admitted = await this.opts.admit?.(input);
    if (admitted !== undefined && !admitted.ok) throw new Error(admitted.reason);
    // Admission may probe a runtime. Shutdown can close the queue while that probe is pending;
    // never mint and return an id after that boundary without a durable journal row behind it.
    this.requireAccepting();
    const now = this.clock();
    const job: Job = {
      id: `jb_${ulid()}`,
      idempotencyKey: input.idempotencyKey ?? ulid(), // persisted before submission (R-2)
      worldId: input.worldId,
      ...(input.productionId !== undefined ? { productionId: input.productionId } : {}),
      target: input.target,
      capability: input.capability,
      provider: input.provider,
      model: input.model,
      params: durableParams,
      estimatedMicroUsd: input.estimatedMicroUsd,
      // Identity frozen before the journal line exists (SPEC-021 §2.11): what this job IS can
      // never depend on what the catalogue or Settings hold by the time it runs.
      ...(input.recipe !== undefined ? { recipe: input.recipe } : {}),
      ...(input.engine !== undefined ? { engine: input.engine } : {}),
      ...(input.voiceUploadConfirmedFor !== undefined
        ? { voiceUploadConfirmedFor: input.voiceUploadConfirmedFor }
        : {}),
      status: "queued",
      providerJobId: null,
      attempt: 0,
      ...(input.landing !== undefined ? { landing: input.landing } : {}),
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    if (!(await this.transition(job))) this.requireAccepting();
    this.lane(job.provider).fifo.push(job.id);
    this.pump(job.provider);
    return job;
  }

  private pump(provider: string): void {
    if (this.disposed) return;
    const lane = this.lane(provider);
    if (lane.paused || lane.recoveryGate !== null || lane.recoveryBlocked) return;
    const now = Date.now();
    if (now < lane.nextAllowedAt) {
      this.schedule(lane, lane.nextAllowedAt - now);
      return;
    }
    while (lane.inFlight.size < lane.maxConcurrent && lane.fifo.length > 0) {
      const jobId = this.nextDispatchable(lane);
      if (jobId === null) break;
      const job = this.jobs.get(jobId)!;
      const runKey = this.engineRunKey(job);
      lane.inFlight.add(runKey);
      lane.nextAllowedAt = Date.now() + lane.minIntervalMs;
      const run = this.runJob(job).finally(() => {
        lane.inFlight.delete(runKey);
        this.retiredEngineRuns.delete(this.engineRunKey(job));
        const current = this.jobs.get(job.id);
        if (current?.status === "queued" && !lane.fifo.includes(job.id)) lane.fifo.push(job.id);
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

  /**
   * The first job in the FIFO whose turn has come, taken out of it — or null, with a pump
   * scheduled for the earliest one still waiting out its backoff.
   *
   * A retry used to go back into the FIFO with only a lane timer to hold it, and the timer held
   * nothing: the failing attempt's own completion pumps the lane, and an attempt that outlasted
   * the dispatch interval — every real provider call — met an open gate and went straight back
   * out. R-9's backoff was computed and never waited on, and a card still putting a model down
   * (#692) was asked four times over in the time it takes to ask once. The wait belongs to the
   * job rather than the lane: the sibling behind it is not what failed, and holding the whole
   * lane for one retry's backoff would let a single 503 stall everything queued behind it.
   */
  private nextDispatchable(lane: Lane): string | null {
    const now = Date.now();
    let earliest = Infinity;
    for (let i = 0; i < lane.fifo.length; i += 1) {
      const jobId = lane.fifo[i]!;
      const job = this.jobs.get(jobId);
      if (!job || job.status !== "queued") {
        lane.fifo.splice(i, 1);
        lane.notBefore.delete(jobId);
        i -= 1;
        continue;
      }
      const at = lane.notBefore.get(jobId) ?? 0;
      if (at <= now) {
        lane.fifo.splice(i, 1);
        lane.notBefore.delete(jobId);
        return jobId;
      }
      earliest = Math.min(earliest, at);
    }
    if (earliest !== Infinity) this.schedule(lane, earliest - now);
    return null;
  }

  /**
   * Wake the pump `delayMs` from now. A timer is a promise to wake by a time, so an earlier
   * request replaces a later one: with a retry sitting out a thirty-second backoff, the lane's
   * own interval wakeup and a sibling's enqueue were both dropped because a timer already
   * existed, and every ready job waited out a backoff that was never theirs.
   */
  private schedule(lane: Lane, delayMs: number): void {
    if (this.disposed) return;
    const delay = Math.max(1, delayMs);
    const at = Date.now() + delay;
    if (lane.timer) {
      if (at >= lane.timerAt) return;
      clearTimeout(lane.timer);
    }
    lane.timerAt = at;
    lane.timer = setTimeout(() => {
      lane.timer = null;
      this.pump(lane.provider);
    }, delay);
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
        this.retryTimers.delete(timer);
        if (this.disposed) return;
        const current = this.lane(provider);
        if (current.paused?.kind === "offline") this.resume(provider);
      }, this.offlineRetryMs);
      this.retryTimers.add(timer);
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
    for (const job of this.jobs.values()) {
      if (job.provider !== provider || job.status !== "running" || job.failureClass !== "provider-fault") continue;
      this.trackRun(this.resumeProviderHeldPolling(job));
    }
  }

  private async resumeProviderHeldPolling(job: Job): Promise<void> {
    const lane = this.lane(job.provider);
    while (lane.inFlight.has(this.engineRunKey(job)) && !this.disposed) await this.sleep(1);
    const current = this.jobs.get(job.id);
    if (current?.status !== "running" || current.failureClass !== "provider-fault" || lane.paused) return;
    const resumed = { ...current, failureClass: null, error: null, updatedAt: this.clock() };
    await this.transition(resumed);
    await this.resumePolling(resumed);
  }

  private rebuildFifo(provider: string): void {
    const lane = this.lane(provider);
    const queued = [...this.jobs.values()]
      .filter((j) => j.provider === provider && j.status === "queued" && !lane.inFlight.has(this.engineRunKey(j)))
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
    if (!this.stillQueued(job)) return;

    let imageReferences: DispatchImageReference[] | undefined;
    let voiceReference: DispatchVoiceReference | undefined;
    let videoSource: DispatchVideoSource | undefined;
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
    if (job.params["voiceReference"] === true) {
      if (
        job.engine?.source === "user-url" &&
        job.engine.locality !== "local" &&
        job.voiceUploadConfirmedFor !== job.engine.instanceId
      ) {
        await this.terminalize(job, "failed", "the remote voice-upload destination was not explicitly confirmed");
        return;
      }
      const voiceId = job.params["voiceId"];
      if (typeof voiceId !== "string" || voiceId.length === 0) {
        await this.terminalize(job, "failed", "voice reference identity is invalid");
        return;
      }
      if (!this.opts.readVoiceReference) {
        await this.terminalize(job, "failed", "voice reference transport is not configured");
        return;
      }
      try {
        voiceReference = await this.opts.readVoiceReference(job.worldId, job.provider, job.model, voiceId);
      } catch (error) {
        await this.terminalize(
          job,
          "failed",
          error instanceof Error ? error.message : "the voice's recording could not be prepared",
        );
        return;
      }
    }
    // The footage a continuation extends, resolved last of the three (SPEC-019 R-50). A failure
    // here is terminal rather than a lane pause: the predecessor is named on the job and cannot
    // become resolvable by waiting, and a continuation that silently fell back to generating from
    // scratch would be the exact "looks implemented" failure this capability was built out of.
    if (typeof job.params["continuedFrom"] === "string") {
      if (!this.opts.readVideoSource) {
        await this.terminalize(job, "failed", "continuation transport is not configured");
        return;
      }
      try {
        videoSource = await this.opts.readVideoSource(job);
      } catch (error) {
        await this.terminalize(
          job,
          "failed",
          error instanceof Error ? error.message : "the footage being extended could not be prepared",
        );
        return;
      }
    }
    if (!this.stillQueued(job)) return;

    // Persist the physical call before I/O. A crash may overcount one authorized call, but the
    // journal can never undercount requests that may have reached a paid provider.
    const submitting: Job = {
      ...job,
      status: "submitting",
      attempt: job.attempt + 1,
      submissionRejected: undefined,
      updatedAt: this.clock(),
    };
    await this.transition(submitting);
    if (this.disposed) return;
    if (!this.stillSubmitting(submitting)) return;

    const submitAbort = new AbortController();
    this.submitAborts.set(job.id, submitAbort);
    if (this.jobs.get(job.id)?.status !== "submitting") {
      this.submitAborts.delete(job.id);
      return;
    }
    try {
      // ③ the point of uncertainty.
      const accepted = await client.submit(
        key,
        {
          model: job.model,
          capability: job.capability,
          signal: submitAbort.signal,
          params: providerParams(job.params),
          ...(imageReferences ? { imageReferences } : {}),
          ...(voiceReference ? { voiceReference } : {}),
          ...(videoSource ? { videoSource } : {}),
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
      // A lifecycle replacement can requeue this job while submit is in flight. The accepted id
      // belongs to the retired process; never let its late response resurrect the old run over
      // the durable queued row for the replacement process.
      if (!this.stillSubmitting(submitting)) return;
      if (accepted.artifacts) {
        try {
          await this.persistInlineArtifacts(job.id, accepted.remoteId, accepted.artifacts);
        } catch (error) {
          await this.terminalize(
            submitting,
            "failed",
            `the provider completed, but its artifact could not be made durable: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        await this.landDurableInline(
          { ...submitting, providerJobId: accepted.remoteId },
          client,
          key,
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
      // Cancelled by the user, or being cancelled right now: the abort IS the error, and `cancel()`
      // owns the terminal row. Never let it reach handleSubmitError.
      if (this.cancelling.has(job.id) || this.jobs.get(job.id)?.status === "cancelled") return;
      if (!this.stillSubmitting(submitting)) return;
      await this.handleSubmitError(submitting, client, err);
    } finally {
      if (this.submitAborts.get(job.id) === submitAbort) this.submitAborts.delete(job.id);
    }
  }

  private async handleSubmitError(job: Job, client: DispatchClient, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const klass: FailureClass = classifyError(err);
    if (isRateLimit(err)) this.noteRateLimit(job.provider);
    const local = (PROVIDERS as Record<string, { local: boolean } | undefined>)[job.provider]?.local === true;
    const submissionRejected =
      typeof err === "object" && err !== null && (err as { submissionRejected?: unknown }).submissionRejected === true;
    if (submissionRejected && klass === "terminal") {
      // A witnessed request/content rejection is terminal. A witnessed 429 still takes the
      // transient branch below, and a credential fault returns to queued behind a paused lane.
      // A 5xx never reaches this branch: a response alone does not prove paid work was rejected.
      await this.terminalize(job, "failed", message, undefined, klass);
      return;
    }
    if (!submissionRejected && !local && !client.declarations.supportsIdempotencyKey) {
      await this.holdForUser(job, klass);
      if (klass === "provider-fault") this.pauseLane(job.provider, "fault", message);
      return;
    }
    switch (klass) {
      case "provider-fault": {
        // The job was never wrong — the credential was (R-8). Back to queued, lane paused.
        await this.transition({
          ...job,
          status: "queued",
          failureClass: klass,
          submissionRejected,
          error: message,
          updatedAt: this.clock(),
        });
        this.lane(job.provider).fifo.unshift(job.id);
        this.pauseLane(job.provider, "fault", message);
        return;
      }
      case "offline": {
        if (job.attempt >= this.maxAttempts) {
          await this.terminalize(job, "failed", `gave up after ${job.attempt} attempts: ${message}`, undefined, klass);
          return;
        }
        await this.transition({
          ...job,
          status: "queued",
          failureClass: klass,
          submissionRejected,
          error: message,
          updatedAt: this.clock(),
        });
        this.lane(job.provider).fifo.unshift(job.id);
        this.pauseLane(job.provider, "offline", "offline — jobs stay queued and resume with connectivity");
        return;
      }
      case "transient": {
        if (job.attempt >= this.maxAttempts) {
          // The class the queue retried on is the class the failed row keeps: an exhausted
          // transient reads `came back dark · Retry` (SPEC-036 R-18), and re-reading the wrapped
          // message would lose a class that was only ever declared on the error object (#692).
          await this.terminalize(job, "failed", `gave up after ${job.attempt} attempts: ${message}`, undefined, klass);
          return;
        }
        await this.transition({
          ...job,
          status: "queued",
          failureClass: klass,
          submissionRejected,
          error: message,
          updatedAt: this.clock(),
        });
        const lane = this.lane(job.provider);
        const wait = backoffMs(job.attempt, this.backoffBaseMs, this.backoffCapMs, this.rng);
        // The gate is the job's own (nextDispatchable), and the pump that follows this return
        // arms the wakeup for it; a timer armed here for the whole backoff used to outrank the
        // lane's interval wakeup and hold every ready sibling. A 429 is deliberately not pushed
        // onto the lane-wide gate as well: noteRateLimit has already widened the lane's interval
        // (R-10), which is the lane's answer to it, and this backoff is the job's.
        lane.notBefore.set(job.id, Date.now() + wait);
        lane.fifo.push(job.id);
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
      if (!this.stillPolling(current)) return;
      let poll;
      try {
        poll = await client.poll(key, current.providerJobId!, { jobId: job.id, attempt: job.attempt, model: job.model });
      } catch (err) {
        if (this.disposed) return;
        const klass = classifyError(err);
        if (klass === "provider-fault") {
          // Keep the job running (the remote work exists); pause the lane for new work.
          const message = err instanceof Error ? err.message : String(err);
          current = { ...current, failureClass: klass, error: message, updatedAt: this.clock() };
          await this.transition(current);
          this.pauseLane(job.provider, "fault", message);
          return;
        }
        // Transient/offline/unknown poll noise: keep polling — never resubmit (R-5).
        await this.sleep(this.pollIntervalMs);
        continue;
      }
      if (this.disposed) return;
      if (!this.stillPolling(current)) return;
      if (poll.state === "succeeded") {
        await this.landAndSucceed(current, client, key, poll.costMicroUsd);
        return;
      }
      if (poll.state === "failed") {
        const message = poll.error ?? "the provider reported failure";
        const klass = classifyError(message);
        if (klass === "provider-fault") {
          // This is a terminal verdict for remote work that actually ran, not submit uncertainty.
          // Reusing the job would discard a reported charge and later ledger only the replacement.
          this.pauseLane(job.provider, "fault", message);
          await this.terminalize(current, "failed", message, poll.costMicroUsd, klass);
          return;
        }
        await this.terminalize(current, "failed", message, poll.costMicroUsd);
        return;
      }
      if (poll.state === "cancelled") {
        await this.terminalize(current, "cancelled", null, poll.costMicroUsd);
        return;
      }
      // Only when it actually moved: a poll that sees the same step as the last one is not news,
      // and re-emitting it would put a frame on the wire per poll rather than per step.
      const step = poll.step ?? null;
      const held = this.jobs.get(job.id)?.step ?? null;
      if (JSON.stringify(step) !== JSON.stringify(held)) {
        this.progressed(this.jobs.get(job.id) ?? current, step);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private stillPolling(job: Job): boolean {
    const current = this.jobs.get(job.id);
    return current?.status === "running" &&
      current.providerJobId === job.providerJobId &&
      current.attempt === job.attempt &&
      this.engineRunKey(current) === this.engineRunKey(job);
  }

  // ---- artifacts (§2.9) ----------------------------------------------------

  private inlineArtifactDir(jobId: string): string {
    return join(dirname(this.opts.journalPath), "inline-artifacts", jobId);
  }

  /**
   * Synchronous providers have no remote result to fetch after a restart. Write their bytes into
   * the queue first, with the manifest written last as the completeness marker; only then may
   * landing or a recoverable state depend on them.
   */
  private async persistInlineArtifacts(
    jobId: string,
    remoteId: string,
    artifacts: readonly DispatchArtifact[],
  ): Promise<void> {
    const dir = this.inlineArtifactDir(jobId);
    const manifest = join(dir, "manifest.json");
    await rm(toExtendedLength(dir), { recursive: true, force: true });
    await mkdir(toExtendedLength(dir), { recursive: true });
    for (const [index, artifact] of artifacts.entries()) {
      await atomicWriteFile(join(dir, `${index}.bin`), artifact.data);
    }
    await atomicWriteFile(
      manifest,
      JSON.stringify({
        remoteId,
        artifacts: artifacts.map(({ name, contentType }) => ({ name, contentType })),
      }),
    );
  }

  private async readInlineArtifacts(jobId: string): Promise<DurableInlineArtifacts | null> {
    const dir = this.inlineArtifactDir(jobId);
    try {
      const raw = JSON.parse(await readFile(toExtendedLength(join(dir, "manifest.json")), "utf8")) as {
        remoteId?: unknown;
        artifacts?: unknown;
      };
      if (typeof raw.remoteId !== "string" || !Array.isArray(raw.artifacts) || raw.artifacts.length > 64) {
        throw new Error("invalid inline artifact manifest");
      }
      const artifacts: DispatchArtifact[] = [];
      for (const [index, value] of raw.artifacts.entries()) {
        if (
          typeof value !== "object" || value === null ||
          typeof (value as { name?: unknown }).name !== "string" ||
          typeof (value as { contentType?: unknown }).contentType !== "string"
        ) {
          throw new Error("invalid inline artifact metadata");
        }
        artifacts.push({
          name: (value as { name: string }).name,
          contentType: (value as { contentType: string }).contentType,
          data: new Uint8Array(await readFile(toExtendedLength(join(dir, `${index}.bin`)))),
        });
      }
      return { remoteId: raw.remoteId, artifacts };
    } catch {
      await rm(toExtendedLength(dir), { recursive: true, force: true }).catch(() => {});
      return null;
    }
  }

  private async landDurableInline(
    job: Job,
    client: DispatchClient,
    key: string,
    artifacts: DispatchArtifact[],
  ): Promise<void> {
    await this.landAndSucceed(job, client, key, undefined, artifacts);
    const settled = this.jobs.get(job.id);
    if (settled && TERMINAL.has(settled.status)) {
      await rm(toExtendedLength(this.inlineArtifactDir(job.id)), { recursive: true, force: true }).catch(() => {});
    }
  }

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
      if (!this.stillActiveRun(job)) return; // cancelled or retired while bytes were in flight
      // Sanitisation before verification (SPEC-021 §2.10): an engine that embeds workflow
      // metadata has it stripped here, and a container the sanitiser cannot process fails the
      // job with the reason — never landed as-is.
      if (this.opts.prepareArtifact) {
        const prepared: DispatchArtifact[] = [];
        for (const artifact of artifacts) {
          const result = this.opts.prepareArtifact(job, artifact);
          if (!result.ok) {
            await this.terminalize(job, "failed", `artifact "${artifact.name}" was refused: ${result.reason}`, undefined, "transient");
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
          await this.terminalize(job, "failed", `artifact "${artifact.name}" failed verification: ${problem}`, undefined, "transient");
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
          if (this.disposed || !this.stillActiveRun(job)) return; // killed/retired during staging
          for (const s of staged) {
            await rename(toExtendedLength(s.from), toExtendedLength(s.to));
            landed.push(s.rel);
          }
        } finally {
          await rm(toExtendedLength(stagingDir), { recursive: true, force: true }).catch(() => {});
        }
      });
      if (!available) {
        if (!this.stillActiveRun(job)) return;
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
    if (!this.stillActiveRun(job)) return;
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
    failureClass?: FailureClass,
  ): Promise<void> {
    if (this.retiredEngineRuns.has(this.engineRunKey(job))) return;
    // Every failed row carries the decision the retry surfaces consume. Centralising it here
    // covers provider verdicts, local preparation, recovery, verification and exhausted retries;
    // a caller cannot add a new terminal failure path and accidentally leave the class transient.
    const terminal: Job = {
      ...job,
      status: outcome,
      error,
      failureClass: outcome === "failed" ? (failureClass ?? classifyError(error ?? "terminal failure")) : null,
      ...(costMicroUsd !== undefined ? { providerCostMicroUsd: Math.round(costMicroUsd) } : {}),
      updatedAt: this.clock(),
    };
    await this.transition(terminal);
    if (this.disposed) return;
    // An append that landed this pass is proof enough; asking the file again could only be
    // wrong. A lock arriving in that window (a scanner opening the file we just wrote) used to
    // answer "no entry" and fail a finalization whose spend record was durably in place —
    // settled, so no later start-up replayed it, and the user got a needs-you row for work that
    // had wholly succeeded. Only when nothing was appended is presence still an open question,
    // and there `catch → false` is the honest read: unknown means the follow-on waits.
    const ledgered = await this.appendLedgerOnce(terminal, costMicroUsd);
    if (this.disposed) return;
    if (
      terminal.finalization?.status === "pending" &&
      !ledgered &&
      !(await this.opts.ledger.has(terminal.id).catch(() => false))
    ) {
      await this.failFinalization(terminal, "the job's ledger entry could not be confirmed");
      return;
    }
    try {
      await this.opts.onTerminal?.(terminal);
      if (terminal.finalization?.status === "pending") await this.completeFinalization(terminal);
      else if (terminal.status === "succeeded") this.emitReady(terminal);
    } catch (error) {
      if (terminal.finalization?.status === "pending") await this.failFinalization(terminal, error);
    }
  }

  private async appendLedgerOnce(
    job: Job,
    costMicroUsd?: number,
    startupJobIds?: Set<string>,
  ): Promise<boolean> {
    try {
      if (startupJobIds ? startupJobIds.has(job.id) : await this.opts.ledger.has(job.id)) return false;
      await this.appendLedgerEntry(job, costMicroUsd ?? job.providerCostMicroUsd);
      startupJobIds?.add(job.id);
      return true;
    } catch {
      // A failed ledger write is the ⑦ crash window: the terminal row is already durable, and
      // the next start-up completes the missing entry idempotently (R-16). Never crash a pump.
      // A failed ledger READ lands here too, and deliberately skips the append: with presence
      // unknowable, appending risks the permanent duplicate while skipping risks only the
      // missing entry that ⑦ recovery already completes.
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
    try {
      await this.cancelInner(jobId, job);
    } finally {
      this.cancelling.delete(jobId);
    }
  }

  private async cancelInner(jobId: string, job: Job): Promise<void> {
    const lane = this.lane(job.provider);
    lane.fifo = lane.fifo.filter((id) => id !== jobId);
    lane.notBefore.delete(jobId);
    const submitAbort = this.submitAborts.get(jobId);
    // Claimed before the abort, not after: the rejection it causes races this method, and the
    // submit's error path has to be able to tell a cancellation from a transport failure.
    this.cancelling.add(jobId);
    submitAbort?.abort();
    if (submitAbort !== undefined) await Promise.resolve();
    if (TERMINAL.has(this.jobs.get(jobId)?.status ?? "")) return;
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
    // A local abort ends our wait, not necessarily the provider's work. Preserve that distinction
    // without turning a deliberate cancellation into a reconciliation hold.
    const local = (PROVIDERS as Record<string, { local: boolean } | undefined>)[job.provider]?.local === true;
    const outcomeMayBeRemote =
      !local &&
      (job.status === "submitting" ||
        job.providerJobId != null ||
        (job.attempt > 0 && job.submissionRejected !== true));
    const reason = outcomeMayBeRemote
      ? "Cancelled in Arke. The provider may still complete or charge for this request."
      : null;
    // A cancelled job still writes a ledger entry (R-15, D10).
    await this.terminalize(job, "cancelled", reason);
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
    // `null` when the ledger exists but could not be read. Not an empty set: an empty snapshot
    // says every terminal job in history was never billed, and the ⑦ completion pass below
    // would append a second entry for each — permanent duplicates in an append-only file,
    // doubling every spend total and reading exactly like the double-charge bug (R-16, D11).
    // Unknown parks the ledger-gated work instead; entries stay missing until a start-up that
    // can read the file completes them, the same idempotent recovery a ⑦ crash relies on.
    // Job recovery itself proceeds — none of it consults the ledger, and R-18 still holds.
    const ledgerJobIds = await this.opts.ledger
      .readJobIds()
      .then((ids) => new Set(ids), () => null);
    const missingLedger: Job[] = [];
    for (const { job } of folded) this.jobs.set(job.id, job);
    const report: ReconcileAction[] = [];

    // Recovery may fold and report immediately, but a provider with a spawned runtime does not
    // pump or poll recovered work until that runtime is ready. The gate runs in the background so
    // an importing GPU stack cannot hold the whole application startup hostage.
    if (this.opts.awaitRecoveryReady) {
      const providers = new Set(
        folded
          .filter(({ job }) => !TERMINAL.has(job.status) && job.status !== "needs-reconciliation")
          .map(({ job }) => job.provider),
      );
      for (const provider of providers) {
        const lane = this.lane(provider);
        lane.recoveryBlocked = true;
        const gate = this.opts
          .awaitRecoveryReady(provider)
          .then(
            (ready) => {
              lane.recoveryBlocked = !ready;
            },
            () => {},
          )
          .finally(() => {
            if (lane.recoveryGate === gate) lane.recoveryGate = null;
            this.pump(provider);
          });
        lane.recoveryGate = gate;
        this.trackRun(gate);
      }
    }

    for (const { job, prior } of folded) {
      if (TERMINAL.has(job.status)) {
        // Only what the ledger can answer parks. The append and the replay both turn on
        // "was this billed", so an unreadable snapshot withholds them; the fail verdict below
        // never asked, and parking it stranded the job as an undeletable, uncancellable
        // "preparing result" row for the rest of the session (Codex round 1).
        if (ledgerJobIds !== null) {
          // Crash window ⑦: terminal without its ledger entry → append exactly one (R-16).
          if (!ledgerJobIds.has(job.id)) missingLedger.push(job);
        }
        // A replayable follow-on's verdict turns on the ledger — entry present replays it,
        // entry absent fails it — so an unreadable snapshot withholds that one. Every other
        // pending follow-on is failed either way, which is why withholding it bought nothing.
        const replayable =
          job.status === "succeeded" && this.needsReplayableFinalization(job) && this.finalizationUnsettled(job);
        if (replayable && ledgerJobIds?.has(job.id) === true) {
          await this.retryFinalization(job.id);
        } else if (
          job.status === "succeeded" &&
          job.finalization?.status === "pending" &&
          !(replayable && ledgerJobIds === null)
        ) {
          // Follow-ons outside the replayable set are not crash-safe. Surface the interrupted
          // preparation honestly instead of duplicating takes or mutating domain state.
          await this.failFinalization(job, "finalization was interrupted before completion");
        }
        await rm(toExtendedLength(this.inlineArtifactDir(job.id)), { recursive: true, force: true }).catch(() => {});
        continue;
      }
      const inline = await this.readInlineArtifacts(job.id);
      if (inline !== null) {
        const client = this.opts.clients[job.provider];
        if (!client) {
          const reason = `no client for provider "${job.provider}"`;
          await this.terminalize(job, "failed", reason);
          report.push({ jobId: job.id, action: "failed", detail: reason });
          continue;
        }
        const recovering: Job = {
          ...job,
          providerJobId: inline.remoteId,
          error: null,
          updatedAt: this.clock(),
        };
        report.push({ jobId: job.id, action: "resumed-polling", detail: "resumed durable inline artifacts" });
        this.trackRun(
          this.runAfterRecoveryGate(job.provider, async () => {
            const current = this.jobs.get(job.id);
            if (!current || TERMINAL.has(current.status) || current.status === "needs-reconciliation") return;
            await this.transition({ ...recovering, status: "running", updatedAt: this.clock() });
            await this.landDurableInline({ ...recovering, status: "running" }, client, "", inline.artifacts);
          }),
        );
        continue;
      }
      if (job.status === "needs-reconciliation") {
        report.push({ jobId: job.id, action: "held-for-user", detail: job.error ?? "awaiting your answer" });
        continue;
      }
      if (job.status === "queued") {
        if (job.failureClass === "provider-fault") {
          this.pauseLane(job.provider, "fault", job.error ?? "the provider requires attention");
          report.push({ jobId: job.id, action: "held-for-user", detail: job.error ?? "provider fault" });
          continue;
        }
        const client = this.opts.clients[job.provider];
        const local = (PROVIDERS as Record<string, { local: boolean } | undefined>)[job.provider]?.local === true;
        if (
          !local &&
          !client?.declarations.supportsIdempotencyKey &&
          prior?.status === "submitting" &&
          job.submissionRejected !== true
        ) {
          const action = await this.holdForUser(job);
          report.push(action);
          continue;
        }
        this.lane(job.provider).fifo.push(job.id);
        report.push({ jobId: job.id, action: "requeued" });
        continue;
      }
      if (job.status === "running") {
        if (job.failureClass === "provider-fault") {
          this.pauseLane(job.provider, "fault", job.error ?? "the provider requires attention");
          report.push({ jobId: job.id, action: "held-for-user", detail: job.error ?? "provider fault" });
          continue;
        }
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
        this.trackRun(this.runAfterRecoveryGate(job.provider, () => this.resumePolling(job)));
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

    // missingLedger is only ever populated from a readable snapshot; the guard restates that
    // for the types and keeps the completion pass structurally unreachable while parked.
    if (ledgerJobIds !== null) {
      for (const job of missingLedger) {
        if (await this.appendLedgerOnce(job, undefined, ledgerJobIds)) {
          report.push({ jobId: job.id, action: "ledger-completed" });
        }
      }
    }

    // New work only after every non-terminal job is resolved (R-18), unless shutdown closed
    // admission while recovery was in flight.
    if (!this.disposed && !this.admissionClosed) this.accepting = true;
    if (report.length > 0) this.opts.emit({ at: this.clock(), type: "queue.reconciled", report });
    for (const provider of this.lanes.keys()) this.pump(provider);
    return report;
  }

  private async resumePolling(job: Job): Promise<void> {
    if (!this.stillPolling(job)) return;
    const client = this.opts.clients[job.provider];
    const key = await this.keyFor(job.provider);
    if (!client || key === null) {
      this.pauseLane(job.provider, "credential", "no credential stored for this provider");
      return;
    }
    await this.pollToTerminal(job, client, key);
  }

  private async runAfterRecoveryGate(provider: string, work: () => Promise<void>): Promise<void> {
    const lane = this.lane(provider);
    const gate = lane.recoveryGate;
    if (gate !== null) await gate;
    if (this.disposed) return;
    if (lane.recoveryBlocked) {
      lane.deferredRecovery.push(work);
      return;
    }
    await work();
  }

  /** A runtime that became ready after a failed startup releases its recovered work. */
  releaseRecovery(provider: string): void {
    const lane = this.lane(provider);
    if (!lane.recoveryBlocked) return;
    lane.recoveryBlocked = false;
    const deferred = lane.deferredRecovery.splice(0);
    for (const work of deferred) this.trackRun(work());
    this.pump(provider);
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
      await this.requeueSafely(decision.engine ? { ...job, engine: decision.engine } : job);
      return { jobId: job.id, action: "requeued", detail: "the engine was relaunched and holds no old work" };
    }
    if (decision.action === "fail") {
      await this.terminalize(job, "failed", decision.reason);
      return { jobId: job.id, action: "failed", detail: decision.reason };
    }
    return this.holdForUser(job);
  }

  private async holdForUser(job: Job, failureClass?: FailureClass): Promise<ReconcileAction> {
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
      ...(failureClass !== undefined ? { failureClass } : {}),
      error: local
        ? `Arke did not witness the submission result — the engine kept running while Arke restarted, and cannot confirm what happened. No automatic retry was made. Resubmitting ${duplicateCost}.`
        : `Arke did not witness the submission result. ${job.provider} may have accepted and charged it, and cannot confirm what happened. No automatic retry was made. Resubmitting ${duplicateCost}; the prior actual cost is unknown.`,
      updatedAt: this.clock(),
    };
    await this.transition(held);
    this.emitQueueStatus(job.provider);
    return { jobId: job.id, action: "held-for-user", detail: held.error ?? undefined };
  }

  private needsReplayableFinalization(job: Job): boolean {
    return isReplayableFinalization(job) && job.landedFiles?.[0] !== undefined;
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

  private async failFinalization(job: Job, cause: unknown): Promise<void> {
    const detail = (cause instanceof Error ? cause.message : String(cause)) || "unknown finalization failure";
    const error = this.needsReplayableFinalization(job)
      ? "Generation completed, but its result could not be prepared. Retry finalization; this will not contact the provider or charge again."
      : "Generation completed, but its result could not be prepared. Open Activity for details; no additional provider charge was made.";
    const failed: Job = {
      ...job,
      finalization: { status: "failed", error, cause: detail, updatedAt: this.clock() },
      updatedAt: this.clock(),
    };
    await this.transition(failed);
    this.opts.onFinalizationFailure?.(failed, detail);
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
      } catch (error) {
        await this.failFinalization(pending, error);
      }
    } finally {
      this.finalizing.delete(jobId);
    }
  }

  /**
   * The world-open sweep (SPEC-014): replay every finalization this world is still owed.
   *
   * Ledger-gated like start-up's replay, and for the same reason — this is the one automatic
   * path that reaches a *pending* row, so without the gate a job whose verdict start-up
   * deliberately withheld got replayed the moment its world opened, running the follow-on
   * ahead of a spend record nobody could confirm (Codex round 1). The park has to hold until
   * a start-up that can read the file, not until the first world open.
   */
  async retryFinalizationsForWorld(worldId: string): Promise<void> {
    const jobs = [...this.jobs.values()].filter(
      (job) =>
        job.worldId === worldId &&
        job.status === "succeeded" &&
        this.needsReplayableFinalization(job) &&
        this.finalizationUnsettled(job),
    );
    if (jobs.length === 0) return;
    // One probe for the sweep, not one per job: the answer cannot change mid-pass in a way
    // that would make a withheld replay safe.
    const billed = await this.opts.ledger.readJobIds().catch(() => null);
    if (billed === null) return;
    for (const job of jobs) if (billed.has(job.id)) await this.retryFinalization(job.id);
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
    requeueAs?: (job: Job) => JobEngineIdentity | null,
  ): Promise<Job[]> {
    const orphans = [...this.jobs.values()].filter(
      (job) => job.provider === provider && !TERMINAL.has(job.status) && job.status !== "needs-reconciliation" && !stillOurs(job),
    );
    for (const job of orphans) {
      const lane = this.lane(job.provider);
      lane.fifo = lane.fifo.filter((id) => id !== job.id);
      lane.notBefore.delete(job.id);
      const replacement = requeueAs?.(job) ?? null;
      if (replacement !== null) {
        const retiredRun = this.engineRunKey(job);
        this.retiredEngineRuns.add(retiredRun);
        lane.inFlight.delete(retiredRun);
        this.submitAborts.get(job.id)?.abort();
        const requeued: Job = {
          ...job,
          engine: replacement,
          status: "queued",
          providerJobId: null,
          step: null,
          error: null,
          updatedAt: this.clock(),
        };
        // Publish the epoch fence before awaiting disk so old poll/submit continuations stop
        // immediately. The journal append still precedes the pump that may contact replacement.
        this.jobs.set(job.id, requeued);
        await this.transition(requeued);
        if (!lane.fifo.includes(job.id)) lane.fifo.push(job.id);
        continue;
      }
      // Deliberately no remote cancel: the engine that holds this work is the one we can no
      // longer address, and the engine we CAN address never had it.
      await this.terminalize(job, "failed", reason);
    }
    if (orphans.length > 0) this.emitQueueStatus(provider);
    this.pump(provider);
    return orphans;
  }

  /** Hold dispatch and recovered polling while a provider's replacement runtime starts. */
  blockRecovery(provider: string): void {
    this.lane(provider).recoveryBlocked = true;
  }

  resetProviderTransport(provider: string): void {
    this.opts.clients[provider]?.resetTransport?.();
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
      await this.terminalize(
        job,
        "cancelled",
        "Abandoned in Arke. The provider may still complete or charge for the unwitnessed request.",
      );
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
      } else if (lane.maxConcurrent < this.concurrencyFor(provider)) {
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

  private concurrencyFor(provider: string): number {
    const configured = this.providerConcurrency[provider];
    return configured !== undefined && Number.isInteger(configured) && configured > 0
      ? configured
      : this.baseConcurrency;
  }

  private stillQueued(job: Job): boolean {
    const current = this.jobs.get(job.id);
    return current?.status === "queued" && this.engineRunKey(current) === this.engineRunKey(job);
  }

  private stillSubmitting(job: Job): boolean {
    const current = this.jobs.get(job.id);
    return current?.status === "submitting" && current.attempt === job.attempt && this.engineRunKey(current) === this.engineRunKey(job);
  }

  private stillActiveRun(job: Job): boolean {
    const current = this.jobs.get(job.id);
    return current !== undefined &&
      !TERMINAL.has(current.status) &&
      current.status !== "needs-reconciliation" &&
      current.attempt === job.attempt &&
      this.engineRunKey(current) === this.engineRunKey(job);
  }

  private engineRunKey(job: Job): string {
    return `${job.id}|${job.engine?.source ?? "legacy"}|${job.engine?.instanceId ?? "legacy"}|${job.engine?.processEpoch ?? "legacy"}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.sleepTimers.delete(timer);
        resolve();
      }, ms);
      this.sleepTimers.set(timer, resolve);
      timer.unref?.();
    });
  }

  /** Simulated kill for the crash suite, and clean shutdown: no further writes or events. */
  dispose(): void {
    this.stopAccepting();
    this.disposed = true;
    for (const client of new Set(Object.values(this.opts.clients))) client.dispose?.();
    for (const controller of this.submitAborts.values()) controller.abort();
    this.submitAborts.clear();
    for (const lane of this.lanes.values()) {
      if (lane.timer) clearTimeout(lane.timer);
      lane.timer = null;
      lane.deferredRecovery = [];
    }
    for (const [timer, resolve] of this.sleepTimers) {
      clearTimeout(timer);
      resolve();
    }
    this.sleepTimers.clear();
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled(this.activeRuns);
  }

  drain(): Promise<void> {
    return this.journal.drain();
  }
}
