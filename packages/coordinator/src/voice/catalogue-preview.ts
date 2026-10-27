import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { estimateSpeechMicroUsd, NARRATOR_PREVIEW_TEXT, VOICE_PREVIEW_SCOPE, supportsVoiceUse,
  voiceFormatForModel, voiceTargetKey, CACHE_CLEANUP_POLICY, RECOVERY_ACTION_LIMITS, STORAGE_POLICY, storageWarningFloor,
  type RecoveryCacheMaintenanceRun, type RecoveryCacheScope, type VoiceCandidate, type ModelManifest, type DomainEvent, type Job } from "@arke-studio/contracts";
import type { EnqueueInput } from "../queue/dispatcher.js";
import type { SidecarLike } from "./service.js";
import { cachedVoiceAudioLooksRight } from "./service.js";
import { atomicWriteFile } from "../world/atomic.js";
import { LocalPreviewCache } from "../storage/local-preview-cache.js";
import type { ResolvedMediaFile } from "../transport.js";
import type { AppStorageService } from "../storage/service.js";
import { CacheCleanupControl } from "../storage/cache-cleanup-control.js";
import { KOKORO_PRESETS, localCandidates } from "@arke-studio/voice";

const MAX_SAMPLE_BYTES = 12 * 1024 * 1024;

/** Provider metadata is not permission to fetch an arbitrary host or forward credentials. */
export function approvedVoiceSample(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.port &&
      parsed.hostname === "storage.googleapis.com" && parsed.pathname.startsWith("/eleven-public-prod/");
  } catch { return false; }
}

export class CataloguePreviewService {
  private voices = new Map<string, VoiceCandidate>();
  private requests = new Map<string, { abort: AbortController; jobId?: string }>();
  private results = new Map<string, Extract<DomainEvent, { type: "voice.catalogue-preview" }>>();
  private closed = false;
  private readonly localCache: LocalPreviewCache;
  private readonly cleanupControl: CacheCleanupControl;
  private readonly cleanupLifetime = new AbortController();
  private maintenanceRootHold: ReturnType<AppStorageService["acquireRoot"]> | null = null;
  private maintenanceRootIdentity: string | null = null;
  private maintenanceSyncRevision = 0;
  private scopeRefresh: Promise<void> | null = null;
  private candidates: { root: string; at: number; files: number; bytes: number } | null = null;
  constructor(private readonly deps: {
    root: string;
    sidecar: SidecarLike | null;
    manifest: ModelManifest | undefined;
    enqueue?: (input: EnqueueInput) => Promise<Job>;
    cancel?: (id: string) => Promise<void>;
    emit: (event: DomainEvent) => void;
    fetch?: typeof fetch;
    storage?: AppStorageService;
    now?: () => number;
    cleanupChanged?: () => void;
  }) {
    const now = deps.now ?? Date.now;
    this.cleanupControl = new CacheCleanupControl(join(deps.root, "cleanup-control.json"), { now, onChange: deps.cleanupChanged });
    this.localCache = new LocalPreviewCache(deps.root, deps.storage, { control: this.cleanupControl, now });
  }
  async initializeCleanup(): Promise<void> { await this.cleanupControl.open(); await this.refreshCleanupScope(); }
  refreshCleanupScope(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.scopeRefresh ??= this.syncMaintenanceRoot().finally(() => {
      this.scopeRefresh = null;
      if (!this.closed) try { this.deps.cleanupChanged?.(); } catch { /* Presentation grants no cleanup authority. */ }
    });
    return this.scopeRefresh;
  }
  private async syncMaintenanceRoot(): Promise<void> {
    const revision = ++this.maintenanceSyncRevision, root = await this.localCache.maintenanceRoot();
    const inventory = root ? await this.localCache.inventory() : null, policy = this.cleanupControl.maintenancePolicy(), at = (this.deps.now ?? Date.now)();
    if (this.closed || revision !== this.maintenanceSyncRevision) return;
    // Keep the last fresh observation during the read. A transient empty publication would
    // revoke a scoped approval when its own capacity refresh schedules this metadata read.
    if (!root || !this.deps.storage || inventory?.state !== "recorded" || !Number.isSafeInteger(at) ||
      await this.localCache.maintenanceRoot() !== root || (!inventory.entries.length && (!policy?.enabled || policy.rootIdentity !== root))) {
      this.candidates = null;
      this.maintenanceRootHold?.release(); this.maintenanceRootHold = null; this.maintenanceRootIdentity = null; return;
    }
    if (this.closed || revision !== this.maintenanceSyncRevision) return;
    const keys = this.cleanupKeys(), rows = inventory.entries.filter(row => keys.has(row.resourceKey) && !row.leased &&
      row.createdAt <= at - CACHE_CLEANUP_POLICY.minAgeMs).sort((a, b) => a.createdAt - b.createdAt).slice(0, CACHE_CLEANUP_POLICY.maxFiles);
    this.candidates = { root, at, files: rows.length, bytes: rows.reduce((sum, row) => sum + row.recordedBytes, 0) };
    if (this.maintenanceRootHold && this.maintenanceRootIdentity === root) return;
    this.maintenanceRootHold?.release(); this.maintenanceRootHold = this.deps.storage.acquireRoot(join(this.deps.root, "local-presets-v1"), "working-files");
    this.maintenanceRootIdentity = root;
  }
  private cleanupScope(): RecoveryCacheScope | null {
    const inventory = this.candidates, now = (this.deps.now ?? Date.now)();
    if (this.closed || !this.maintenanceRootHold || !inventory || inventory.root !== this.maintenanceRootIdentity ||
      inventory.at > now || now - inventory.at > STORAGE_POLICY.forecastMaxAgeMs) return null;
    const root = this.deps.storage?.snapshot().roots.find(root => root.rootId === this.maintenanceRootHold!.rootId), fact = root?.capacity;
    if (root?.state !== "measured" || !fact || fact.availableBytes === null || fact.measuredAt > now || now - fact.measuredAt > STORAGE_POLICY.forecastMaxAgeMs) return null;
    return { volumeId: fact.volumeId, mappingRevision: fact.mappingRevision, measuredAt: fact.measuredAt, inventoryAt: inventory.at,
      candidateFiles: inventory.files, recordedBytes: inventory.bytes,
      revision: createHash("sha256").update(JSON.stringify(["fixed-local-preset-previews", inventory.root, fact.volumeId, fact.mappingRevision])).digest("hex") };
  }
  private cleanupKeys(): Set<string> {
    const eligible = [...localCandidates(KOKORO_PRESETS), ...this.voices.values()].filter(voice => voice.provider === "kokoro" &&
      !voice.unavailableReason && voice.readsClone === undefined && voice.narratorCopy !== true && supportsVoiceUse(voice, "narration"));
    return new Set(eligible.slice(0, 256).map(voice => createHash("sha256").update(JSON.stringify([voiceTargetKey(voice), NARRATOR_PREVIEW_TEXT, "wav", 1])).digest("hex")));
  }
  revokeMaintenance(): void { this.cleanupControl.revokeMaintenance(); }
  async setMaintenance(enabled: boolean): Promise<boolean> {
    if (!enabled) this.revokeMaintenance();
    await this.initializeCleanup();
    if (enabled && (!this.deps.storage?.supportsAdmission || process.platform !== "win32")) return false;
    const root = enabled ? await this.localCache.maintenanceRoot(true) : null;
    if (enabled && !root) return false;
    const saved = await this.cleanupControl.setMaintenance(enabled, root, () => !this.closed && !this.cleanupLifetime.signal.aborted);
    await this.refreshCleanupScope(); return saved;
  }
  maintenanceReady(): boolean {
    const policy = this.cleanupControl.maintenancePolicy(), now = (this.deps.now ?? Date.now)();
    if (this.closed || !policy?.enabled || !this.cleanupControl.snapshot().available || !this.maintenanceRootHold ||
      !Number.isSafeInteger(now) || now < policy.changedAt || now < policy.nextAttemptAt) return false;
    const root = this.deps.storage?.snapshot().roots.find(root => root.rootId === this.maintenanceRootHold!.rootId), fact = root?.capacity;
    return root?.state === "measured" && !!root.pressure && (root.pressure.warning || root.pressure.critical) && !!fact && fact.availableBytes !== null &&
      fact.measuredAt <= now && now - fact.measuredAt <= STORAGE_POLICY.forecastMaxAgeMs &&
      root.pressure.volumeId === fact.volumeId && root.pressure.mappingRevision === fact.mappingRevision &&
      fact.availableBytes < storageWarningFloor(fact.totalBytes) + STORAGE_POLICY.clearMarginBytes;
  }
  async runMaintenance(planId: string, signal: AbortSignal, allowed: () => boolean): Promise<void> {
    await this.initializeCleanup();
    if (!allowed() || !this.maintenanceReady()) return;
    const root = await this.localCache.maintenanceRoot(), policy = this.cleanupControl.maintenancePolicy();
    if (!root || !policy || root !== policy.rootIdentity || signal.aborted) return;
    const token = await this.cleanupControl.reserveMaintenance(planId, root, () => !this.closed && !signal.aborted && allowed());
    if (!token) return;
    const started = (this.deps.now ?? Date.now)(), expires = started + RECOVERY_ACTION_LIMITS.previewMs;
    const valid = () => { const at = (this.deps.now ?? Date.now)(); return !this.closed && !signal.aborted && allowed() &&
      Number.isSafeInteger(at) && at >= started && at < expires && this.cleanupControl.maintenanceCurrent(planId, token, root); };
    let run: Omit<RecoveryCacheMaintenanceRun, "at"> = { status: "refused", cleanup: { removedFiles: 0, logicalBytes: 0,
      availableBefore: null, availableAfter: null, reclaimedBytes: null } };
    try {
      const prepared = await this.prepareCleanup(signal);
      if (prepared && prepared.stopAtAvailableBytes !== null && valid()) run = await prepared.run(planId, signal, valid, true);
    } catch { run = { ...run, status: "unknown" }; }
    finally { await this.cleanupControl.finishMaintenance(planId, run); }
  }
  async reconcileCleanup(signal: AbortSignal = this.cleanupLifetime.signal) {
    await this.initializeCleanup();
    return this.localCache.reconcileCleanup(AbortSignal.any([signal, this.cleanupLifetime.signal]));
  }
  cleanupAvailability(): NonNullable<import("@arke-studio/contracts").RecoveryPolicySnapshot["cleanup"]> {
    const state = this.cleanupControl.snapshot(), policy = this.cleanupControl.maintenancePolicy(), scope = this.cleanupScope();
    return { available: !this.closed && process.platform === "win32" && state.available, pending: state.pending, audit: state.audit,
      maintenance: { enabled: policy?.enabled === true, rootScope: "fixed-local-preset-previews", minAgeMs: CACHE_CLEANUP_POLICY.minAgeMs,
        maxFiles: CACHE_CLEANUP_POLICY.maxFiles, maxBytes: CACHE_CLEANUP_POLICY.maxBytes, nextAttemptAt: policy?.nextAttemptAt ?? 0,
        ...(policy?.lastRun ? { lastRun: policy.lastRun } : {}) },
      ...(scope ? { scope } : {}),
      ...(state.reason ? { reason: state.reason } : process.platform !== "win32" ? { reason: "unsupported" as const } : {}) };
  }
  async prepareCleanup(signal: AbortSignal, expectedScope?: string): ReturnType<LocalPreviewCache["prepareCleanup"]> {
    await this.initializeCleanup();
    if (expectedScope && this.cleanupScope()?.revision !== expectedScope) return null;
    const prepared = await this.localCache.prepareCleanup(this.cleanupKeys(), signal); await this.refreshCleanupScope();
    if (!prepared || expectedScope && (this.cleanupScope()?.revision !== expectedScope || prepared.rootIdentity !== this.maintenanceRootIdentity)) return null;
    return { ...prepared, run: async (planId, signal, valid, automatic) => {
      try {
        if (expectedScope) {
          await this.initializeCleanup();
          if (this.maintenanceRootHold) await this.deps.storage?.measure(this.maintenanceRootHold.rootId, signal, (this.deps.now ?? Date.now)());
          if (this.cleanupScope()?.revision !== expectedScope) return { status: "refused", cleanup: {
            removedFiles: 0, logicalBytes: 0, availableBefore: null, availableAfter: null, reclaimedBytes: null } };
        }
        return await prepared.run(planId, signal, () => valid() && (!expectedScope || this.cleanupScope()?.revision === expectedScope), automatic);
      } finally { await this.refreshCleanupScope(); }
    } };
  }

  catalogue(voices: VoiceCandidate[]): VoiceCandidate[] {
    const annotated = voices.map(voice => {
      const model = this.deps.manifest?.models.find(m => m.id === voice.model && m.provider === voice.provider);
      let preview: NonNullable<VoiceCandidate["preview"]> = { kind: "unavailable", reason: "No preview available" };
      // A library voice is never previewed here (SPEC-046 R-16, R-37): this path sends no
      // recording and asks no vendor, so the reader would take the clone's id for a preset it
      // has never heard of. Its own page previews it, with the question asked first.
      // Nor the app narrator's copy of another world's designed voice: a preview job is no
      // narration and carries no binding, so dispatch has no record to read it from.
      if (supportsVoiceUse(voice, "narration") && !voice.unavailableReason && voice.readsClone === undefined && voice.narratorCopy !== true) {
        if (approvedVoiceSample(voice.previewUrl)) preview = { kind: "sample", microUsd: 0 };
        else if (voice.provider === "kokoro" && this.deps.sidecar) preview = { kind: "generate", microUsd: 0 };
        else if (model && this.deps.enqueue && model.capability === "voice-tts") {
          preview = { kind: "generate", microUsd: estimateSpeechMicroUsd(model, NARRATOR_PREVIEW_TEXT) };
        }
      }
      return { ...voice, preview };
    });
    this.voices = new Map(annotated.map(v => [voiceTargetKey(v), v]));
    return annotated;
  }

  private result(requestId: string, result: Omit<Extract<DomainEvent, { type: "voice.catalogue-preview" }>, "at" | "type" | "requestId">): void {
    const event = { at: new Date().toISOString(), type: "voice.catalogue-preview" as const, requestId, ...result };
    this.results.delete(requestId);
    this.results.set(requestId, event);
    if (this.results.size > 32) this.results.delete(this.results.keys().next().value!);
    this.deps.emit(event);
  }

  initialEvents(): DomainEvent[] { return [...this.results.values()]; }

  observeJob(job: Job): void {
    if (job.worldId !== VOICE_PREVIEW_SCOPE) return;
    if (job.status === "needs-reconciliation" || job.finalization?.status === "failed") {
      const id = job.params["cataloguePreviewRequestId"];
      if (typeof id !== "string" || !this.requests.has(id)) return;
      this.result(id, { status: "failed", error: "The preview needs attention in Activity. It may already have been charged." });
      this.requests.delete(id);
    }
  }

  async request(input: { requestId: string; provider: string; model: string; voiceId: string; maxMicroUsd: number }): Promise<void> {
    if (this.closed || this.requests.has(input.requestId)) return;
    const work = { abort: new AbortController(), jobId: undefined as string | undefined };
    this.requests.set(input.requestId, work);
    this.result(input.requestId, { status: "loading" });
    try {
      const voice = this.voices.get(voiceTargetKey(input));
      if (!voice || voice.preview?.kind === "unavailable" || !voice.preview) throw new Error("Refresh the catalogue and choose an available voice.");
      const sample = voice.preview.kind === "sample";
      const model = this.deps.manifest?.models.find(m => m.id === voice.model && m.provider === voice.provider);
      const format = sample ? "mp3" : voice.provider === "kokoro" ? "wav" : model ? voiceFormatForModel(model) : "mp3";
      const hash = createHash("sha256").update(JSON.stringify([voiceTargetKey(voice), sample ? voice.previewUrl : NARRATOR_PREVIEW_TEXT, format, 1])).digest("hex");
      if (!sample && voice.provider === "kokoro") {
        await this.initializeCleanup();
        const file = `local-${hash}.wav`;
        const cached = await this.localCache.read(hash);
        if (work.abort.signal.aborted) return;
        if (!cached) {
          if (input.maxMicroUsd < 0) throw new Error("Refresh the preview price before generating it.");
          await this.localCache.generate(hash, async () => {
            const bytes = await this.deps.sidecar!.synthesize({ voiceId: voice.voiceId, text: NARRATOR_PREVIEW_TEXT }, { signal: work.abort.signal });
            if (!cachedVoiceAudioLooksRight(bytes, "wav")) throw new Error("The voice engine returned invalid audio.");
            return bytes;
          }, work.abort.signal);
        } else if (!cachedVoiceAudioLooksRight(cached, "wav")) throw new Error("The cached voice preview needs attention.");
        if (!work.abort.signal.aborted) { await this.refreshCleanupScope(); this.result(input.requestId, { status: "ready", file }); }
        return;
      }
      const file = `${hash}.${format}`;
      const absolute = join(this.deps.root, "audio", file);
      const cached = await readFile(absolute).catch(() => null);
      if (work.abort.signal.aborted) return;
      if (cached && cachedVoiceAudioLooksRight(cached, format)) {
        this.result(input.requestId, { status: "ready", file });
        return;
      }
      const price = sample || voice.provider === "kokoro" ? 0 : model ? estimateSpeechMicroUsd(model, NARRATOR_PREVIEW_TEXT) : Infinity;
      if (price > input.maxMicroUsd) throw new Error("The preview price changed. Refresh the catalogue before generating it.");
      if (sample) {
        const response = await (this.deps.fetch ?? fetch)(voice.previewUrl!, {
          redirect: "error", signal: AbortSignal.any([work.abort.signal, AbortSignal.timeout(30_000)]),
        });
        if (!response.ok || !response.body) throw new Error("The provider sample could not be loaded. Try again.");
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_SAMPLE_BYTES) throw new Error("The provider sample is too large.");
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        const bytes = Buffer.concat(chunks);
        if (!cachedVoiceAudioLooksRight(bytes, "mp3")) throw new Error("The provider sample is not valid audio.");
        if (work.abort.signal.aborted) return;
        await atomicWriteFile(absolute, bytes);
      } else {
        if (!model || !this.deps.enqueue) throw new Error("Preview generation is unavailable.");
        const job = await this.deps.enqueue({
          worldId: VOICE_PREVIEW_SCOPE, target: { kind: "voice-preview", id: hash },
          provider: voice.provider, model: voice.model, capability: "voice-tts",
          idempotencyKey: input.requestId,
          params: { voiceId: voice.voiceId, voiceLabel: voice.label, text: NARRATOR_PREVIEW_TEXT, audioFormat: format, cataloguePreviewRequestId: input.requestId },
          estimatedMicroUsd: price, landing: { dir: "audio", name: file },
        });
        work.jobId = job.id;
        if (work.abort.signal.aborted) await this.deps.cancel?.(job.id);
        else if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled" || job.status === "needs-reconciliation") this.terminal(job);
        else this.result(input.requestId, { status: "queued" });
        return;
      }
      if (!work.abort.signal.aborted) this.result(input.requestId, { status: "ready", file });
    } catch (error) {
      if (!work.abort.signal.aborted) this.result(input.requestId, { status: "failed", error: error instanceof Error ? error.message : "Preview failed. Try again." });
    } finally {
      if (!work.jobId) this.requests.delete(input.requestId);
    }
  }

  terminal(job: Job): void {
    if (job.worldId !== VOICE_PREVIEW_SCOPE) return;
    const id = job.params["cataloguePreviewRequestId"];
    if (typeof id !== "string") return;
    const request = this.requests.get(id);
    if (!request || request.abort.signal.aborted) return;
    if (job.status === "succeeded" && job.landing) this.result(id, { status: "ready", file: job.landing.name });
    else this.result(id, { status: "failed", error: "Preview generation did not complete. Check Activity before trying again." });
    this.requests.delete(id);
  }

  async cancel(requestId: string): Promise<void> {
    this.results.delete(requestId);
    const request = this.requests.get(requestId);
    if (!request) return;
    request.abort.abort();
    if (request.jobId) await this.deps.cancel?.(request.jobId);
    this.requests.delete(requestId);
  }

  close(): void {
    this.closed = true;
    this.maintenanceSyncRevision++; this.maintenanceRootHold?.release(); this.maintenanceRootHold = null;
    this.cleanupLifetime.abort();
    this.localCache.close();
    this.cleanupControl.closeAdmission();
    for (const request of this.requests.values()) request.abort.abort();
  }

  localPreviewInventory(): ReturnType<LocalPreviewCache["inventory"]> { return this.localCache.inventory(); }

  async serve(file: string): Promise<ResolvedMediaFile | null> {
    const local = /^local-([a-f0-9]{64})\.wav$/.exec(file);
    if (local) return this.localCache.serve(local[1]!);
    if (!/^[a-f0-9]{64}\.(mp3|wav|flac)$/.test(file)) return null;
    try {
      const root = await realpath(join(this.deps.root, "audio"));
      const resolved = await realpath(join(root, file));
      const rel = relative(root, resolved);
      if (rel.startsWith("..") || isAbsolute(rel)) return null;
      return { path: resolved, contentType: file.endsWith("mp3") ? "audio/mpeg" : file.endsWith("flac") ? "audio/flac" : "audio/wav" };
    } catch { return null; }
  }
}
