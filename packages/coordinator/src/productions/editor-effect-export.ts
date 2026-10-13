import { createHash } from "node:crypto";
import { lstat, open, stat, unlink, writeFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { buildFfmpegArgs, containedPictureRect, effectCapabilityProblem, effectRenderCapabilityProblem, ulid, EFFECT_ANALYSIS_PROFILE, EffectFeatureManifestSchema, effectAudioSourceFingerprintMaterial, effectManifestFingerprintMaterial, prepareEffectReactions, type EffectFeatureManifest, type EffectAlphaInput, type EffectClip, type ExportPlan } from "@arke-studio/contracts";
import { runExport, type ExportHandle, type ExportSidecar, type FfmpegRunner } from "../takes/export.js";
import type { EffectRasterHost } from "../media/node-effect-renderer.js";
import { partitionEffectBlendLayers, type PictureBlendMode } from "@arke-studio/contracts";
import { hashMediaFile } from "../media/node-media-host.js";
import { containedWorldFilePath } from "../world/contained-file.js";
import type { WorldStore } from "../world/store.js";
import { toExtendedLength } from "../world/paths.js";

const MAX_INTERMEDIATE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_GROUPS = 128;

/** Frozen effects use production frames throughout. Only the delivery graph rebases its clock.
 * The caller captures matching authored settings and ready analyses together. Subsequent edits
 * do not change that export snapshot; source bytes remain mutable and are fenced at publication. */
export function runEffectExport(store: WorldStore, authored: ExportPlan, outName: string, runner: FfmpegRunner,
  host: EffectRasterHost | undefined, onProgress: (percent: number) => void, sidecar?: ExportSidecar, exportId?: string, analysis?: ReadonlyMap<string, EffectFeatureManifest>): ExportHandle {
  const plan = structuredClone(authored), id = exportId ?? `ex_${ulid()}`;
  const manifests: Record<string, EffectFeatureManifest> = {}, manifestKeys: Record<string, string> = {};
  let analysisError: Error | undefined, manifestBytes = 0;
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  try {
    for (const [effectId, value] of analysis ?? []) {
      if (!manifests[value.manifestKey]) {
        manifestBytes += Buffer.byteLength(JSON.stringify(value));
        if (manifestBytes > EFFECT_ANALYSIS_PROFILE.maxFrozenManifestBytes) throw new Error("Frozen effect analysis exceeds its 32 MiB budget");
        const manifest = EffectFeatureManifestSchema.parse(value);
        if (digest(effectAudioSourceFingerprintMaterial(manifest.descriptor)) !== manifest.sourceFingerprint || digest(effectManifestFingerprintMaterial(manifest)) !== manifest.manifestKey) throw new Error("Effect analysis manifest identity changed");
        manifests[manifest.manifestKey] = manifest;
      }
      manifestKeys[effectId] = value.manifestKey;
    }
  } catch (error) { analysisError = error instanceof Error ? error : new Error(String(error)); }
  if (plan.effectRender) plan.effectRender.pictureLayers = plan.effectRender.pictureLayers.filter(layer => layer.startFrame < plan.effectRender!.endFrame && layer.endFrame > plan.effectRender!.startFrame);
  const derivedPaths: string[] = [], identities = new Map<string, string>();
  const ownedFiles = new Map<string, { dev: number; ino: number }>(), stages: string[] = [];
  const ownedPath = (path: string, create = false) => containedWorldFilePath(store.dir, path, create, "effect-export");
  const remember = async (path: string) => { const info = await lstat(path); ownedFiles.set(path, { dev: info.dev, ino: info.ino }); };
  const discard = async (path: string) => {
    try {
      await ownedPath(relative(toExtendedLength(store.dir), toExtendedLength(path)).split(sep).join("/"));
      const current = await lstat(path), owned = ownedFiles.get(path);
      if (owned && current.dev === owned.dev && current.ino === owned.ino) await unlink(path);
    } catch { /* A disappeared or redirected cache path is no longer ours to remove. */ }
  };
  const sources = [...new Set([...(plan.effectRender?.pictureLayers.flatMap(layer => layer.path ? [layer.path] : []) ?? []), ...plan.audio.map(clip => clip.path), ...Object.values(manifests).flatMap(manifest => manifest.descriptor.sources.map(source => source.path))])];
  return runExport(store.dir, () => { throw new Error("effect export requires its renderer"); }, outName, runner, onProgress, sidecar, id, {
    signal: store.closingSignal,
    async prepare() {
      if (analysisError) throw analysisError;
      if (!host) throw new Error("This host has no deterministic effect renderer. Configure its media worker to export effects.");
      if (!plan.effectRender) throw new Error("Effect export requires a frozen effect plan");
      if (!outName || /[\\/]/.test(outName) || (sidecar && /[\\/]/.test(sidecar.name))) throw new Error("Invalid effect export filename");
      await store.assertOwnership();
      await ownedPath(`.cache/exports/${id}.mp4`, true);
      await ownedPath(`exports/${outName}`, true);
      if (sidecar) { await ownedPath(`.cache/exports/${id}-${sidecar.name}`, true); await ownedPath(`exports/${sidecar.name}`, true); }
      for (const name of [`${id}.mp4`, ...(sidecar ? [`${id}-${sidecar.name}`] : [])]) {
        const path = await ownedPath(`.cache/exports/${name}`, true);
        const reservation = await open(path, "wx"); await reservation.close();
        await remember(path); stages.push(path);
      }
    },
    async render(stage, signal) {
      const projection = plan.effectRender!;
      if (!runner.graphFileOption) throw new Error("This encoder host cannot determine effect graph-file support");
      const graphOption = await runner.graphFileOption(signal);
      if (projection.rendererVersion !== "software-rgba-v2") throw new Error("Unsupported effect renderer version");
      const activeReaction = projection.effectLayers.filter(({ effect }) => effect.reaction.enabled && effect.startFrame < projection.endFrame && effect.startFrame + effect.durationFrames > projection.startFrame &&
        (effect.target.kind === "composition" || projection.pictureLayers.some(picture => picture.kind === "media" &&
          (effect.target.kind === "picture-track" ? effect.target.trackId === picture.trackId : effect.target.kind === "visual-clip" && effect.target.clipId === picture.clipId) &&
          Math.max(projection.startFrame, picture.startFrame, effect.startFrame) < Math.min(projection.endFrame, picture.endFrame, effect.startFrame + effect.durationFrames))));
      for (const { effect } of activeReaction) {
        const manifest = manifests[manifestKeys[effect.id] ?? ""];
        if (!manifest) throw new Error("Audio reaction analysis is required before exporting enabled reaction.");
        if (manifest.descriptor.frameRate !== projection.frameRate || manifest.features.startFrame > Math.max(projection.startFrame, effect.startFrame) ||
          manifest.features.endFrame < Math.min(projection.endFrame, effect.startFrame + effect.durationFrames)) throw new Error("Audio reaction analysis does not cover this export's production clock.");
      }
      prepareEffectReactions(activeReaction.map(layer => layer.effect), manifests, manifestKeys, projection);
      const frames = projection.endFrame - projection.startFrame;
      if (!Number.isSafeInteger(frames) || frames < 1 || frames > 108_000) throw new Error("Effect export supports at most 108,000 frames per delivery");
      const problem = effectRenderCapabilityProblem(projection);
      if (problem) throw new Error(problem);
      for (const source of sources) identities.set(source, await hashMediaFile(await ownedPath(source), signal));
      for (const manifest of Object.values(manifests)) for (const source of manifest.descriptor.sources) {
        if (identities.get(source.path) !== source.sha256) throw new Error(`Audio reaction source changed before export: ${source.path}`);
      }
      for (const picture of projection.pictureLayers) if (picture.kind === "media" && picture.path) {
        const measured = await host!.probePicture(await ownedPath(picture.path), signal);
        picture.sourceSize = { width: measured.width, height: measured.height };
        if (!picture.still && measured.durationSec) picture.sourceOutSec = Math.min(picture.sourceOutSec ?? Infinity, measured.durationSec);
      }
      const groups: Array<{ pictureClipId?: string; effects: EffectClip[]; blendMode: PictureBlendMode; width: number; height: number; startFrame: number; endFrame: number }> = [];
      const intersects = (effect: EffectClip, start: number, end: number) => effect.startFrame < end && effect.startFrame + effect.durationFrames > start;
      for (const picture of projection.pictureLayers) {
        if (picture.kind !== "media" || !picture.sourceSize) continue;
        const start = Math.max(projection.startFrame, picture.startFrame), end = Math.min(projection.endFrame, picture.endFrame);
        const effects = projection.effectLayers.map(layer => layer.effect).filter(effect => intersects(effect, start, end) &&
          (effect.target.kind === "visual-clip" && effect.target.clipId === picture.clipId || effect.target.kind === "picture-track" && effect.target.trackId === picture.trackId));
        if (effects.length && start < end) for (const group of partitionEffectBlendLayers(effects)) groups.push({ pictureClipId: picture.clipId, ...group,
          ...containedPictureRect(picture.sourceSize.width, picture.sourceSize.height, projection.width, projection.height), startFrame: start, endFrame: end });
      }
      const composition = projection.effectLayers.map(layer => layer.effect).filter(effect => effect.target.kind === "composition" && intersects(effect, projection.startFrame, projection.endFrame));
      for (const group of partitionEffectBlendLayers(composition)) groups.push({ ...group, width: projection.width, height: projection.height, startFrame: projection.startFrame, endFrame: projection.endFrame });
      if (groups.length > MAX_GROUPS) throw new Error(`Effect export supports at most ${MAX_GROUPS} target groups per delivery`);
      const alpha: EffectAlphaInput[] = [];
      let diskBytes = 0, completedFrames = 0;
      const totalFrames = groups.reduce((sum, group) => sum + group.endFrame - group.startFrame, 0);
      for (const [index, group] of groups.entries()) {
        // The worker checks simultaneous active layers too; checking here refuses before doing
        // an expensive encode. Sequential clips do not consume a simultaneous-layer budget.
        for (const frame of new Set(group.effects.flatMap(effect => [Math.max(effect.startFrame, group.startFrame), Math.min(effect.startFrame + effect.durationFrames - 1, group.endFrame - 1)]))) {
          const issue = effectCapabilityProblem(group.effects.filter(effect => effect.startFrame <= frame && effect.startFrame + effect.durationFrames > frame), group.width, group.height);
          if (issue) throw new Error(issue);
        }
        const path = await ownedPath(`.cache/exports/${id}-effects-${index}.mkv`, true);
        await host!.renderAlpha({ ...group, output: path, frameRate: projection.frameRate, frameCount: group.endFrame - group.startFrame, signal,
          manifestsByKey: manifests, manifestKeyByEffectId: manifestKeys,
          maxBytes: MAX_INTERMEDIATE_BYTES - diskBytes,
          onProgress: frame => onProgress(Math.floor(60 * (completedFrames + frame) / Math.max(1, totalFrames))) });
        derivedPaths.push(path);
        await remember(path);
        diskBytes += (await stat(path)).size;
        if (diskBytes > MAX_INTERMEDIATE_BYTES) throw new Error("Effect intermediates exceeded the 8 GiB job disk budget");
        completedFrames += group.endFrame - group.startFrame;
        alpha.push({ path, startFrame: group.startFrame, endFrame: group.endFrame, blendMode: group.blendMode, ...(group.pictureClipId ? { pictureClipId: group.pictureClipId } : {}) });
      }
      const args = buildFfmpegArgs(plan, store.dir, stage, runner.slateFont, alpha);
      // Windows command lines are bounded. The graph is local job data, never shell code.
      const graphIndex = args.indexOf("-filter_complex");
      if (graphIndex >= 0) {
        const graph = await ownedPath(`.cache/exports/${id}-effects.ffgraph`, true);
        await writeFile(graph, args[graphIndex + 1]!, { flag: "wx" }); derivedPaths.push(graph); await remember(graph);
        args.splice(graphIndex, 2, graphOption, graph);
      }
      await runner.run(args, percent => onProgress(60 + Math.floor(percent * 0.39)), signal,
        seconds => onProgress(Math.min(99, 60 + Math.floor(39 * seconds / plan.totalSec))));
    },
    async publish(write, signal) {
      await store.ownedWrite(async () => {
        if (signal.aborted) throw new Error("Effect export cancelled before publication");
        for (const [source, hash] of identities) if (await hashMediaFile(await ownedPath(source), signal) !== hash) throw new Error(`Export source changed while rendering: ${source}`);
        await ownedPath(`.cache/exports/${id}.mp4`);
        await containedWorldFilePath(store.dir, `exports/${outName}`, false, "effect-export", true);
        if (sidecar) { await ownedPath(`.cache/exports/${id}-${sidecar.name}`); await containedWorldFilePath(store.dir, `exports/${sidecar.name}`, false, "effect-export", true); }
        await store.assertOwnership();
        if (signal.aborted) throw new Error("Effect export cancelled before publication");
        await write();
      });
    },
    async cleanupStaging() { for (const path of stages) await discard(path); },
    async rollbackOutput(path) {
      const source = stages[0] && ownedFiles.get(stages[0]);
      if (source) { ownedFiles.set(path, source); await discard(path); }
    },
    async cleanup() { for (const path of derivedPaths) await discard(path); },
  });
}
