import { lstat } from "node:fs/promises";
import { setImmediate as yieldToHost } from "node:timers/promises";
import { buildRenderPlan, defaultExportPreset, resolveEffectAudioSource, createEffectPcmAnalyzer, deliveredEffectLayers,
  effectAudioSourceFingerprintMaterial, effectManifestFingerprintMaterial, effectAnalysisCanonicalJson, effectCueConflicts,
  EffectAudioSourceDescriptorSchema, EffectFeatureManifestSchema, EFFECT_ANALYSIS_PROFILE,
  type EffectAnalysisProjection, type EffectAnalysisState, type EffectClip, type EffectFeatureManifest,
  type ProductionBundle, type ProductionTimeline, type RenderPlan, type WorldBundle, type EffectRenderProjection, type ResolvedEffectAudioSource } from "@arke-studio/contracts";
import type { EffectAudioAnalysisHost, FrozenAudioInput } from "../media/node-effect-audio.js";
import { hashMediaFile } from "../media/media-file-hash.js";
import { containedWorldFilePath } from "../world/contained-file.js";
import type { WorldStore } from "../world/store.js";
import { cachedEffectManifest, EFFECT_ANALYSIS_CACHE, effectAnalysisHash, readEffectManifest, saveEffectManifest } from "./editor-effect-analysis-cache.js";

type Context = { production: ProductionBundle; timeline: ProductionTimeline; plan: RenderPlan; effect: EffectClip; source: ResolvedEffectAudioSource };
type Row = { state: EffectAnalysisState; manifest?: EffectFeatureManifest };
type Job = { control: AbortController; done: Promise<void>; requestFingerprint: string };
export type CandidateEffectAnalysis = { manifest: EffectFeatureManifest; requestFingerprint: string } | { reason: string };
type CandidateJob = { control: AbortController; done: Promise<ReadonlyMap<string, CandidateEffectAnalysis>> };
type Session = { store: WorldStore; rows: Map<string, Row>; jobs: Map<string, Job>; tail: Promise<void>;
  candidateJobs: Map<string, CandidateJob>;
  monitor: ReturnType<typeof setInterval>; checking: boolean; stats: Map<string, string>; lastWritable: boolean; dispose: () => void };
const keyOf = (productionId: string, effectId: string) => `${productionId}/${effectId}`;

/** Derived analysis owns no timeline commands and can never create an authored revision. */
export class EditorEffectAnalysisService {
  private readonly sessions = new Map<WorldStore, Session>();
  private readonly contextCache = new WeakMap<WorldStore, { productions: WorldBundle["productions"]; artifacts: WorldBundle["artifacts"]; result: Map<string, Context | string> }>();
  private stopped = false;
  constructor(private readonly host: EffectAudioAnalysisHost | undefined,
    private readonly publish: (analysis: EffectAnalysisProjection | null, scope: { worldId: string; productionId: string }) => void) {}

  private session(store: WorldStore): Session {
    const existing = this.sessions.get(store);
    if (existing) return existing;
    const session: Session = { store, rows: new Map(), jobs: new Map(), candidateJobs: new Map(), tail: Promise.resolve(), stats: new Map(), checking: false, lastWritable: store.canWrite(),
      monitor: setInterval(() => { void this.checkSources(session); }, 2000), dispose: () => {} };
    session.monitor.unref();
    session.dispose = () => { clearInterval(session.monitor); for (const job of [...session.jobs.values(), ...session.candidateJobs.values()]) job.control.abort(); this.sessions.delete(store); };
    store.closingSignal.addEventListener("abort", session.dispose, { once: true });
    this.sessions.set(store, session);
    return session;
  }

  private contexts(store: WorldStore): Map<string, Context | string> {
    const result = new Map<string, Context | string>(), bundle = store.getBundle();
    const previous = this.contextCache.get(store);
    if (previous?.productions === bundle.productions && previous.artifacts === bundle.artifacts) return previous.result;
    for (const production of bundle.productions) {
      if (production.timeline?.status !== "ready") continue;
      const timeline = production.timeline.timeline, effects = timeline.tracks.flatMap(track => track.effects ?? []);
      if (!effects.length) continue;
      const planned = buildRenderPlan({ production, artifacts: bundle.artifacts, timeline: production.timeline,
        scope: { kind: "production" }, preset: defaultExportPreset(production.meta) });
      const sources = new Map<string, ResolvedEffectAudioSource>();
      for (const effect of effects) {
        const key = keyOf(production.meta.id, effect.id);
        if (!effect.reaction.enabled) { result.set(key, "off"); continue; }
        if (!effect.audioInput) { result.set(key, "no-source"); continue; }
        if (!planned.ok) { result.set(key, planned.reason); continue; }
        const binding = JSON.stringify(effect.audioInput);
        let source = sources.get(binding);
        if (!source) { source = resolveEffectAudioSource({ timeline, production, artifacts: bundle.artifacts, plan: planned.plan, input: effect.audioInput }); sources.set(binding, source); }
        result.set(key, { production, timeline, plan: planned.plan, effect, source });
      }
    }
    this.contextCache.set(store, { productions: bundle.productions, artifacts: bundle.artifacts, result });
    return result;
  }

  /** Synchronous projection also invalidates stale work before any snapshot can call it Ready. */
  project(store: WorldStore | null | undefined): EffectAnalysisProjection[] {
    if (!store || store.isClosed() || this.stopped) return [];
    const contexts = this.contexts(store);
    if (!contexts.size) {
      const session = this.sessions.get(store);
      if (session) { for (const job of session.jobs.values()) job.control.abort(); session.rows.clear(); }
      return [];
    }
    const session = this.session(store), projections = new Map<string, EffectAnalysisProjection>();
    for (const [key, context] of contexts) {
      const [productionId, effectId] = key.split("/") as [string, string];
      let state: EffectAnalysisState;
      const old = session.rows.get(key);
      if (typeof context === "string") state = context === "off" ? { status: "off" }
        : context === "no-source" ? { status: "no-source", reason: "Choose an audio source" } : { status: "missing-source", reason: context };
      else if (!context.source.ok) state = { status: "missing-source", requestFingerprint: context.source.requestFingerprint, reason: context.source.reason };
      else if (old?.state.requestFingerprint === context.source.requestFingerprint) {
        state = old.state;
        if (state.status === "ready" && old.manifest) state = { ...state, cueConflicts: effectCueConflicts(context.effect, old.manifest) };
      } else state = { status: "source-changed", requestFingerprint: context.source.requestFingerprint, reason: old ? "Audio source changed" : "Prepare audio reaction",
        ...(old?.state.status === "ready" ? { previousManifestKey: old.state.manifestKey } : {}) };
      if (session.jobs.get(key)?.requestFingerprint !== state.requestFingerprint) session.jobs.get(key)?.control.abort();
      session.rows.set(key, { state, ...(state.status === "ready" && old?.manifest ? { manifest: old.manifest } : {}) });
      let projection = projections.get(productionId);
      if (!projection) { projection = { worldId: store.worldId, productionId, canPrepare: !!this.host && store.canWrite(), byEffectId: {} }; projections.set(productionId, projection); }
      projection.byEffectId[effectId] = state;
    }
    for (const key of session.rows.keys()) if (!contexts.has(key)) { session.jobs.get(key)?.control.abort(); session.rows.delete(key); }
    return [...projections.values()];
  }

  private notify(session: Session, productionId: string): void {
    const projection = this.project(session.store).find(row => row.productionId === productionId);
    this.publish(projection ?? null, { worldId: session.store.worldId, productionId });
  }

  async request(store: WorldStore, productionId: string, effectId: string, action: "prepare" | "retry" | "cancel", expectedSourceFingerprint?: string): Promise<void> {
    this.project(store);
    const session = this.sessions.get(store), key = keyOf(productionId, effectId), row = session?.rows.get(key);
    if (!session || !row || this.stopped) return;
    if (action === "cancel") {
      session.jobs.get(key)?.control.abort();
      row.state = { status: "failed", requestFingerprint: row.state.requestFingerprint, reason: "Analysis cancelled. Retry or turn reaction Off." };
      this.notify(session, productionId); return;
    }
    const existing = session.jobs.get(key);
    if (existing) {
      if (!existing.control.signal.aborted && existing.requestFingerprint === row.state.requestFingerprint) return existing.done;
      await existing.done;
      return this.request(store, productionId, effectId, action, expectedSourceFingerprint);
    }
    if (row.state.status === "off" || row.state.status === "no-source" || (row.state.status === "missing-source" && action !== "retry") ||
      (row.state.status === "failed" && action !== "retry")) return;
    if (expectedSourceFingerprint && row.state.sourceFingerprint && expectedSourceFingerprint !== row.state.sourceFingerprint) return;
    const context = this.contexts(store).get(key);
    if (!context || typeof context === "string" || !context.source.ok) return;
    const requestFingerprint = context.source.requestFingerprint;
    if (!this.host || !store.canWrite()) {
      row.state = { status: "failed", requestFingerprint, reason: !this.host ? "Audio analysis is unavailable on this host" : "World is read-only" };
      this.notify(session, productionId); return;
    }
    if (session.jobs.size + session.candidateJobs.size >= 32) {
      row.state = { status: "failed", requestFingerprint, reason: "Audio analysis queue is full. Retry after preparation finishes." };
      this.notify(session, productionId); return;
    }
    const control = new AbortController(), signal = AbortSignal.any([control.signal, store.closingSignal]);
    row.state = { status: "analysing", requestFingerprint, progress: 0 };
    const job: Job = { control, requestFingerprint, done: Promise.resolve() };
    session.jobs.set(key, job);
    job.done = session.tail.catch(() => {}).then(async () => {
      try {
        signal.throwIfAborted(); await store.assertOwnership();
        let manifest = await this.analyse(session, context, signal, progress => {
          if (session.rows.get(key)?.state.status === "analysing") {
            session.rows.set(key, { state: { status: "analysing", requestFingerprint, progress } }); this.notify(session, productionId);
          }
        });
        signal.throwIfAborted();
        const fresh = this.contexts(store).get(key);
        if (!fresh || typeof fresh === "string" || !fresh.source.ok || fresh.source.requestFingerprint !== requestFingerprint) throw new Error("Audio source changed during preparation");
        await store.assertOwnership();
        manifest = [...session.rows.values()].find(row => row.manifest?.manifestKey === manifest.manifestKey)?.manifest ?? manifest;
        session.rows.set(key, { manifest, state: { status: "ready", requestFingerprint, sourceFingerprint: manifest.sourceFingerprint,
          manifestKey: manifest.manifestKey, silent: manifest.silent, cueConflicts: effectCueConflicts(fresh.effect, manifest) } });
      } catch (error) {
        if (!store.isClosed() && session.rows.get(key)?.state.requestFingerprint === requestFingerprint && session.rows.get(key)?.state.status === "analysing") {
          session.rows.set(key, { state: { status: error instanceof MissingEffectAudioSource ? "missing-source" : "failed", requestFingerprint,
            reason: signal.aborted ? "Analysis cancelled. Retry or turn reaction Off." : error instanceof Error ? error.message : "Audio analysis failed" } });
        }
      } finally { session.jobs.delete(key); this.notify(session, productionId); }
    });
    session.tail = job.done; this.notify(session, productionId); return job.done;
  }

  /** Pending versions share the bounded decoder lane/cache, but never install Current readiness. */
  async prepareCandidate(store: WorldStore, input: { production: ProductionBundle; timeline: ProductionTimeline; plan: RenderPlan; basisHash: string },
    externalSignal?: AbortSignal): Promise<ReadonlyMap<string, CandidateEffectAnalysis>> {
    if (this.stopped || store.isClosed() || !store.canWrite()) throw new Error("World is read-only or closing");
    const session = this.session(store), key = `${input.production.meta.id}/${input.basisHash}`;
    const existing = session.candidateJobs.get(key);
    if (existing) return existing.done;
    if (session.jobs.size + session.candidateJobs.size >= 32) throw new Error("Audio analysis queue is full. Retry after preparation finishes.");
    const control = new AbortController(), signal = AbortSignal.any([control.signal, store.closingSignal, ...(externalSignal ? [externalSignal] : [])]);
    const job: CandidateJob = { control, done: Promise.resolve(new Map()) };
    session.candidateJobs.set(key, job);
    job.done = session.tail.catch(() => {}).then(async () => {
      const result = new Map<string, CandidateEffectAnalysis>(), retained = new Map<string, EffectFeatureManifest>();
      try {
        signal.throwIfAborted(); await store.assertOwnership();
        const effects = input.plan.effectRender ? deliveredEffectLayers(input.plan.effectRender).map(row => row.effect) : [];
        for (const effect of effects) {
          if (!effect.reaction.enabled) continue;
          signal.throwIfAborted();
          if (!this.host || !effect.audioInput) {
            result.set(effect.id, { reason: !this.host ? "Audio analysis is unavailable on this host" : "Choose an audio source" }); continue;
          }
          const source = resolveEffectAudioSource({ ...input, artifacts: store.getBundle().artifacts, input: effect.audioInput });
          if (!source.ok) { result.set(effect.id, { reason: source.reason }); continue; }
          try {
            const prior = [...result.values()].find((value): value is Extract<CandidateEffectAnalysis, { manifest: EffectFeatureManifest }> =>
              "manifest" in value && value.requestFingerprint === source.requestFingerprint);
            const manifest = prior?.manifest ?? await this.analyse(session, { ...input, effect, source }, signal, () => {}, retained);
            retained.set(manifest.manifestKey, manifest);
            result.set(effect.id, { manifest, requestFingerprint: source.requestFingerprint });
          } catch (error) {
            signal.throwIfAborted();
            result.set(effect.id, { reason: error instanceof Error ? error.message : "Audio analysis failed" });
          }
        }
        await store.assertOwnership(); signal.throwIfAborted(); return result;
      } finally { session.candidateJobs.delete(key); }
    });
    session.tail = job.done.then(() => {}, () => {});
    return job.done;
  }

  /** Read/validate only: Apply is never allowed to repair or prepare its frozen candidate. */
  async validateCandidateManifest(store: WorldStore, input: { production: ProductionBundle; timeline: ProductionTimeline; plan: RenderPlan;
    effect: EffectClip; manifestKey: string; requestFingerprint: string; sourceFingerprint: string;
    artifacts?: Parameters<typeof resolveEffectAudioSource>[0]["artifacts"] }, signal = store.closingSignal): Promise<EffectFeatureManifest> {
    signal.throwIfAborted();
    if (!this.host || !input.effect.audioInput) throw new Error("Audio reaction is unavailable");
    const source = resolveEffectAudioSource({ ...input, artifacts: input.artifacts ?? store.getBundle().artifacts, input: input.effect.audioInput });
    if (!source.ok || source.requestFingerprint !== input.requestFingerprint) throw new Error("Audio source changed; update the proposal");
    const manifest = await readEffectManifest(store, input.manifestKey);
    if (!manifest || manifest.sourceFingerprint !== input.sourceFingerprint ||
      effectAnalysisCanonicalJson(manifest.descriptor.binding) !== effectAnalysisCanonicalJson(input.effect.audioInput)) throw new Error("Prepared audio is unavailable; prepare a new proposal version");
    for (const file of manifest.descriptor.sources) {
      if (await hashMediaFile(await containedWorldFilePath(store.dir, file.path), signal) !== file.sha256) throw new Error("Audio source changed; update the proposal");
    }
    const inputs = await Promise.all(input.plan.audio.map(async (item, audioIndex) => {
      const file = manifest.descriptor.sources.find(source => source.path === item.path);
      if (!file) throw new Error("Audio routing changed; update the proposal");
      return { audioIndex, absolutePath: await containedWorldFilePath(store.dir, item.path), sourceHash: file.sha256, ...(item.clipId ? { clipId: item.clipId } : {}) };
    }));
    const native = await this.host.describe({ plan: input.plan, inputs, signal });
    if (effectAnalysisCanonicalJson(native) !== effectAnalysisCanonicalJson(manifest.descriptor.native)) throw new Error("Audio decoder changed; update the proposal");
    const descriptor = EffectAudioSourceDescriptorSchema.parse({ profileId: EFFECT_ANALYSIS_PROFILE.id, binding: input.effect.audioInput,
      frameRate: input.timeline.frameRate, startFrame: Math.round(input.plan.range.startSec * input.timeline.frameRate),
      endFrame: Math.round(input.plan.range.endSec * input.timeline.frameRate), selectedClipIds: source.selectedClipIds,
      placedWindows: source.placedWindows, audibleWindows: source.audibleWindows, contributions: input.plan.audio,
      sources: manifest.descriptor.sources, mix: input.plan.mix, speech: input.plan.speech, native });
    if (effectAnalysisHash(effectAudioSourceFingerprintMaterial(descriptor)) !== manifest.sourceFingerprint) throw new Error("Audio analysis dependencies changed; update the proposal");
    return manifest;
  }

  private async analyse(session: Session, context: Context, signal: AbortSignal, progress: (value: number) => void,
    candidateManifests: ReadonlyMap<string, EffectFeatureManifest> = new Map()): Promise<EffectFeatureManifest> {
    const { store } = session, { source, plan, timeline, effect } = context;
    if (!source.ok || !effect.audioInput) throw new Error("Choose a placed audio source");
    const startFrame = Math.round(plan.range.startSec * timeline.frameRate), endFrame = Math.round(plan.range.endSec * timeline.frameRate);
    if (source.sourcePaths.length > EFFECT_ANALYSIS_PROFILE.maxSources || endFrame - startFrame > EFFECT_ANALYSIS_PROFILE.maxFrames) throw new Error("Audio analysis exceeds its 128-source or 30-minute profile");
    const sources: Array<{ path: string; sha256: string }> = [];
    const paths = new Map<string, string>();
    for (const path of source.sourcePaths) {
      signal.throwIfAborted();
      const absolute = await containedWorldFilePath(store.dir, path).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MissingEffectAudioSource("Audio file is missing; restore it or choose another source");
        throw error;
      });
      sources.push({ path, sha256: await hashMediaFile(absolute, signal) }); paths.set(path, absolute);
    }
    const inputs: FrozenAudioInput[] = plan.audio.map((item, audioIndex) => ({ audioIndex, absolutePath: paths.get(item.path)!,
      sourceHash: sources.find(source => source.path === item.path)!.sha256, ...(item.clipId ? { clipId: item.clipId } : {}) }));
    const native = await this.host!.describe({ plan, inputs, signal });
    const descriptor = EffectAudioSourceDescriptorSchema.parse({ profileId: EFFECT_ANALYSIS_PROFILE.id, binding: effect.audioInput,
      frameRate: timeline.frameRate, startFrame, endFrame, selectedClipIds: source.selectedClipIds, placedWindows: source.placedWindows,
      audibleWindows: source.audibleWindows, contributions: plan.audio, sources, mix: plan.mix, speech: plan.speech, native });
    const sourceFingerprint = effectAnalysisHash(effectAudioSourceFingerprintMaterial(descriptor));
    let manifest = await cachedEffectManifest(store, sourceFingerprint);
    if (!manifest) {
      const analyzer = createEffectPcmAnalyzer({ frameRate: timeline.frameRate, startFrame, endFrame });
      let consumed = 0, lastProgress = 0;
      const pcm = await this.host!.renderAudiblePcm({ plan, inputs, descriptor: native, signal,
        selectedClipIds: effect.audioInput.kind === "composition-mix" ? null : source.selectedClipIds,
        onPcm: async samples => {
          signal.throwIfAborted(); analyzer.push(samples); consumed += samples.length / 2;
          if (Date.now() - lastProgress > 500) { progress(Math.min(0.99, consumed / (plan.totalSec * 48000))); lastProgress = Date.now(); }
          // Bounded chunks yield to cancellation, ownership notifications and the editor.
          await yieldToHost();
        } });
      const material = { schemaVersion: 1 as const, profileId: EFFECT_ANALYSIS_PROFILE.id, sourceFingerprint, descriptor, pcmHash: pcm.pcmHash, ...analyzer.finish() };
      manifest = EffectFeatureManifestSchema.parse({ ...material, manifestKey: effectAnalysisHash(effectManifestFingerprintMaterial(material)) });
    }
    signal.throwIfAborted();
    for (const source of sources) {
      const absolute = await containedWorldFilePath(store.dir, source.path);
      if (await hashMediaFile(absolute, signal) !== source.sha256) throw new Error("Audio source changed during preparation");
      session.stats.set(source.path, await this.fileStamp(absolute));
    }
    const retained = new Set([...session.rows.values()].flatMap(row => row.manifest ? [row.manifest.manifestKey, row.manifest.sourceFingerprint] : []));
    const retainedBytes = new Map([...session.rows.values()].flatMap(row => row.manifest ? [[row.manifest.manifestKey, Buffer.byteLength(JSON.stringify(row.manifest))] as const] : []));
    retainedBytes.set(manifest.manifestKey, Buffer.byteLength(JSON.stringify(manifest)));
    for (const value of candidateManifests.values()) { retained.add(value.manifestKey); retained.add(value.sourceFingerprint); retainedBytes.set(value.manifestKey, Buffer.byteLength(JSON.stringify(value))); }
    if ([...retainedBytes.values()].reduce((sum, size) => sum + size, 0) > EFFECT_ANALYSIS_PROFILE.maxFrozenManifestBytes) throw new Error("Prepared audio exceeds the 32 MiB feature budget");
    await saveEffectManifest(store, manifest, retained); return manifest;
  }

  private async fileStamp(path: string): Promise<string> { const info = await lstat(path); return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`; }

  private async checkSources(session: Session): Promise<void> {
    if (session.checking || session.store.isClosed() || this.stopped) return;
    session.checking = true;
    try {
      const changed = new Set<string>(), used = new Set([...session.rows.values()].flatMap(row => row.manifest?.descriptor.sources.map(source => source.path) ?? []));
      const writable = session.store.canWrite();
      if (writable !== session.lastWritable) {
        session.lastWritable = writable;
        if (!writable) for (const job of [...session.jobs.values(), ...session.candidateJobs.values()]) job.control.abort();
        for (const productionId of new Set([...session.rows.keys()].map(key => key.split("/")[0]!))) this.notify(session, productionId);
      }
      for (const [path, stamp] of session.stats) {
        if (!used.has(path)) { session.stats.delete(path); continue; }
        const current = await containedWorldFilePath(session.store.dir, path).then(file => this.fileStamp(file)).catch(() => "missing");
        if (current !== stamp) { changed.add(path); session.stats.delete(path); }
      }
      if (changed.size) for (const [key, row] of session.rows) {
        if (row.state.status !== "ready" || !row.manifest || !row.manifest.descriptor.sources.some(source => changed.has(source.path))) continue;
        row.state = { status: "source-changed", requestFingerprint: row.state.requestFingerprint, previousManifestKey: row.manifest.manifestKey, reason: "Audio file changed" };
        delete row.manifest; this.notify(session, key.split("/")[0]!);
      }
    } finally { session.checking = false; }
  }

  /** Export rehashes exact full-production inputs even when delivery selects a smaller window. */
  async readyForExport(store: WorldStore, productionId: string, delivery?: EffectRenderProjection, expectedRevision?: number | null): Promise<ReadonlyMap<string, EffectFeatureManifest>> {
    const currentRevision = () => { const value = store.getBundle().productions.find(p => p.meta.id === productionId)?.timeline; return value?.status === "ready" ? value.timeline.revision : null; };
    if (expectedRevision !== undefined && currentRevision() !== expectedRevision) throw new Error("Timeline changed before audio reaction could be frozen");
    const projection = this.project(store).find(row => row.productionId === productionId), result = new Map<string, EffectFeatureManifest>();
    if (!projection) return result;
    const session = this.sessions.get(store)!;
    const delivered = delivery && new Set(delivery.effectLayers.filter(({ effect }) => effect.startFrame < delivery.endFrame && effect.startFrame + effect.durationFrames > delivery.startFrame &&
      (effect.target.kind === "composition" || delivery.pictureLayers.some(picture => picture.kind === "media" &&
        (effect.target.kind === "picture-track" ? effect.target.trackId === picture.trackId : effect.target.kind === "visual-clip" && effect.target.clipId === picture.clipId) &&
        Math.max(delivery.startFrame, picture.startFrame, effect.startFrame) < Math.min(delivery.endFrame, picture.endFrame, effect.startFrame + effect.durationFrames))))
      .map(({ effect }) => effect.id));
    for (const [effectId, state] of Object.entries(projection.byEffectId)) {
      if (delivered && !delivered.has(effectId)) continue;
      if (state.status === "off") continue;
      const manifest = session.rows.get(keyOf(productionId, effectId))?.manifest;
      if (state.status !== "ready" || !manifest) throw new Error(`Audio reaction for ${effectId} is not ready. Prepare it or turn reaction Off.`);
      for (const source of manifest.descriptor.sources) if (await hashMediaFile(await containedWorldFilePath(store.dir, source.path), store.closingSignal) !== source.sha256) throw new Error("Audio source changed; prepare reaction before export");
      result.set(effectId, manifest);
    }
    if (result.size && this.host) {
      const context = this.contexts(store).get(keyOf(productionId, result.keys().next().value!));
      if (!context || typeof context === "string") throw new Error("Audio reaction source changed before export");
      const first = result.values().next().value!;
      const inputs = await Promise.all(context.plan.audio.map(async (item, audioIndex) => ({ audioIndex,
        absolutePath: await containedWorldFilePath(store.dir, item.path), sourceHash: first.descriptor.sources.find(source => source.path === item.path)!.sha256,
        ...(item.clipId ? { clipId: item.clipId } : {}) })));
      const current = await this.host.describe({ plan: context.plan, inputs, signal: store.closingSignal });
      for (const manifest of result.values()) if (effectAnalysisCanonicalJson(current) !== effectAnalysisCanonicalJson(manifest.descriptor.native)) throw new Error("Audio decoder changed; prepare reaction again before export");
    }
    await store.assertOwnership();
    if (expectedRevision !== undefined && currentRevision() !== expectedRevision) throw new Error("Timeline changed while audio reaction was being frozen");
    return result;
  }

  async serve(store: WorldStore | null | undefined, slug: string, relative: string): Promise<{ path: string; contentType: string } | null> {
    const match = /^\.cache\/editor-effects\/analysis\/([a-f0-9]{64})\.json$/.exec(relative);
    if (!match || !store || store.isClosed() || store.getBundle().meta.slug !== slug) return null;
    if (!await readEffectManifest(store, match[1]!)) return null;
    return { path: await containedWorldFilePath(store.dir, `${EFFECT_ANALYSIS_CACHE}/${match[1]}.json`), contentType: "application/json" };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const sessions = [...this.sessions.values()];
    for (const session of sessions) { session.dispose(); session.store.closingSignal.removeEventListener("abort", session.dispose); }
    await Promise.all(sessions.map(session => session.tail.catch(() => {})));
  }
}

class MissingEffectAudioSource extends Error {}
