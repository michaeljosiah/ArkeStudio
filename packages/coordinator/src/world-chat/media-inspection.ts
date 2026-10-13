import { AGENT_MEDIA_LIMITS, AGENT_MEDIA_PROFILE, AGENT_MEDIA_SCHEMA_VERSION, AgentMediaObservationSchema, AnalyzeAudioArgsSchema,
  InspectMediaArgsSchema, SampleVideoArgsSchema, newId, type AgentMediaObservation, type AgentMediaSource, type WorldChatCheckReceipt } from "@arke-studio/contracts";
import { readBenchSession } from "../bench/chat-reads.js";
import { resolveTakeSource } from "../bench/service.js";
import { hashContainedProductionMedia, withContainedProductionMedia } from "../world/reference-files.js";
import type { AgentMediaTools } from "../media/agent-media-tools.js";
import type { WorldStore } from "../world/store.js";
import { ConversationImages } from "./images.js";
import { RetrievalError, type RetrievalOutcome } from "./retrieval.js";
import { LeaseDeniedError, type QueryLease, type QueryLeaseRegistry } from "./lease.js";
import { conversationDir, WorldChatStore } from "./store.js";

export const MEDIA_INSPECTION_NAMES = ["inspect_media", "sample_video", "analyze_audio_signal"] as const;
export type MediaInspectionName = typeof MEDIA_INSPECTION_NAMES[number];
const TOOLS = { inspect_media: "inspect-media", sample_video: "sample-video", analyze_audio_signal: "analyze-audio-signal" } as const;
export type InspectionSource = { id: string; path: string; expectedHash: string; startSec: number; endSec: number | null };
/** Catalogue identities are the authority. There is no path-shaped or mutable-selection input. */
export async function agentMediaSource(store: WorldStore, source: AgentMediaSource): Promise<InspectionSource> {
  const bundle = store.getBundle();
  if (source.kind === "artifact") {
    const artifact = bundle.artifacts.find(row => row.id === source.id && ["image", "board", "video", "audio"].includes(row.kind));
    if (!artifact?.hash || /[\\/:]/.test(artifact.file) || artifact.file.includes("\0") || [".", ".."].includes(artifact.file)) throw new RetrievalError("unavailable", "That artifact has no valid original media identity.");
    return { id: `artifact:${artifact.id}`, path: `artifacts/${artifact.file}`, expectedHash: artifact.hash, startSec: 0, endSec: null };
  }
  if (source.kind === "bench-take") {
    const session = await readBenchSession(store.dir, source.sessionId), resolved = session ? resolveTakeSource(session, source.takeId) : null;
    if (!resolved || "refused" in resolved) throw new RetrievalError("unavailable", "That immutable Bench take is unavailable.");
    return { id: `bench:${source.sessionId}:${source.takeId}`, path: resolved.path, expectedHash: resolved.source.hash, startSec: 0, endSec: null };
  }
  const production = bundle.productions.find(row => row.meta.id === source.productionId), take = production?.takes.find(row => row.id === source.takeId);
  const original = take?.media ? take : take?.segment ? production?.takes.find(row => row.id === take.segment!.passTakeId) : undefined;
  if (!take || !original?.media || /[\\/:]/.test(original.media) || original.media.includes("\0") || [".", ".."].includes(original.media)) throw new RetrievalError("unavailable", "That production take's media is unavailable.");
  const expectedHash = take.panel?.hash ?? original.mediaHash;
  if (!expectedHash) throw new RetrievalError("unavailable", "This legacy take has no original media hash; use metadata records instead.");
  const segment = !take.media ? take.segment : undefined;
  if (segment && (take.kind !== "clip" || original.kind !== "clip" || segment.inSec < 0 || segment.outSec <= segment.inSec)) throw new RetrievalError("unavailable", "That take segment is invalid.");
  return { id: `production:${source.productionId}:${take.id}`, path: `productions/${source.productionId}/takes/${original.id}/${original.media}`,
    expectedHash, startSec: segment?.inSec ?? 0, endSec: segment?.outSec ?? null };
}
const identity = (value: InspectionSource) => JSON.stringify(value);

export class ConversationMediaInspection {
  private readonly signals = new Map<string, AbortSignal>();
  private readonly counts = new Map<string, number>();
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly store: WorldStore, private readonly leases: QueryLeaseRegistry,
    private readonly deps: { tools?: AgentMediaTools; images: ConversationImages; publish?: (id: QueryLease["conversationId"]) => Promise<void> }) {}
  start(runId: string, signal: AbortSignal) { this.signals.set(runId, AbortSignal.any([signal, this.store.closingSignal])); }
  release(runId: string) { this.signals.delete(runId); this.counts.delete(runId); }
  private access(lease: QueryLease, name: MediaInspectionName) {
    this.leases.verify(lease.token, name);
    const signal = this.signals.get(lease.runId);
    if (!signal || signal.aborted) throw new RetrievalError("unavailable", "This media inspection run is no longer active.");
    signal.throwIfAborted(); return signal;
  }
  read(lease: QueryLease, name: MediaInspectionName, input: Record<string, unknown>): Promise<RetrievalOutcome> {
    const result = this.tail.then(() => this.readOnce(lease, name, input)).catch(error => {
      if (error instanceof RetrievalError || error instanceof LeaseDeniedError) throw error;
      throw new RetrievalError("unavailable", "The verified media source could not be decoded within this host's bounded profile, or inspection was stopped.");
    });
    this.tail = result.then(() => {}, () => {}); return result;
  }
  private async readOnce(lease: QueryLease, name: MediaInspectionName, input: Record<string, unknown>): Promise<RetrievalOutcome> {
    const signal = this.access(lease, name), tools = this.deps.tools;
    if (!tools) throw new RetrievalError("unavailable", "Local media inspection tools are unavailable on this host.");
    const parsed = (name === "inspect_media" ? InspectMediaArgsSchema : name === "sample_video" ? SampleVideoArgsSchema : AnalyzeAudioArgsSchema).safeParse(input);
    if (!parsed.success) throw new RetrievalError("bad-argument", `${name}: name an immutable source and a bounded, valid interval.`);
    const count = this.counts.get(lease.runId) ?? 0;
    if (count >= AGENT_MEDIA_LIMITS.calls) throw new RetrievalError("budget-exhausted", "This run has reached its media inspection call budget.");
    this.counts.set(lease.runId, count + 1);
    const args = parsed.data as { source: AgentMediaSource; range?: { startSec: number; endSec: number }; streamIndex?: number; count?: number };
    const source = await agentMediaSource(this.store, args.source);
    if (name === "sample_video") await this.deps.images.validate(lease);
    const decoderVersion = await tools.version(signal);
    const probeVersion = await tools.probeVersion(signal);
    const prepared = await withContainedProductionMedia(this.store.dir, source.path, source.expectedHash, signal, async snapshot => {
      const inventory = await tools.probe(snapshot.path, signal);
      const end = source.endSec ?? inventory.durationSec;
      if (source.endSec !== null && (inventory.durationSec === null || source.endSec > inventory.durationSec + 0.000001)) throw new RetrievalError("unavailable", "The source no longer covers this take segment.");
      const base = { profile: AGENT_MEDIA_PROFILE, decoderVersion, probeVersion, source: args.source, sourceHash: snapshot.sourceHash, byteLength: snapshot.byteLength,
        sourceStartSec: source.startSec, sourceEndSec: end, inventory };
      if (name === "inspect_media") return { observation: AgentMediaObservationSchema.parse({ ...base, coverage: "metadata-only",
        limitations: ["Stream metadata only; no pixels, motion, audio performance or transcript was reviewed."] }), frames: [] };
      if (!args.range || end === null || args.range.endSec > end - source.startSec + 0.000001) throw new RetrievalError("bad-argument", "The interval exceeds this immutable media source.");
      const kind = name === "sample_video" ? "video" : "audio", candidates = inventory.streams.filter(stream => stream.kind === kind);
      const selected = args.streamIndex === undefined ? candidates.length === 1 ? candidates[0] : undefined : candidates.find(stream => stream.index === args.streamIndex);
      if (!selected) throw new RetrievalError("bad-argument", `Select one explicit ${kind} stream from inspect_media; ambiguous tracks are never guessed.`);
      const startSec = source.startSec + args.range.startSec, endSec = source.startSec + args.range.endSec;
      if (name === "analyze_audio_signal") {
        const audio = await tools.audio(snapshot.path, selected, startSec, endSec, signal);
        return { observation: AgentMediaObservationSchema.parse({ ...base, range: args.range, audio, coverage: "decoded-audio-samples",
          limitations: ["Original-channel decoded sample measurements only; no listening or performance judgment.",
            "Full-scale flags are sample-level signals, not proof of all clipping. True peak, LUFS and loudness range were not measured.",
            "Decoded sample duration is measured; discontinuous packet timestamps were not audited.",
            "No speech recognition, semantic sound identification or audiovisual sync was performed."] }), frames: [] };
      }
      if (!selected.width || !selected.height || Math.max(selected.width, selected.height) > 3840 || selected.width * selected.height > 3840 * 2160) throw new RetrievalError("unavailable", "Video dimensions exceed the bounded decode profile.");
      const samples = args.count ?? 3, frames = [];
      for (let i = 0; i < samples; i++) {
        this.access(lease, name);
        const requestedSourceTimeSec = startSec + (endSec - startSec) * i / samples;
        const frame = await tools.frame(snapshot.path, selected.index, requestedSourceTimeSec, endSec, signal);
        frames.push({ ...frame, requestedSourceTimeSec, streamIndex: selected.index });
      }
      return { observation: base, range: args.range, frames };
    });
    this.access(lease, name);
    if (identity(await agentMediaSource(this.store, args.source)) !== identity(source)) throw new RetrievalError("unavailable", "Media identity changed while inspection was running.");
    await hashContainedProductionMedia(this.store.dir, source.path, source.expectedHash, signal);
    const pixels: Array<{ frame: { requestedSourceTimeSec: number; sourceTimeSec: number; streamIndex: number }; image: Awaited<ReturnType<ConversationImages["prepareFrame"]>>["image"]; content: NonNullable<RetrievalOutcome["imageContent"]>[number] }> = [];
    for (const frame of prepared.frames) {
      const value = await this.deps.images.prepareFrame(lease, { id: `${source.id}:frame:${frame.streamIndex}:${frame.sourceTimeSec}`,
        label: `Frame at source ${frame.sourceTimeSec}s for ${source.id}`, sourceHash: prepared.observation.sourceHash, bytes: frame.bytes });
      pixels.push({ frame, ...value });
    }
    const observation: AgentMediaObservation = prepared.frames.length ? AgentMediaObservationSchema.parse({ ...prepared.observation,
      range: "range" in prepared ? prepared.range : undefined, coverage: "sampled-frames-only",
      frames: pixels.map(value => ({ requestedSourceTimeSec: value.frame.requestedSourceTimeSec, sourceTimeSec: value.frame.sourceTimeSec,
        viewTimeSec: value.frame.sourceTimeSec - source.startSec, streamIndex: value.frame.streamIndex, image: value.image })),
      limitations: ["Only these decoded, timestamped still frames were inspected; intervals between samples remain unreviewed.",
        "No continuous motion, flicker, audio performance or audiovisual sync assessment was made."] }) : prepared.observation as AgentMediaObservation;
    const receipt: WorldChatCheckReceipt = { id: newId("check"), runId: lease.runId, tool: TOOLS[name], status: "complete", consulted: [],
      media: observation, querySummary: `${name === "inspect_media" ? "Media metadata" : name === "sample_video" ? "Sampled video frames" : "Audio sample measurements"}: ${source.id}`.slice(0, 300), at: new Date().toISOString() };
    this.access(lease, name);
    await this.store.raiseSchemaBoundary(AGENT_MEDIA_SCHEMA_VERSION, "agent-media-evidence");
    await this.store.ownedWrite(async () => {
      this.access(lease, name);
      if (identity(await agentMediaSource(this.store, args.source)) !== identity(source)) throw new RetrievalError("unavailable", "Media identity changed before the receipt was recorded.");
      await hashContainedProductionMedia(this.store.dir, source.path, source.expectedHash, signal);
      const chat = new WorldChatStore(conversationDir(this.store.dir, lease.conversationId));
      const disclosure = pixels.length ? await this.deps.images.frameDisclosure(lease, pixels.map(value => value.image), receipt.at) : null;
      this.access(lease, name);
      if (disclosure) await chat.append({ type: "image.disclosed", disclosure });
      await chat.append({ type: "media.receipt", receipt });
    });
    await this.deps.publish?.(lease.conversationId); this.access(lease, name);
    if (pixels.length) await this.deps.images.validate(lease);
    return { result: observation, receipt, ...(pixels.length ? { imageContent: pixels.map(value => value.content) } : {}) };
  }
}
