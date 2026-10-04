import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BenchEventEnvelopeSchema, BenchSessionMetaSchema, SessionIdSchema, foldBenchSession,
  PROVIDERS, TakeIdSchema, type BenchTake, type ModelManifest } from "@arke-studio/contracts";
import type { ProductionReadRow } from "../world-chat/production-reads.js";

/** Retrieval must never repair a journal or quietly attest damaged records as empty. */
function plain(path: string, directory: boolean): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error("The Bench record is unavailable.");
}
export function readBenchRecord(worldDir: string, sessionId: string) {
  SessionIdSchema.parse(sessionId);
  const root = join(worldDir, ".sessions");
  const dir = join(root, sessionId);
  try { plain(root, true); plain(dir, true); plain(join(dir, "session.json"), false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const meta = BenchSessionMetaSchema.parse(JSON.parse(readFileSync(join(dir, "session.json"), "utf8")));
  if (meta.id !== sessionId) throw new Error("The Bench identity does not match its directory.");
  let raw = "";
  try { plain(join(dir, "events.jsonl"), false); raw = readFileSync(join(dir, "events.jsonl"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (raw && !raw.endsWith("\n")) throw new Error("The Bench journal needs recovery before it can be read.");
  const events = raw.split("\n").filter(line => line.trim()).map(line => BenchEventEnvelopeSchema.parse(JSON.parse(line)));
  if (events.some((event, index) => event.seq !== index + 1)) throw new Error("The Bench journal sequence is damaged.");
  return { meta, events, session: foldBenchSession(meta, events) };
}
export const readBenchSession = (worldDir: string, sessionId: string) => readBenchRecord(worldDir, sessionId)?.session ?? null;
export function benchTakeMediaPath(worldDir: string, sessionId: string, take: Pick<BenchTake, "id" | "media">): string {
  SessionIdSchema.parse(sessionId);
  TakeIdSchema.parse(take.id);
  const file = take.media?.file;
  if (!file || /[\\/:]/.test(file) || file === "." || file === "..") throw new Error("The Bench media filename is invalid.");
  let path = worldDir;
  const parts = [".sessions", sessionId, "media", take.id, file];
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    plain(path, index < parts.length - 1);
  }
  return path;
}
function appendProjection(rows: ProductionReadRow[], key: string, value: unknown): void {
  const text: ProductionReadRow[] = [];
  const bounded = (item: unknown, path: string): unknown => {
    if (typeof item === "string" && item.length > 4_000) {
      for (let offset = 0; offset < item.length; offset += 4_000) text.push({ key: `${key}:text:${path}:${String(offset).padStart(10, "0")}`,
        value: { kind: "bench-text", owner: key, path, offset, text: item.slice(offset, offset + 4_000), characters: item.length } });
      return { textInFollowingRows: true, characters: item.length };
    }
    if (Array.isArray(item)) return item.map((child, index) => bounded(child, `${path}/${index}`));
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([name, child]) => [name, bounded(child, `${path}/${name}`)]));
    return item;
  };
  rows.push({ key, value: bounded(value, "") }, ...text);
}
export function benchReadRows(worldDir: string, sessionId?: string): ProductionReadRow[] {
  const rows: ProductionReadRow[] = [];
  let ids: string[];
  if (sessionId) ids = [SessionIdSchema.parse(sessionId)];
  else {
    const root = join(worldDir, ".sessions");
    try { plain(root, true); ids = readdirSync(root).filter(id => SessionIdSchema.safeParse(id).success).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  for (const id of ids) {
    const session = readBenchSession(worldDir, id);
    if (!session) { if (sessionId) throw new Error("That Bench session is unavailable."); continue; }
    appendProjection(rows, `${id}:0`, { kind: "bench-session", sessionId: id, title: session.title,
      subject: session.subject ?? null, createdAt: session.createdAt, updatedAt: session.updatedAt,
      selectedTakeId: session.selectedTakeId, takeCount: session.takes.length });
    if (!sessionId) continue;
    appendProjection(rows, `${id}:1`, { kind: "bench-composer", composer: session.composer });
    Object.values(session.tokenRegistry).sort((a, b) => a.token.localeCompare(b.token)).forEach(entry =>
      rows.push({ key: `${id}:2:${entry.token}`, value: { kind: "bench-reference", reference: entry } }));
    session.takes.forEach(take => appendProjection(rows, `${id}:3:${String(take.n).padStart(10, "0")}`, {
      kind: "bench-take", takeId: take.id, number: take.n, status: take.status, decision: take.disposition,
      request: { mode: take.request.mode, brief: take.request.brief, provider: take.request.provider, model: take.request.model,
        params: take.request.params, references: take.request.references, keyframes: take.request.keyframes,
        recipeVersion: take.request.recipeVersion, requestedSeed: take.request.requestedSeed, sampling: take.request.sampling },
      jobId: take.jobId, media: take.media, cost: take.cost, artifactId: take.keptArtifactId,
    }));
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}
/** Only public model capabilities and prices: never credentials or the account's speech plan. */
export function generationRouteReadRows(manifest: ModelManifest | null, disabled: readonly string[]): ProductionReadRow[] {
  return (manifest?.models ?? []).filter(model => !disabled.includes(model.id) && !model.upscale)
    .filter(model => ["image", "video", "voice-tts", "music"].includes(model.capability))
    .sort((a, b) => `${a.provider}:${a.id}`.localeCompare(`${b.provider}:${b.id}`))
    .map(model => ({ key: `${model.provider}:${model.id}`, value: { id: model.id, provider: model.provider,
      name: model.displayName, capability: model.capability, locality: PROVIDERS[model.provider]?.local ? "local" : "cloud",
      accepts: model.accepts, limits: model.limits, pricing: model.pricing, referenceRoute: model.referenceRoute,
      modes: model.modes, sampling: model.sampling, unverified: model.unverified ?? false } }));
}

/** Private attachment bytes must outlive every session and immutable request that cites them. */
export function benchUsesConversationAttachments(worldDir: string, conversationId: string): boolean {
  const prefix = `.conversations/${conversationId}/attachments/`;
  for (const row of benchReadRows(worldDir)) {
    if ((row.value as { kind: string }).kind !== "bench-session") continue;
    const id = (row.value as { sessionId: string }).sessionId;
    const session = readBenchSession(worldDir, id)!;
    const references = [...session.tokenRegistry, ...session.takes.flatMap(take => [...take.request.references, ...take.request.keyframes])];
    if (references.some(ref => ref.source.source === "world-file" && ref.source.path.replaceAll("\\", "/").startsWith(prefix))) return true;
  }
  return false;
}
