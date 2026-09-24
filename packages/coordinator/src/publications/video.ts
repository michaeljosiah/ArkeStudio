import { createHash } from "node:crypto";
import { mkdtemp, open, realpath, rm } from "node:fs/promises";
import { basename, join, normalize } from "node:path";
import {
  buildFfmpegArgs, buildVideoPublicationPlan, serializeTimedText, VideoPublicationManifestSchema,
  VideoPublicationRequestSchema, type PublicationAsset, type VideoPublicationPlan, type VideoPublicationRequest,
} from "@arke-studio/contracts";
import { validatePlacedPerformanceBytes } from "../audio/performance-placement.js";
import type { MediaProbe } from "../media/probe.js";
import type { FfmpegRunner } from "../takes/export.js";
import { toExtendedLength } from "../world/paths.js";
import { scanWorld } from "../world/scan.js";
import type { WorldStore } from "../world/store.js";
import { capturePublicationInputs, type CapturedPublicationInputs } from "./capture.js";
import { validatePublicationVtt } from "./captions.js";
import { PublicationFileError, readPublicationFile } from "./files.js";
import { publicationFileLimits, verifyPublicationDirectory, type PublicationFileLimits, type VerifiedPublicationDirectory } from "./verify.js";

export interface VideoPublicationCompilerOptions {
  /** Existing trusted host directory. The returned package is a unique, disposable child. */
  scratchRoot: string;
  encoder: FfmpegRunner;
  /** Exact encoder build identity supplied by the platform, included in build provenance. */
  encoderVersion: string;
  probe: Required<Pick<MediaProbe, "info">>;
  signal?: AbortSignal;
  limits?: Partial<PublicationFileLimits>;
  onProgress?: (percent: number) => void;
  /** Capture progress runs inside the world gate; never await a managed write from it. */
  onCopied?: (key: string) => void | Promise<void>;
}

export interface CompiledVideoPublication extends VerifiedPublicationDirectory {
  /** This is temporary output, not a durable completion receipt. A publisher must consume it. */
  dispose(): Promise<void>;
}

export interface PreparedVideoPublication {
  /** Consume the pinned inputs once, outside world-provider access. */
  render(): Promise<CompiledVideoPublication>;
  /** Release unused inputs; an active render owns their cleanup and cancellation. */
  dispose(): Promise<void>;
}

// Records can have different property insertion orders after a rescan. Arrays remain ordered:
// picture stacking, selections and cue order are decisions, unlike object key spelling order.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

/**
 * SPEC-048 R-6..R-9, R-19..R-23. Resolve under the world gate, render only pinned files, then
 * verify a standalone package. Promotion, retry reconciliation and player transport belong to
 * the publisher; returning this temporary directory must never be reported as durable delivery.
 */
export async function compileVideoPublication(
  store: WorldStore, input: VideoPublicationRequest, options: VideoPublicationCompilerOptions,
): Promise<CompiledVideoPublication> {
  const signal = options.signal ? AbortSignal.any([options.signal, store.closingSignal]) : store.closingSignal;
  return (await prepareVideoPublication(store, input, { ...options, signal })).render();
}

/** Capture under provider access, then render independently of source-world selection/close. */
export async function prepareVideoPublication(
  store: WorldStore, input: VideoPublicationRequest, options: VideoPublicationCompilerOptions,
): Promise<PreparedVideoPublication> {
  const request = VideoPublicationRequestSchema.parse(input);
  const signal = options.signal ? AbortSignal.any([options.signal, store.closingSignal]) : store.closingSignal;
  signal.throwIfAborted();
  const limits = publicationFileLimits(options.limits);
  if (!options.encoderVersion.trim() || options.encoderVersion.length > 256) throw new Error("A bounded encoder build identity is required.");
  const compiler = { compiler: "arke-video-publication", compilerVersion: `1; ${options.encoderVersion}` };
  const scratch = await realpath(toExtendedLength(options.scratchRoot));
  let captured: CapturedPublicationInputs | undefined;
  let plan: VideoPublicationPlan | undefined;
  const snapshot = async () => {
    signal.throwIfAborted();
    const scan = await scanWorld(store.dir, { signal, includeOperationalState: false });
    signal.throwIfAborted();
    const production = scan.bundle.productions.find(item => item.meta.id === request.productionId);
    if (!production) throw new PublicationFileError("invalid-package", "The production is missing or invalid.");
    const problem = scan.problems.find(item => item.path.startsWith(`productions/${request.productionId}/`) || item.path.startsWith("artifacts/"));
    if (problem) throw new PublicationFileError("invalid-package", `Invalid source ${problem.path}: ${problem.message}`);
    await validatePlacedPerformanceBytes(store, production, signal);
    const projected = buildVideoPublicationPlan({ production, artifacts: scan.bundle.artifacts, timeline: production.timeline }, request);
    if (!projected.ok) throw new PublicationFileError("invalid-package", projected.reason);
    // Conservative discovery includes the scanner's authored inventory, not just existing
    // timeline paths. A second scan catches a newly created timeline/selection/sidecar too.
    // The derived input identity also covers scanner inputs absent from its text manifest.
    return { plan: projected.plan, manifest: scan.manifest, artifacts: scan.bundle.artifacts, takeMediaInfo: production.takeMediaInfo,
      identity: digest({ production, artifacts: scan.bundle.artifacts, meta: scan.meta, manifest: scan.manifest }) };
  };
  try {
    captured = await capturePublicationInputs(store, async () => {
      const before = await snapshot();
      plan = before.plan;
      const records = Object.fromEntries(Object.keys(before.manifest).sort().map(path => [path, path]));
      const media = Object.fromEntries(plan.media.map(path => [path, path]));
      let total = 0;
      const measured = [];
      for (const path of plan.media) {
        const takePrefix = `productions/${request.productionId}/takes/`;
        const takeId = path.startsWith(takePrefix) ? path.slice(takePrefix.length).split("/")[0]! : null;
        if (takeId !== null && Object.hasOwn(before.manifest, `${takePrefix}${takeId}/media-info.json`) &&
          !Object.hasOwn(before.takeMediaInfo, takeId)) {
          // The scanner only retains a take measurement when its recorded hash matches the
          // actual file. Muting sound must not turn replaced picture into a reviewed take.
          throw new PublicationFileError("source-changed", `Take bytes no longer match their media measurement: ${path}`);
        }
        const file = await readPublicationFile(store.dir, path, Math.min(limits.assetBytes, limits.totalBytes - total), signal);
        const measurement = takeId === null ? undefined : before.takeMediaInfo[takeId];
        if (measurement && measurement.sourceHash !== `sha256:${file.sha256}`) {
          throw new PublicationFileError("source-changed", `Take bytes changed after discovery: ${path}`);
        }
        for (const artifact of before.artifacts.filter(item => `artifacts/${item.file}` === path)) {
          if (artifact.hash !== `sha256:${file.sha256}`) {
            throw new PublicationFileError("source-changed", `Artifact bytes no longer match their record: ${path}`);
          }
        }
        total += file.byteLength;
        measured.push({ key: path, sha256: file.sha256, byteLength: file.byteLength });
      }
      return { request: { records, media, receipt: {
        version: 1, compiler, timelineRevision: plan.render.revision,
        records: Object.keys(records).map(key => ({ key, sha256: before.manifest[key]!.replace(/^sha256:/, "") })),
        media: measured, resolvedPlanSha256: digest({ plan, sourceIdentity: before.identity }), settingsSha256: digest(request),
      } }, revalidate: async () => {
        let after;
        try { after = await snapshot(); }
        catch (error) {
          signal.throwIfAborted();
          throw new PublicationFileError("source-changed", `Publication sources changed during capture: ${(error as Error).message}`);
        }
        if (after.identity !== before.identity || digest(after.plan) !== digest(before.plan)) {
          throw new PublicationFileError("source-changed", "Publication dependencies changed during capture. Prepare a fresh build.");
        }
      } };
    }, scratch, { signal, limits, ...(options.onCopied ? { onCopied: options.onCopied } : {}) });
    signal.throwIfAborted();
    const inputs = captured;
    let renderStarted = false, discarded = false;
    return {
      render: async () => {
        if (renderStarted || discarded) throw new PublicationFileError("operation-conflict", "This publication capture has already been consumed.");
        renderStarted = true;
        return renderCapturedVideoPublication(request, inputs, plan!, compiler, scratch, options);
      },
      dispose: async () => {
        if (renderStarted || discarded) return;
        discarded = true;
        await inputs.dispose();
      },
    };
  } catch (error) { await captured?.dispose(); throw error; }
}

async function renderCapturedVideoPublication(
  request: VideoPublicationRequest, inputs: CapturedPublicationInputs, frozen: VideoPublicationPlan,
  compiler: { compiler: string; compilerVersion: string }, scratch: string, options: VideoPublicationCompilerOptions,
): Promise<CompiledVideoPublication> {
  // Only the operation/host signal survives capture. Switching worlds must not withdraw frozen bytes.
  const signal = options.signal ?? new AbortController().signal;
  const limits = publicationFileLimits(options.limits);
  let captured: CapturedPublicationInputs | undefined = inputs;
  let directory: string | undefined;
  let disposed = false;
  const dispose = async () => {
    if (directory && !disposed) {
      await rm(toExtendedLength(directory), { recursive: true, force: true });
      disposed = true;
    }
  };
  try {
    signal.throwIfAborted();
    const pathOf = (path: string) => {
      const copy = captured!.media[path];
      if (!copy) throw new PublicationFileError("invalid-package", `Uncaptured render input: ${path}`);
      return basename(copy);
    };
    // The same file can supply picture and sound. All paths, including overlays, target
    // copies pinned before the gate was released; no encoder input resolves a live selection.
    const render = { ...frozen.render,
      items: frozen.render.items.map(item => item.type === "clip" ? { ...item, path: pathOf(item.path) } : item),
      overlays: frozen.render.overlays.map(item => ({ ...item, path: pathOf(item.path) })),
      audio: frozen.render.audio.map(item => ({ ...item, path: pathOf(item.path) })),
    };
    const temporal = new Set([
      ...frozen.render.items.flatMap(item => item.type === "clip" ? [item.path] : []),
      ...frozen.render.overlays.filter(item => !item.still).map(item => item.path),
      ...frozen.render.audio.map(item => item.path),
    ]);
    for (const path of temporal) {
      signal.throwIfAborted();
      const info = await options.probe.info(captured.media[path]!, { signal });
      const clips = frozen.render.items.filter(item => item.type === "clip" && item.path === path);
      const overlays = frozen.render.overlays.filter(item => !item.still && item.path === path);
      const audio = frozen.render.audio.filter(item => item.path === path);
      const starts = [...clips.map(item => item.type === "clip" ? item.inSec ?? 0 : 0),
        ...overlays.map(item => item.sourceInSec ?? 0), ...audio.map(item => item.sourceInSec)];
      if (!info || !Number.isFinite(info.durationSec) || info.durationSec <= 0 ||
        ((clips.length || overlays.length) && info.hasVideo !== true) || (audio.length && !info.hasAudio) ||
        starts.some(start => !Number.isFinite(start) || start < 0 || start >= info.durationSec) ||
        overlays.some(item => (item.sourceInSec ?? 0) + item.endSec - item.startSec > info.durationSec + 1 / render.frameRate) ||
        clips.some(item => item.type === "clip" && item.outSec !== undefined &&
          (item.outSec <= (item.inSec ?? 0) || item.outSec > info.durationSec + 1 / render.frameRate))) {
        throw new PublicationFileError("invalid-package", `Captured media cannot supply the requested picture, sound or source range: ${path}`);
      }
    }
    signal.throwIfAborted();
    directory = await mkdtemp(toExtendedLength(join(scratch, "arke-video-publication-")));
    const movie = join(directory, "movie.mp4");
    const args = buildFfmpegArgs(render, captured.directory, movie, options.encoder.slateFont);
    // The shared builder uses portable separators. Win32 extended-length paths, unlike
    // ordinary drive paths, require native separators all the way through the filename.
    for (let index = 0; index < args.length - 1; index++) {
      if (args[index] === "-i" && args[index + 1]!.startsWith(`${captured.directory}/`)) args[index + 1] = normalize(args[index + 1]!);
    }
    args.splice(args.length - 1, 0, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
    await options.encoder.run(args, options.onProgress ?? (() => {}), signal);
    signal.throwIfAborted();
    const info = await options.probe.info(movie, { signal });
    if (!info || info.hasVideo !== true || !Number.isFinite(info.durationSec) ||
      Math.abs(info.durationSec - render.totalSec) > 1 / render.frameRate + 0.05 ||
      (render.audio.length > 0 && !info.hasAudio)) {
      throw new PublicationFileError("invalid-package", "Encoded movie does not match the planned picture, sound or duration.");
    }
    const movieHandle = await open(toExtendedLength(movie), "r+");
    try { await movieHandle.sync(); } finally { await movieHandle.close(); }
    const assets: Record<string, PublicationAsset> = {};
    const movieDigest = await readPublicationFile(directory, "movie.mp4", limits.assetBytes, signal);
    assets.movie = { href: "movie.mp4", mediaType: "video/mp4", sha256: movieDigest.sha256, byteLength: movieDigest.byteLength };
    for (const entry of frozen.textTracks) {
      signal.throwIfAborted();
      const href = `${entry.track.asset}.vtt`;
      const text = serializeTimedText(entry.cues, "vtt");
      // Encoder duration tolerance is wider than caption tolerance. Validate actual serialized
      // sidecars against the measured movie so a completed package passes player preflight.
      validatePublicationVtt(text, info.durationSec);
      await writeFlushed(join(directory, href), text);
      const measured = await readPublicationFile(directory, href, limits.assetBytes, signal);
      assets[entry.track.asset] = { href, mediaType: "text/vtt", sha256: measured.sha256, byteLength: measured.byteLength };
    }
    const manifest = VideoPublicationManifestSchema.parse({
      format: "arke-publication", schemaVersion: 1, profile: "video", profileVersion: 1,
      id: request.id, edition: request.edition, title: request.title, language: request.language,
      requires: frozen.textTracks.length ? ["video-v1", "webvtt-v1"] : ["video-v1"], assets,
      content: { video: "movie", textTracks: frozen.textTracks.map(entry => entry.track) },
      build: { ...compiler, dependencyFingerprint: captured.fingerprint },
    });
    await writeFlushed(join(directory, "publication.json"), JSON.stringify(manifest, null, 2) + "\n");
    const verified = await verifyPublicationDirectory(directory, { signal, limits });
    signal.throwIfAborted();
    await captured.dispose();
    captured = undefined;
    signal.throwIfAborted();
    return { ...verified, dispose };
  } catch (error) {
    await dispose();
    throw error;
  } finally { await captured?.dispose(); }
}

async function writeFlushed(path: string, text: string): Promise<void> {
  const file = await open(toExtendedLength(path), "wx");
  try { await file.writeFile(text, "utf8"); await file.sync(); }
  finally { await file.close(); }
}
