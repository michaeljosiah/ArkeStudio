import { link, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { AudioAssetProvenanceSchema, AudioQcReportSchema, AudioRangeSchema, AudioSourceRefSchema,
  PerformanceIdSchema, ArtifactIdSchema, SlugSchema, TakeIdSchema, type AudioAssetProvenance, type AudioRange, type AudioSourceRef } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import type { CommitInput } from "../world/commit.js";
import { atomicWriteFile } from "../world/atomic.js";
import { type AudioMediaTools, readAudioBytes, hashAudioFile } from "./media-tools.js";
import { audioHash, audioQcCacheKey } from "./qc.js";

/** All paths reaching this module come from authoritative records, still checked because
 * imported worlds can contain traversal, ADS or junctions. Errors contain no paths. */
export async function audioWorldPath(root: string, portable: string, createParents = false): Promise<string> {
  if (!portable || (/[\\:]/.test(portable) || portable.includes("\0")) || isAbsolute(portable)) throw new Error("audio-path-invalid");
  const parts = portable.split("/");
  if (parts.some(p => !p || p === "." || p === ".." || /[. ]$/.test(p))) throw new Error("audio-path-invalid");
  const base = await realpath(root);
  let cursor = base;
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]!);
    if (createParents && i < parts.length - 1) await mkdir(cursor).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("audio-directory-unavailable");
    });
    const info = await lstat(cursor).catch(error => {
      if (createParents && i === parts.length - 1 && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("audio-source-unavailable");
    });
    if (info?.isSymbolicLink() || (i < parts.length - 1 && !info?.isDirectory()) ||
      (i === parts.length - 1 && info && !info.isFile())) throw new Error("audio-path-invalid");
    if (info) {
      const rel = relative(base, await realpath(cursor));
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("audio-path-invalid");
    }
  }
  return cursor;
}

export type AudioSourceRequest = { kind: "performance-recording"; productionId: string; performanceId: string } | { kind: "legacy-character-sample"; sheetId: string; range?: AudioRange } |
  { kind: "artifact"; artifactId: string; range?: AudioRange } |
  { kind: "production-take"; productionId: string; takeId: string; range: AudioRange };

export async function resolveAudioSource(store: Pick<WorldStore, "dir" | "getBundle" | "closingSignal">, request: AudioSourceRequest) {
  const bundle = store.getBundle();
  let file: string, source: AudioSourceRef, physicalRange: AudioRange | undefined;
  if (request.kind === "performance-recording") {
    SlugSchema.parse(request.productionId); PerformanceIdSchema.parse(request.performanceId);
    if (!bundle.productions.some(p => p.meta.id === request.productionId)) throw new Error("audio-source-unavailable");
    const prefix = `productions/${request.productionId}/performances/${request.performanceId}`;
    const record = JSON.parse(await readFile(await audioWorldPath(store.dir, `${prefix}/source.json`), "utf8")) as { file: string; hash: string };
    if (!/^source\.(webm|m4a|wav|mp3)$/.test(record.file)) throw new Error("audio-path-invalid");
    file = `${prefix}/${record.file}`;
    const hash = (await hashAudioFile(await audioWorldPath(store.dir, file), store.closingSignal)).hash;
    if (hash !== record.hash) throw new Error("audio-source-changed");
    source = AudioSourceRefSchema.parse({ kind: request.kind, productionId: request.productionId,
      performanceId: request.performanceId, sourceFile: record.file, sourceMediaHash: hash });
  } else if (request.kind === "legacy-character-sample") {
    SlugSchema.parse(request.sheetId);
    const sample = bundle.referenceKits.find(k => k.sheetId === request.sheetId)?.designatedVoiceSample;
    if (!sample || "schemaVersion" in sample) throw new Error("audio-source-changed");
    file = `references/${request.sheetId}/${sample.file}`;
    const hash = (await hashAudioFile(await audioWorldPath(store.dir, file), store.closingSignal)).hash;
    physicalRange = request.range === undefined ? undefined : AudioRangeSchema.parse(request.range);
    source = AudioSourceRefSchema.parse({ kind: request.kind, sheetId: request.sheetId, sourceFile: sample.file,
      legacySource: sample.source, legacyDesignatedAt: sample.designatedAt, sourceMediaHash: hash,
      ...(physicalRange ? { range: physicalRange } : {}) });
  } else if (request.kind === "artifact") {
    ArtifactIdSchema.parse(request.artifactId);
    const artifact = bundle.artifacts.find(a => a.id === request.artifactId);
    if (!artifact || bundle.artifacts.some(a => a.supersedes === artifact.id)) throw new Error("audio-source-unavailable");
    file = `artifacts/${artifact.file}`;
    physicalRange = request.range === undefined ? undefined : AudioRangeSchema.parse(request.range);
    const path = await audioWorldPath(store.dir, file);
    const hash = (await hashAudioFile(path, store.closingSignal)).hash;
    if (!hash.startsWith(artifact.hash)) throw new Error("audio-source-changed");
    source = AudioSourceRefSchema.parse({ kind: "artifact", artifactId: artifact.id,
      recordedArtifactHash: artifact.hash, sourceMediaHash: hash,
      ...(artifact.generation ? { generation: {
        ...("jobId" in artifact.generation ? { jobId: artifact.generation.jobId } : {}),
        model: artifact.generation.model, provider: artifact.generation.provider,
        requestHash: audioHash(Buffer.from(JSON.stringify(artifact.generation))),
      } } : {}), ...(physicalRange ? { range: physicalRange } : {}) });
  } else {
    SlugSchema.parse(request.productionId); TakeIdSchema.parse(request.takeId);
    const production = bundle.productions.find(p => p.meta.id === request.productionId);
    const selected = production?.takes.find(t => t.id === request.takeId);
    if (!selected) throw new Error("audio-source-unavailable");
    const range = AudioRangeSchema.parse(request.range);
    physicalRange = range;
    let owner = selected;
    if (selected.segment) {
      if (range.outSec > selected.segment.outSec - selected.segment.inSec) throw new Error("audio-range-invalid");
      const parent = production!.takes.find(t => t.id === selected.segment!.passTakeId);
      if (!parent || parent.segment) throw new Error("audio-source-unavailable");
      owner = parent;
      physicalRange = AudioRangeSchema.parse({ inSec: range.inSec + selected.segment.inSec, outSec: range.outSec + selected.segment.inSec });
    }
    if (!owner.media || /[\\/:]/.test(owner.media)) throw new Error("audio-source-unavailable");
    file = `productions/${request.productionId}/takes/${owner.id}/${owner.media}`;
    const hash = (await hashAudioFile(await audioWorldPath(store.dir, file), store.closingSignal)).hash;
    source = AudioSourceRefSchema.parse({ kind: "production-take", productionId: request.productionId,
      selectedTakeId: selected.id, mediaTakeId: owner.id, sourceMediaHash: hash, range });
  }
  return { file, source, physicalRange };
}

export interface PreparedAudioCandidate {
  operationId: string; request: AudioSourceRequest; stagedFile: string; provenance: AudioAssetProvenance;
}

/** No consumer writes or paid calls. The caller retains this server-side candidate until the
 * director explicitly accepts it. All staging/cache mutations share the world's ownership. */
export async function prepareAudio(store: WorldStore, tools: AudioMediaTools, request: AudioSourceRequest,
  options: { gainDb?: number; signal?: AbortSignal } = {}): Promise<PreparedAudioCandidate> {
  return store.gateOp(async () => {
    const signal = options.signal ? AbortSignal.any([options.signal, store.closingSignal]) : store.closingSignal;
    const resolved = await resolveAudioSource(store, request);
    const operationId = randomUUID();
    const prefix = `.staging/audio/${operationId}`;
    const stagedFile = `${prefix}/prepared.wav`;
    const destinationPath = await audioWorldPath(store.dir, stagedFile, true);
    try {
      // Work on frozen bytes. A later external edit cannot redirect ffmpeg to a different file.
      const frozenPath = await audioWorldPath(store.dir, `${prefix}/source.media`, true);
      const bytes = await readAudioBytes(await audioWorldPath(store.dir, resolved.file), signal, 512 * 1024 * 1024);
      if (audioHash(bytes) !== resolved.source.sourceMediaHash) throw new Error("audio-source-changed");
      await writeFile(frozenPath, bytes, { flag: "wx" });
      const measured = await tools.probe({ absolutePath: frozenPath, expectedHash: resolved.source.sourceMediaHash, signal });
      const prepared = await tools.preparePcmWav({ sourcePath: frozenPath, expectedSourceHash: resolved.source.sourceMediaHash,
        destinationPath, ...(resolved.physicalRange ? { range: resolved.physicalRange } : {}), ...options, signal });
      const cacheFile = await audioWorldPath(store.dir, `.cache/audio-qc/${audioQcCacheKey(prepared.outputHash)}`, true);
      let report = await readFile(cacheFile, "utf8").then(text => AudioQcReportSchema.parse(JSON.parse(text))).catch(() => null);
      if (!report || report.sourceHash !== prepared.outputHash || report.analyzer.version !== 1 || report.analyzer.policyVersion !== 1) {
        const analysis = await tools.analyze({ absolutePath: destinationPath, expectedHash: prepared.outputHash, signal });
        if (analysis.status !== "complete") throw new Error(`audio-${analysis.reason}`);
        report = analysis.report;
        await atomicWriteFile(cacheFile, JSON.stringify(report));
      }
      const current = await resolveAudioSource(store, request);
      if (JSON.stringify(current.source) !== JSON.stringify(resolved.source)) throw new Error("audio-source-changed");
      const provenance = AudioAssetProvenanceSchema.parse({ schemaVersion: 1, source: resolved.source,
        sourceTechnical: measured.technical, outputHash: prepared.outputHash, outputTechnical: prepared.technical,
        preparation: [{ operation: "convert", inputHash: resolved.source.sourceMediaHash, outputHash: prepared.outputHash,
          tool: "ffmpeg", toolVersion: prepared.toolVersion, settings: { sampleRateHz: 48000, channels: 1, codec: "pcm_s16le",
            ...(resolved.physicalRange ? { inSec: resolved.physicalRange.inSec, outSec: resolved.physicalRange.outSec } : {}),
            ...(options.gainDb === undefined ? {} : { gainDb: options.gainDb }) } }],
        qualityReport: report, createdAt: new Date().toISOString() });
      await rm(frozenPath);
      const candidate = { operationId, request, stagedFile, provenance };
      await writeFile(await audioWorldPath(store.dir, `${prefix}/candidate.json`, true), JSON.stringify(candidate), { flag: "wx" });
      return candidate;
    } catch (error) {
      await rm(join(store.dir, ".staging", "audio", operationId), { recursive: true, force: true });
      throw error;
    }
  });
}

/** Consumer supplies its own metadata transaction, including the kit/performance base hash.
 * A failed journalled commit can recover forward, so retain landed bytes on uncertain failure. */
export async function acceptPreparedAudio(store: WorldStore, candidate: PreparedAudioCandidate, directory: string,
  commit: (file: string, provenance: AudioAssetProvenance) => CommitInput): Promise<string> {
  return store.gateOp(async () => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(candidate.operationId) ||
      candidate.stagedFile !== `.staging/audio/${candidate.operationId}/prepared.wav`) throw new Error("audio-candidate-invalid");
    const provenance = AudioAssetProvenanceSchema.parse(candidate.provenance);
    const current = await resolveAudioSource(store, candidate.request);
    if (JSON.stringify(current.source) !== JSON.stringify(provenance.source)) throw new Error("audio-source-changed");
    const sourcePath = await audioWorldPath(store.dir, candidate.stagedFile);
    const bytes = await readAudioBytes(sourcePath, store.closingSignal);
    if (audioHash(bytes) !== provenance.outputHash) throw new Error("audio-source-changed");
    const file = `${directory}/sha256-${provenance.outputHash.slice(7)}.wav`;
    const destination = await audioWorldPath(store.dir, file, true);
    const staged = await open(sourcePath, "r+");
    try { await staged.sync(); } finally { await staged.close(); }
    try { await link(sourcePath, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (audioHash(await readAudioBytes(destination, store.closingSignal)) !== provenance.outputHash) throw new Error("audio-source-changed");
    }
    await store.commitUnserialised(commit(file, provenance));
    await rm(join(store.dir, ".staging", "audio", candidate.operationId), { recursive: true, force: true });
    return file;
  });
}

/** Only abandoned staging is disposable without a consumer reference census. Durable media
 * is deliberately retained: consumers (#255/#113) own reference-aware collection. */
export async function cleanupAudioStaging(store: WorldStore, before: number, retainedOperationIds: ReadonlySet<string> = new Set()): Promise<void> {
  await store.ownedWrite(async () => {
    await audioWorldPath(store.dir, ".staging/audio/.containment-check", true);
    const root = join(store.dir, ".staging", "audio");
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (retainedOperationIds.has(entry.name) || !entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
      const path = join(root, entry.name);
      const info = await lstat(path);
      if (!info.isSymbolicLink() && info.mtimeMs < before) await rm(path, { recursive: true, force: true });
    }
  });
}
