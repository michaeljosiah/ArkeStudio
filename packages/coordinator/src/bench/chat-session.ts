import { conversationActionDigest } from "../arke-actions/digest.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { BenchEventSchema, BenchReservedTakeSchema, BenchSubjectSchema, PRODUCTION_AUDIO_CHAT_SCHEMA_VERSION, SessionIdSchema, ConversationIdSchema,
  benchTokenFor, characterSheetFor, mainPhotoFor, foldBenchSession, sameBenchSubjectIdentity,
  type BenchChatReference, type BenchEvent, type BenchReferenceToken, type BenchSession,
  type BenchTake, type BenchReservedTake, type BenchSubject, type WorldChatBenchGenerationAction } from "@arke-studio/contracts";
import { readBenchRecord, readBenchSession } from "./chat-reads.js";
import { BenchStore, sessionDir } from "./store.js";
import { resolveArtifactSource, resolveTakeSource, resolveTokenEntry } from "./service.js";
import { WorldChatStore, conversationDir } from "../world-chat/store.js";
import { foldConversation } from "../world-chat/fold.js";
import { readContainedAudioReferences, readContainedImageReferences, readContainedVideoReferences } from "../world/reference-files.js";
import type { WorldStore } from "../world/store.js";
import type { GenerationQuoteScope } from "../world-chat/generation-quotes.js";

type Action = WorldChatBenchGenerationAction["action"];
export const benchChatSessionId = (action: Action, id: string) => SessionIdSchema.parse(action.sessionId ?? `sess_${id.slice(4)}`);
/** Reify legacy omitted lanes into the prepared action, after its exact session read is fenced. */
export function completeBenchChatAction(worldDir: string, action: Action): Action {
  if (action.rerunTakeId || action.composer.references !== undefined) return action;
  const session = action.sessionId ? readBenchSession(worldDir, action.sessionId) : null;
  if (action.sessionId && !session) throw new Error("That Bench session is unavailable.");
  const references: BenchChatReference[] = ["voice", "music"].includes(action.composer.mode) ? [] : [
    ...(session?.composer.activeTokens ?? []).map(token => ({ kind: "session-token" as const, token, role: "reference" as const })),
    ...(action.composer.mode === "video" ? (session?.composer.keyframeTokens ?? []).map((token, index) => ({
      kind: "session-token" as const, token, role: index === 0 ? "start-frame" as const : "end-frame" as const,
    })) : []),
  ];
  return { ...action, composer: { ...action.composer, references } };
}
interface BenchChatMaterialization {
  reserved: BenchReservedTake[];
  initialization: { sessionId: string; createdAt: string; fresh: boolean; events: BenchEvent[]; subject?: BenchSubject };
}
export const BenchChatMaterializationSchema: z.ZodType<BenchChatMaterialization, z.ZodTypeDef, unknown> = z.object({ reserved: z.array(BenchReservedTakeSchema), initialization: z.object({
  sessionId: SessionIdSchema, createdAt: z.string(), fresh: z.boolean(), events: z.array(BenchEventSchema), subject: BenchSubjectSchema.optional(),
}).strict() }).strict();
const initializationPrefix = (id: string) => `chat-composer:${id}:`;

async function pin(store: WorldStore, entry: BenchReferenceToken, session: BenchSession) {
  const resolved = resolveTokenEntry(entry, session, store.getBundle());
  if ("refused" in resolved) throw new Error(resolved.refused);
  const files = entry.kind === "image" ? await readContainedImageReferences(store.dir, [resolved.path])
    : entry.kind === "video" ? await readContainedVideoReferences(store.dir, [resolved.path])
      : await readContainedAudioReferences(store.dir, [resolved.path]);
  const hash = `sha256:${createHash("sha256").update(files[0]!.data).digest("hex")}`;
  if (hash.slice(0, entry.source.hash.length) !== entry.source.hash) throw new Error("A Bench reference changed. Prepare a fresh card.");
}
async function reference(store: WorldStore, ref: BenchChatReference, session: BenchSession, scope?: GenerationQuoteScope): Promise<BenchReferenceToken> {
  const bundle = store.getBundle();
  if (ref.kind === "session-token") {
    const entry = session.tokenRegistry.find(entry => entry.token === ref.token);
    if (!entry) throw new Error("That reference token is unavailable in this Bench session.");
    await pin(store, entry, session);
    return entry;
  }
  let entry: Omit<BenchReferenceToken, "token">;
  if (ref.kind === "artifact") {
    const artifact = bundle.artifacts.find(artifact => artifact.id === ref.artifactId);
    if (!artifact) throw new Error("That artifact is unavailable.");
    const resolved = resolveArtifactSource(artifact);
    if ("refused" in resolved) throw new Error(resolved.refused);
    entry = { source: resolved.source, kind: resolved.kind, label: artifact.file,
      ...(resolved.durationSec && resolved.kind !== "image" ? { durationSec: resolved.durationSec } : {}) };
  } else if (ref.kind === "take") {
    const owner = ref.sessionId === session.id ? session : readBenchSession(store.dir, ref.sessionId);
    if (!owner) throw new Error("That source Bench session is unavailable.");
    const resolved = resolveTakeSource(owner, ref.takeId);
    if ("refused" in resolved) throw new Error(resolved.refused);
    entry = { source: ref.sessionId === session.id ? resolved.source : { source: "world-file", path: resolved.path, hash: resolved.source.hash },
      kind: resolved.kind, label: `Take ${owner.takes.find(take => take.id === ref.takeId)!.n}`,
      ...(resolved.durationSec && resolved.kind !== "image" ? { durationSec: resolved.durationSec } : {}) };
  } else {
    let path: string;
    let label: string;
    if (ref.kind === "kit") {
      const kit = bundle.referenceKits.find(kit => kit.sheetId === ref.sheetId);
      if (!kit) throw new Error("That reference kit is unavailable.");
      const picture = ref.image === "main-photo" ? mainPhotoFor(kit) : ref.image === "character-sheet" ? characterSheetFor(kit)
        : kit.locationViews?.find(view => view.id === kit.establishingViewId);
      if (!picture) throw new Error("That accepted kit picture is unavailable.");
      path = `references/${ref.sheetId}/${picture.file}`;
      label = `${ref.sheetId} · ${ref.image}`;
    } else {
      if (!scope) throw new Error("The attachment's owning conversation is unavailable.");
      const conversationId = ConversationIdSchema.parse(scope.conversationId);
      const log = new WorldChatStore(conversationDir(store.dir, conversationId));
      const meta = await log.readMeta();
      if (!meta) throw new Error("The conversation is unavailable.");
      const read = await log.read();
      if (read.problems.length) throw new Error("The conversation needs recovery before using its attachments.");
      const attachment = foldConversation(conversationId, meta.createdAt, read.events).view.attachments.find(a => a.id === ref.attachmentId);
      if (!attachment || attachment.kind !== "image") throw new Error("That image attachment is unavailable in this conversation.");
      path = `.conversations/${conversationId}/attachments/${attachment.id}/${attachment.fileName}`;
      label = attachment.fileName;
    }
    const [image] = await readContainedImageReferences(store.dir, [path]);
    entry = { source: { source: "world-file", path, hash: `sha256:${createHash("sha256").update(image!.data).digest("hex")}` }, kind: "image", label };
  }
  const existing = session.tokenRegistry.find(token => JSON.stringify(token.source) === JSON.stringify(entry.source));
  const token = existing?.token ?? benchTokenFor(entry.kind, session.nextToken[entry.kind] ?? 1);
  const complete = { ...entry, token };
  await pin(store, complete, session);
  return complete;
}

/** Compile a virtual session. Only approval materializes these exact, idempotent journal events. */
export async function prepareBenchChatSession(store: WorldStore, action: Action, id: string, at: string, scope?: GenerationQuoteScope) {
  const sessionId = benchChatSessionId(action, id);
  const record = readBenchRecord(store.dir, sessionId);
  const production = action.productionId ? store.getBundle().productions.find(p => p.meta.id === action.productionId) : undefined;
  if (action.productionId && (!production || action.composer.mode !== "music")) throw new Error("A production audio Bench requires a current production and music mode.");
  const subject: BenchSubject | undefined = production ? { kind: "production", productionId: production.meta.id, productionTitle: production.meta.title, role: action.cueRole ?? "music" } : undefined;
  if (subject && record && (!record.meta.subject || !sameBenchSubjectIdentity(record.meta.subject, subject))) throw new Error("This Bench belongs to another production or audio role.");
  if (action.sessionId && !record) throw new Error("That Bench session is no longer available.");
  const sameSubject = record?.meta.subject && subject ? sameBenchSubjectIdentity(record.meta.subject, subject) : record?.meta.subject === subject;
  if (!action.sessionId && record && (record.meta.createdAt !== at || !sameSubject || record.events.some(e => !e.requestId?.startsWith(initializationPrefix(id))))) {
    throw new Error("The proposed Bench identity is already in use.");
  }
  const meta = record?.meta ?? { schemaVersion: 1 as const, id: sessionId, createdAt: at, ...(subject ? { subject } : {}) };
  const baseline = record?.events.filter(event => !event.requestId?.startsWith(initializationPrefix(id))) ?? [];
  const session = foldBenchSession(meta, baseline);
  const events: BenchEvent[] = [];
  let fromTake: BenchTake | undefined;
  if (action.rerunTakeId) {
    fromTake = session.takes.find(take => take.id === action.rerunTakeId);
    if (!action.sessionId || !fromTake) throw new Error("A rerun must name a take read from its existing Bench session.");
    const { references: _references, ...composer } = action.composer;
    const frozen = { mode: fromTake.request.mode, provider: fromTake.request.provider, model: fromTake.request.model,
      params: fromTake.request.params, brief: fromTake.request.brief };
    if (conversationActionDigest(composer) !== conversationActionDigest(frozen) || action.composer.references !== undefined) throw new Error("A rerun must repeat the take's exact composer; changes require a new generation request.");
    for (const entry of [...fromTake.request.references, ...fromTake.request.keyframes]) await pin(store, entry, session);
  }
  if (action.composer.references !== undefined) {
    if (fromTake) throw new Error("A rerun reuses its immutable references.");
    session.composer.activeTokens = [];
    session.composer.keyframeTokens = [];
    const frames = action.composer.references.filter(ref => ref.role !== "reference");
    if (frames.some(ref => ref.role === "end-frame") && !frames.some(ref => ref.role === "start-frame")) throw new Error("An end frame requires a start frame.");
    if (frames.filter(ref => ref.role === "start-frame").length > 1 || frames.filter(ref => ref.role === "end-frame").length > 1) throw new Error("Only one start and one end frame can be sent.");
    for (const ref of [...action.composer.references].sort((a, b) => (a.role === "end-frame" ? 1 : 0) - (b.role === "end-frame" ? 1 : 0))) {
      const entry = await reference(store, ref, session, scope);
      if (ref.role !== "reference" && action.composer.mode !== "video") throw new Error("Only video can send a start or end frame.");
      if (ref.role !== "reference" && entry.kind !== "image") throw new Error("A keyframe must be an image.");
      if (["voice", "music"].includes(action.composer.mode)) throw new Error("This Bench mode cannot send reference media.");
      const existing = session.tokenRegistry.find(token => token.token === entry.token);
      if (!existing) { session.tokenRegistry.push(entry); session.nextToken[entry.kind] = (session.nextToken[entry.kind] ?? 1) + 1; }
      const lane = ref.role === "reference" ? "reference" : "keyframe";
      const tokens = lane === "reference" ? session.composer.activeTokens : session.composer.keyframeTokens;
      if (lane === "keyframe" && tokens.includes(entry.token)) throw new Error("Start and end frames must use different references; neither frame can be dropped.");
      if (!tokens.includes(entry.token)) tokens.push(entry.token);
      events.push(existing ? { type: "reference-restored", token: entry.token, lane } : { type: "reference-added", entry, lane });
    }
  }
  const { references: _references, ...composer } = action.composer;
  session.composer = { ...composer, activeTokens: fromTake ? fromTake.request.references.map(ref => ref.token) : session.composer.activeTokens,
    keyframeTokens: fromTake ? fromTake.request.keyframes.map(ref => ref.token) : session.composer.keyframeTokens };
  if (!fromTake) events.push({ type: "composer-set", ...composer, subjectRouting: { activeTokens: session.composer.activeTokens, keyframeTokens: session.composer.keyframeTokens } });
  if (!action.sessionId) events.push({ type: "title-set", title: composer.brief.trim().slice(0, 200) || "Chat generation" });
  for (const own of record?.events.filter(event => event.requestId?.startsWith(initializationPrefix(id))) ?? []) {
    const index = Number(own.requestId!.slice(initializationPrefix(id).length));
    if (!Number.isInteger(index) || !events[index] || conversationActionDigest(events[index]) !== conversationActionDigest(own.event)) {
      throw new Error("The approved Bench initialization record changed.");
    }
  }
  return { session, revision: baseline.length, fromTake, initialization: { sessionId, createdAt: at, fresh: !action.sessionId, events, ...(subject ? { subject } : {}) } };
}

export async function materializeBenchChatSession(store: WorldStore, id: string, materialization: unknown) {
  // Quotes prepared by older app versions carry just their reserved takes.
  if (Array.isArray(materialization)) return;
  const { initialization } = BenchChatMaterializationSchema.parse(materialization);
  if (initialization.subject?.kind === "production") await store.ensureSchemaVersion(PRODUCTION_AUDIO_CHAT_SCHEMA_VERSION, "production-chat-audio");
  const bench = new BenchStore(sessionDir(store.dir, initialization.sessionId));
  await store.ownedWrite(async () => {
    if (initialization.fresh) await bench.create(initialization.sessionId, initialization.createdAt, initialization.subject);
    else if (!readBenchSession(store.dir, initialization.sessionId)) throw new Error("That Bench is unavailable.");
    for (const [index, event] of initialization.events.entries()) await bench.append(event, {
      at: initialization.createdAt, requestId: `${initializationPrefix(id)}${index}`,
    });
  });
}
