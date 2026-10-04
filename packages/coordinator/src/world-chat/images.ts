import { createHash } from "node:crypto";
import { extname } from "node:path";
import { z } from "zod";
import { CHAT_IMAGES_SCHEMA_VERSION, ChatAttachmentIdSchema, SessionIdSchema, TakeIdSchema, newId,
  type HarnessAdapter, type ImageObservation, type WorldChatCheckReceipt } from "@arke-studio/contracts";
import { readBenchSession } from "../bench/chat-reads.js";
import { resolveTakeSource } from "../bench/service.js";
import { readContainedMediaBytes, withContainedProductionMedia } from "../world/reference-files.js";
import type { WorldStore } from "../world/store.js";
import { imageRendition, IMAGE_RUN_ENCODED_BYTES, type ImageRenditionMaker } from "./image-rendition.js";
import { WorldChatService } from "./service.js";
import { WorldChatStore, conversationDir } from "./store.js";
import type { QueryLease, QueryLeaseRegistry } from "./lease.js";
import { RetrievalError, type RetrievalOutcome } from "./retrieval.js";
import { ProductionTakeImageArgsSchema, productionTakeImageSource } from "./production-take-images.js";

export const ViewImageArgsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("attachment"), id: ChatAttachmentIdSchema }).strict(),
  z.object({ kind: z.literal("artifact"), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("reference"), file: z.string().min(1).max(500) }).strict(),
  z.object({ kind: z.literal("bench-take"), sessionId: SessionIdSchema, takeId: TakeIdSchema }).strict(),
  ProductionTakeImageArgsSchema,
]);
const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const imageFiles = (value: unknown): string[] => {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    ["file", "anchor", "anchorFile", "mainFile", "closeFile", "designatedCompilation", "masterLook"].includes(key) && typeof child === "string" ? [child] :
      typeof child === "object" ? imageFiles(child) : []);
};

/** One run's actual image destination. Unknown capabilities never become affirmative. */
export class ConversationImages {
  private readonly sessions = new Map<string, { supported: boolean; provider: string; local: boolean; signal?: AbortSignal }>();
  private readonly counts = new Map<string, number>();
  private readonly bytesByRun = new Map<string, number>();
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly store: WorldStore, private readonly leases: QueryLeaseRegistry, private readonly deps: {
    adapter: HarnessAdapter | null; maker?: ImageRenditionMaker;
    allowed(provider: string): Promise<boolean>;
    publish(conversationId: QueryLease["conversationId"]): Promise<void>;
  }) {}
  start(runId: string, sessionId: string, signal?: AbortSignal): void {
    const adapter = this.deps.adapter;
    const destination = adapter?.imageDestinationForSession?.(sessionId);
    this.sessions.set(runId, { supported: adapter?.imageInput === true && adapter.imageInputForSession?.(sessionId) === true,
      provider: destination?.provider ?? adapter?.id ?? "unknown", local: destination?.local === true, ...(signal ? { signal } : {}) });
  }
  release(runId: string): void { this.sessions.delete(runId); this.counts.delete(runId); this.bytesByRun.delete(runId); }
  async validate(lease: QueryLease): Promise<void> { await this.access(lease); }
  private async access(lease: QueryLease) {
    this.leases.verify(lease.token, "view_image");
    const session = this.sessions.get(lease.runId);
    session?.signal?.throwIfAborted();
    if (!session?.supported) throw new RetrievalError("unavailable", "view_image: this adapter or selected model cannot inspect images. The image is unreadable; do not guess its contents.");
    if (!session.local && (this.store.getBundle().meta.cloudImageInspection === false || !await this.deps.allowed(session.provider))) {
      throw new RetrievalError("unavailable", `view_image: cloud image inspection is forbidden for ${session.provider} or this world.`);
    }
    this.leases.verify(lease.token, "view_image");
    return session;
  }
  private async source(lease: QueryLease, raw: Record<string, unknown>, signal?: AbortSignal) {
    const args = ViewImageArgsSchema.parse(raw), bundle = this.store.getBundle();
    let path: string, id: string, label: string, expected: string | undefined, video = false, atSec = 0;
    if (args.kind === "attachment") {
      this.leases.assertAttachmentAllowed(lease, args.id);
      const attachment = (await new WorldChatService(this.store.dir).load(lease.conversationId))?.attachments.find(a => a.id === args.id);
      if (!attachment || !["image", "video"].includes(attachment.kind)) throw new RetrievalError("unavailable", "view_image: that image attachment is unavailable.");
      path = `.conversations/${lease.conversationId}/attachments/${attachment.id}/${attachment.fileName}`;
      id = attachment.id; label = attachment.fileName; expected = attachment.contentHash; video = attachment.kind === "video";
    } else if (args.kind === "artifact") {
      const artifact = bundle.artifacts.find(a => a.id === args.id);
      if (!artifact || !["image", "board", "video"].includes(artifact.kind)) throw new RetrievalError("unavailable", "view_image: that image artifact is unavailable.");
      path = `artifacts/${artifact.file}`; id = artifact.id; label = artifact.file; expected = artifact.hash; video = artifact.kind === "video";
    } else if (args.kind === "bench-take") {
      const session = readBenchSession(this.store.dir, args.sessionId);
      const resolved = session ? resolveTakeSource(session, args.takeId) : null;
      if (!resolved || "refused" in resolved || resolved.kind === "audio") throw new RetrievalError("unavailable", "view_image: that Bench image take is unavailable.");
      path = resolved.path; id = `${args.sessionId}:${args.takeId}`; label = `Bench take ${args.takeId}`;
      expected = resolved.source.hash; video = resolved.kind === "video";
    } else if (args.kind === "production-take") {
      ({ path, id, label, expected, video, atSec } = productionTakeImageSource(bundle, args));
    } else {
      const files = [bundle.keyArt, ...bundle.keyArtCandidates, ...bundle.masterLookCandidates,
        ...Object.values(bundle.referenceCandidates).flat(), ...Object.values(bundle.stagedReferences),
        ...bundle.referenceKits.flatMap(kit => imageFiles(kit).map(file => `references/${kit.sheetId}/${file}`)),
        ...bundle.props.flatMap(prop => imageFiles(prop).map(file => `references/${prop.id}/${file}`)),
        ...bundle.referenceTakes.flatMap(take => {
          const owner = take.reference?.sheetId ?? take.prop?.propId;
          return owner ? [`references/${owner}/takes/${take.id}/${take.media}`] : [];
        }),
        ...imageFiles(bundle.artDirection)];
      if (!files.includes(args.file)) throw new RetrievalError("unavailable", "view_image: that reference or candidate is unavailable. Use a file returned by list_references or get_art_direction.");
      path = args.file; id = `reference:${path}`; label = path;
    }
    if (args.kind === "production-take" && video && this.deps.maker?.renderFile && expected) {
      try {
        return await withContainedProductionMedia(this.store.dir, path, expected, signal, async snapshot => ({
          path, id, label, video, sourceHash: snapshot.sourceHash, byteLength: snapshot.byteLength,
          bytes: await this.deps.maker!.renderFile!(snapshot.path, signal, atSec), atSec: 0, preparedPoster: true,
        }));
      } catch { throw new RetrievalError("unavailable", "view_image: this production poster is unavailable or its original media changed."); }
    }
    let bytes: Uint8Array;
    try { bytes = await readContainedMediaBytes(this.store.dir, path, signal); }
    catch (error) {
      if (args.kind === "production-take") throw new RetrievalError("unavailable", "view_image: that production image source is missing, changed or outside its allowed folder.");
      throw error;
    }
    const sourceHash = hash(bytes);
    if (expected && !sourceHash.startsWith(expected)) throw new RetrievalError("unavailable", "view_image: these image bytes changed. Refresh the source before inspecting it.");
    return { path, id, label, video, sourceHash, bytes, byteLength: bytes.length, atSec, preparedPoster: false };
  }
  read(lease: QueryLease, args: Record<string, unknown>): Promise<RetrievalOutcome> {
    const result = this.tail.then(() => this.readOnce(lease, args));
    this.tail = result.then(() => {}, () => {});
    return result;
  }
  private async readOnce(lease: QueryLease, args: Record<string, unknown>): Promise<RetrievalOutcome> {
    const session = await this.access(lease);
    const count = this.counts.get(lease.runId) ?? 0;
    if (count >= 24) throw new RetrievalError("unavailable", "view_image: this run has reached its 24-image inspection limit.");
    this.counts.set(lease.runId, count + 1);
    const source = await this.source(lease, args, session.signal);
    let rendition;
    try { rendition = await imageRendition(source.bytes, source.preparedPoster ? ".png" : extname(source.path), source.preparedPoster ? undefined : this.deps.maker, session.signal, source.atSec); }
    catch { throw new RetrievalError("unavailable", "view_image: a bounded image rendition is unavailable. Configure the local media decoder or use a supported PNG."); }
    await this.access(lease);
    const total = (this.bytesByRun.get(lease.runId) ?? 0) + 4 * Math.ceil(rendition.data.length / 3);
    if (total > IMAGE_RUN_ENCODED_BYTES) throw new RetrievalError("unavailable", "view_image: this run has reached its 20 MB encoded image budget.");
    this.bytesByRun.set(lease.runId, total);
    const observation: ImageObservation = { id: source.id, label: source.label.slice(0, 500), sourceHash: source.sourceHash,
      renditionHash: hash(rendition.data), width: rendition.width, height: rendition.height, posterOnly: source.video };
    const receipt: WorldChatCheckReceipt = { id: newId("check"), runId: lease.runId, tool: "view-image", status: "complete", consulted: [],
      image: observation, querySummary: `${source.video ? "Poster frame only: " : "Image: "}${observation.label}`.slice(0, 300), at: new Date().toISOString() };
    await this.store.raiseSchemaBoundary(CHAT_IMAGES_SCHEMA_VERSION, "conversation-images");
    await this.store.ownedWrite(async () => {
      await this.access(lease);
      const chat = new WorldChatStore(conversationDir(this.store.dir, lease.conversationId));
      if (!session.local) {
        const view = await new WorldChatService(this.store.dir).load(lease.conversationId);
        const previous = view?.imageDisclosures?.find(d => d.provider === session.provider);
        const images = [...(previous?.images ?? []).filter(image => image.id !== observation.id), observation];
        if (images.length > 256) throw new RetrievalError("unavailable", "view_image: this conversation has reached its image disclosure limit.");
        await chat.append({ type: "image.disclosed", disclosure: { provider: session.provider, images, at: previous?.at ?? receipt.at } });
      }
      // Durable handoff receipt before delivery; it proves prepared pixels, not model comprehension.
      await chat.append({ type: "image.receipt", receipt });
    });
    await this.deps.publish(lease.conversationId);
    await this.access(lease);
    return { result: { image: observation, ...(source.video ? { understanding: "Poster frame only; video motion and audio were not inspected.",
      media: { kind: "video", byteLength: source.byteLength, format: extname(source.path) } } : {}) }, receipt,
      imageContent: [{ type: "image", mimeType: "image/png", data: Buffer.from(rendition.data).toString("base64") }] };
  }
}
