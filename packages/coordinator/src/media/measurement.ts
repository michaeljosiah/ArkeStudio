import { stat } from "node:fs/promises";
import { ArtifactSidecarSchema, TakeSchema, TakeMediaInfoRecordSchema, MediaInfoSchema, resolveProductionArtifact, type MediaMeasurementSource,
  type MediaMeasurementResult } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { containedWorldFilePath } from "../world/contained-file.js";
import { readContainedMediaBytes, hashContainedProductionMedia } from "../world/reference-files.js";
import { sha256 } from "../world/text-files.js";
import { measureMediaInfo, type MediaProbe } from "./probe.js";

const read = async (store: WorldStore, path: string) => new TextDecoder("utf-8", { fatal: true })
  .decode(await readContainedMediaBytes(store.dir, path, store.closingSignal, 2 * 1024 * 1024)).replace(/^\uFEFF/, "");
async function optionalRead(store: WorldStore, path: string): Promise<string | null> {
  const absolute = await containedWorldFilePath(store.dir, path, false, "measurement", true);
  try { await stat(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  return read(store, path);
}
const identity = (info: Awaited<ReturnType<typeof stat>>) => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");
const queues = new WeakMap<WorldStore, { tail: Promise<unknown>; pending: Map<string, Promise<MediaMeasurementResult>> }>();
class Refused extends Error { constructor(readonly reason: Extract<MediaMeasurementResult, { status: "failed" }>["reason"]) { super(reason); this.name = "MediaMeasurementRefused"; } }

async function owner(store: WorldStore, productionId: string, source: MediaMeasurementSource, expectedHash?: string) {
  const world = store.getBundle(), production = world.productions.find(p => p.meta.id === productionId);
  if (!production) throw new Refused("unavailable");
  if (source.kind === "artifact") {
    const resolved = resolveProductionArtifact(world.artifacts, source.artifactId, productionId);
    if (!resolved.ok || !["audio", "video"].includes(resolved.artifact.kind)) throw new Refused("unavailable");
    const artifact = resolved.artifact;
    if (expectedHash && artifact.hash !== expectedHash) throw new Refused("source-changed");
    const record = `artifacts/${artifact.file}.json`, raw = await read(store, record), sidecar = ArtifactSidecarSchema.parse(JSON.parse(raw));
    if (sidecar.id !== artifact.id || sidecar.hash !== artifact.hash) throw new Refused("source-changed");
    return { media: `artifacts/${artifact.file}`, record, raw, expected: artifact.hash, cached: sidecar.mediaInfo,
      content: (info: import("@arke-studio/contracts").MediaInfo) => JSON.stringify({ ...sidecar, mediaInfo: info }, null, 2) + "\n" };
  }
  let take = production.takes.find(t => t.id === source.takeId);
  if (!take) throw new Refused("unavailable");
  if (take.segment) take = production.takes.find(t => t.id === take!.segment!.passTakeId);
  if (!take || !take.media || !["clip", "voice"].includes(take.kind)) throw new Refused("unavailable");
  if (expectedHash && take.mediaHash !== expectedHash) throw new Refused("source-changed");
  const takeRecord = `productions/${productionId}/takes/${take.id}/take.json`;
  const takeRaw = await read(store, takeRecord), disk = TakeSchema.parse(JSON.parse(takeRaw));
  if (JSON.stringify(disk) !== JSON.stringify(take)) throw new Refused("source-changed");
  const record = `productions/${productionId}/takes/${take.id}/media-info.json`;
  const raw = await optionalRead(store, record);
  const previous = raw === null ? null : TakeMediaInfoRecordSchema.safeParse(JSON.parse(raw));
  return { media: `productions/${productionId}/takes/${take.id}/${take.media}`, record, raw, expected: take.mediaHash,
    takeRecord, takeRaw, cached: previous?.success ? previous.data.mediaInfo : undefined,
    cachedHash: previous?.success ? previous.data.sourceHash : undefined,
    content: (info: import("@arke-studio/contracts").MediaInfo, hash: string) => JSON.stringify(TakeMediaInfoRecordSchema.parse({ sourceHash: hash, mediaInfo: info, probedAt: store.now() }), null, 2) + "\n" };
}

/** IDs resolve through the owning production; probing never authorizes a provider request. */
async function measure(store: WorldStore, productionId: string, source: MediaMeasurementSource, probe: MediaProbe | null, expectedHash?: string, cancelled?: AbortSignal): Promise<MediaMeasurementResult> {
  const signal = cancelled ? AbortSignal.any([store.closingSignal, cancelled]) : store.closingSignal;
  let phase: "unavailable" | "probe-failed" | "save-failed" = "unavailable";
  try {
    signal.throwIfAborted();
    const held = await owner(store, productionId, source, expectedHash);
    const absolute = await containedWorldFilePath(store.dir, held.media), before = identity(await stat(absolute));
    const verified = await hashContainedProductionMedia(store.dir, held.media, held.expected ?? "sha256:", signal);
    if (held.cached && Number.isFinite(held.cached.durationSec) && (!("cachedHash" in held) || held.cachedHash === verified.sourceHash)) return { status: "measured", info: held.cached };
    // A duration-only host cannot establish audio presence; never persist its conservative false.
    if (!probe?.info) throw new Refused("not-configured");
    phase = "probe-failed";
    const info = await measureMediaInfo(store, held.media, probe, { signal });
    signal.throwIfAborted();
    if (!info || !Number.isFinite(info.durationSec) || !MediaInfoSchema.safeParse(info).success) throw new Refused("probe-failed");
    const after = await hashContainedProductionMedia(store.dir, held.media, verified.sourceHash, signal);
    if (before !== identity(await stat(await containedWorldFilePath(store.dir, held.media))) || after.sourceHash !== verified.sourceHash) throw new Refused("source-changed");
    phase = "save-failed";
    await store.gateOp(async () => {
      signal.throwIfAborted();
      if (before !== identity(await stat(await containedWorldFilePath(store.dir, held.media)))) throw new Refused("source-changed");
      if (held.takeRecord && await read(store, held.takeRecord) !== held.takeRaw) throw new Refused("source-changed");
      const current = await optionalRead(store, held.record);
      if (current !== held.raw) throw new Refused("source-changed");
      await store.commitUnserialised({ kind: "media-measurement", source: "local-probe", files: [{ path: held.record,
        action: held.raw === null ? "create" : "replace", baseHash: held.raw === null ? null : sha256(held.raw), content: held.content(info, verified.sourceHash) }] });
    });
    return { status: "measured", info };
  } catch (error) {
    return { status: "failed", reason: signal.aborted ? "cancelled" : error instanceof Refused ? error.reason :
      error instanceof Error && /changed|matches|path-invalid/.test(error.message) ? "source-changed" : phase };
  }
}

/** One native probe per world; repeated presses join it, and a bounded queue drains on close. */
export function measureProductionMedia(store: WorldStore, productionId: string, source: MediaMeasurementSource, probe: MediaProbe | null, expectedHash?: string, signal?: AbortSignal): Promise<MediaMeasurementResult> {
  let queue = queues.get(store);
  if (!queue) { queue = { tail: Promise.resolve(), pending: new Map() }; queues.set(store, queue); }
  const key = JSON.stringify([productionId, source, expectedHash]), existing = queue.pending.get(key);
  if (existing) return existing;
  if (queue.pending.size >= 8) return Promise.resolve({ status: "failed", reason: "busy" });
  const run = queue.tail.then(() => measure(store, productionId, source, probe, expectedHash, signal)).finally(() => queue!.pending.delete(key));
  queue.tail = run.catch(() => {}); queue.pending.set(key, run);
  return run;
}
