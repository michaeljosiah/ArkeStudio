import { z } from "zod";
import type { ProductionTimeline, TimelineClip, TimelineTrack } from "./timeline.js";
import type { ArtifactSidecar } from "./artifact.js";

const trackId = z.string().regex(/^tr_[A-Za-z0-9][A-Za-z0-9_-]*$/);
const clipId = z.string().regex(/^cl_[A-Za-z0-9][A-Za-z0-9_-]*$/);
const pair = { trackId, leftClipId: clipId, rightClipId: clipId };
export const CrossfadeSchema = z.object({ ...pair, type: z.literal("crossfade"),
  durationFrames: z.number().int().min(2).max(108000), protectJoin: z.boolean().default(false),
  protectDuration: z.boolean().default(false), leftSourceKey: z.string().max(256).optional(), rightSourceKey: z.string().max(256).optional() }).strict();
export type Crossfade = z.infer<typeof CrossfadeSchema>;
export type TransitionPair = Pick<Crossfade, "trackId" | "leftClipId" | "rightClipId">;
export const TransitionCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("transition-set"), ...pair, durationFrames: CrossfadeSchema.shape.durationFrames }).strict(),
  z.object({ kind: z.literal("transition-remove"), ...pair }).strict(),
  z.object({ kind: z.literal("transition-protect"), ...pair, setting: z.enum(["join", "duration"]) }).strict(),
  z.object({ kind: z.literal("transition-release"), ...pair, setting: z.enum(["join", "duration"]) }).strict(),
]);
export type TransitionCommand = z.infer<typeof TransitionCommandSchema>;
export function isTransitionCommand(command: { kind: string }): command is TransitionCommand { return command.kind.startsWith("transition-"); }
export const transitionKey = (pair: TransitionPair): string => `${pair.trackId}/${pair.leftClipId}/${pair.rightClipId}`;
export const sameTransitionPair = (a: TransitionPair, b: TransitionPair): boolean => transitionKey(a) === transitionKey(b);
export function timelineCarriesTransitions(timeline: ProductionTimeline): boolean {
  return timeline.transitions !== undefined || [...timeline.history.undo, ...timeline.history.redo].some(entry => entry.kind === "change" && entry.transitions !== undefined);
}
export function crossfadeWindow(cutFrame: number, durationFrames: number): { startFrame: number; endFrame: number } {
  return { startFrame: cutFrame - Math.floor(durationFrames / 2), endFrame: cutFrame + Math.ceil(durationFrames / 2) };
}
export function crossfadeWeight(frame: number, startFrame: number, durationFrames: number): number {
  return Math.max(0, Math.min(1, (frame - startFrame) / durationFrames));
}
export function transitionStill(clip: TimelineClip, artifacts: readonly ArtifactSidecar[]): boolean {
  if (clip.source.kind !== "artifact") return false;
  const id = clip.source.artifactId;
  return artifacts.some(artifact => artifact.id === id && (artifact.kind === "image" || artifact.kind === "board"));
}
function sourceKey(clip: TimelineClip): string { return clip.source.kind === "artifact" ? `artifact/${clip.source.artifactId}` : clip.source.kind; }
export interface PictureJoin extends TransitionPair { left: TimelineClip; right: TimelineClip; cutFrame: number; reason: string | null }
export function pictureJoins(tracks: readonly TimelineTrack[], isStill: (clip: TimelineClip) => boolean): PictureJoin[] {
  return tracks.filter(track => track.kind === "picture").flatMap(track => {
    const clips = [...track.clips].sort((a, b) => a.startFrame - b.startFrame);
    return clips.slice(1).map((right, index) => {
      const left = clips[index]!;
      return { trackId: track.id, leftClipId: left.id, rightClipId: right.id, left, right, cutFrame: right.startFrame,
        reason: left.startFrame + left.durationFrames !== right.startFrame ? "Gap between images" :
          !isStill(left) || !isStill(right) ? "Requires two still images" : null };
    });
  });
}
export function transitionJoin(tracks: readonly TimelineTrack[], pair: TransitionPair): PictureJoin | null {
  return pictureJoins(tracks, () => true).find(join => sameTransitionPair(join, pair) && join.reason === null) ?? null;
}
/** SPEC-054 R-3: neighboring retained windows bound each half; the cut itself never moves. */
export function maxCrossfadeFrames(tracks: readonly TimelineTrack[], transitions: readonly Crossfade[], pair: TransitionPair): number {
  const join = transitionJoin(tracks, pair);
  if (!join) return 0;
  let from = join.left.startFrame, to = join.right.startFrame + join.right.durationFrames;
  for (const neighbor of transitions) {
    if (neighbor.trackId !== pair.trackId || sameTransitionPair(neighbor, pair)) continue;
    const other = transitionJoin(tracks, neighbor);
    if (!other) continue;
    if (neighbor.leftSourceKey && neighbor.leftSourceKey !== sourceKey(other.left) || neighbor.rightSourceKey && neighbor.rightSourceKey !== sourceKey(other.right)) continue;
    const window = crossfadeWindow(other.cutFrame, neighbor.durationFrames);
    if (other.cutFrame < join.cutFrame) from = Math.max(from, window.endFrame);
    if (other.cutFrame > join.cutFrame) to = Math.min(to, window.startFrame);
  }
  return Math.max(0, Math.min(108000, 2 * (join.cutFrame - from) + 1, 2 * (to - join.cutFrame)));
}
export function transitionInactiveReason(tracks: readonly TimelineTrack[], transitions: readonly Crossfade[], value: Crossfade,
  isStill?: (clip: TimelineClip) => boolean): string | null {
  const join = transitionJoin(tracks, value);
  if (!join) return "Original images no longer touch";
  if (value.leftSourceKey && value.leftSourceKey !== sourceKey(join.left) || value.rightSourceKey && value.rightSourceKey !== sourceKey(join.right)) return "An original image source changed";
  if (isStill && (!isStill(join.left) || !isStill(join.right))) return "Original pair no longer contains two still images";
  if (value.durationFrames > maxCrossfadeFrames(tracks, transitions, value)) return "Blend exceeds the available space";
  return null;
}
export function applyTransitionCommand(tracks: readonly TimelineTrack[], transitions: readonly Crossfade[], command: TransitionCommand,
  authority: "human" | "suggestion", isStill?: (clip: TimelineClip) => boolean): Crossfade[] {
  const current = transitions.find(value => sameTransitionPair(value, command));
  const others = transitions.filter(value => !sameTransitionPair(value, command));
  if (command.kind === "transition-set") {
    const join = transitionJoin(tracks, command);
    if (!join || !isStill || !isStill(join.left) || !isStill(join.right)) throw new Error("Choose a boundary between two touching still images");
    if (authority === "suggestion" && current?.protectDuration && current.durationFrames !== command.durationFrames) throw new Error("Duration is protected; an explicit human release is required");
    const value: Crossfade = { trackId: command.trackId, leftClipId: command.leftClipId, rightClipId: command.rightClipId,
      type: "crossfade", durationFrames: command.durationFrames, protectJoin: current?.protectJoin ?? false, protectDuration: current?.protectDuration ?? false,
      leftSourceKey: current?.leftSourceKey ?? sourceKey(join.left), rightSourceKey: current?.rightSourceKey ?? sourceKey(join.right) };
    if (transitionInactiveReason(tracks, [], value)?.includes("source changed")) throw new Error("The original image source changed. Remove this inactive transition before adding one to the new pair.");
    // Batch bounds are checked on the final coherent result, allowing two neighboring fades to shrink together.
    return [...others, CrossfadeSchema.parse(value)].sort((a, b) => transitionKey(a).localeCompare(transitionKey(b)));
  }
  if (!current) throw new Error("This join has no transition");
  if (command.kind === "transition-remove") {
    if (authority === "suggestion" && (current.protectJoin || current.protectDuration)) throw new Error("This transition is protected");
    return others;
  }
  if (authority !== "human") throw new Error("Only a direct human action can change transition protection");
  return transitions.map(value => sameTransitionPair(value, command) ? { ...value,
    [command.setting === "join" ? "protectJoin" : "protectDuration"]: command.kind === "transition-protect" } : value);
}
export function transitionProtectionProblem(before: Pick<ProductionTimeline, "tracks" | "transitions">,
  after: Pick<ProductionTimeline, "tracks" | "transitions">): string | null {
  for (const value of before.transitions ?? []) {
    const next = after.transitions?.find(row => sameTransitionPair(row, value));
    if (value.protectJoin && (!next || !next.protectJoin || next.type !== value.type)) return "Transition join is protected";
    if (value.protectDuration && (!next || !next.protectDuration || next.durationFrames !== value.durationFrames)) return "Transition duration is protected";
    if ((value.protectJoin || value.protectDuration) && transitionJoin(before.tracks, value) && !transitionJoin(after.tracks, value)) return "The protected transition's original pair must remain adjacent";
    const original = transitionJoin(before.tracks, value), changed = transitionJoin(after.tracks, value);
    if ((value.protectJoin || value.protectDuration) && original && changed && (sourceKey(original.left) !== sourceKey(changed.left) || sourceKey(original.right) !== sourceKey(changed.right))) return "The protected transition's original images cannot be replaced";
  }
  return null;
}
export interface TransitionBatchRow { join: PictureJoin; status: "add" | "replace" | "keep" | "skip" | "shorten"; reason: string; durationFrames: number; command?: TransitionCommand }
export function planCrossfadeBatch(timeline: Pick<ProductionTimeline, "tracks" | "transitions" | "frameRate">, input: {
  durationFrames: number; scope: "all" | "selected" | "range"; selectedClipIds?: readonly string[]; from?: number; to?: number;
  replace: boolean; short: "review" | "accept" | "skip"; isStill: (clip: TimelineClip) => boolean;
}): TransitionBatchRow[] {
  const joins = pictureJoins(timeline.tracks, input.isStill).filter(join => input.scope === "all" || (input.scope === "selected"
    ? input.selectedClipIds?.includes(join.leftClipId) && input.selectedClipIds.includes(join.rightClipId)
    : join.cutFrame >= (input.from ?? 0) && join.cutFrame < (input.to ?? Infinity)));
  const existing = timeline.transitions ?? [];
  const rows: TransitionBatchRow[] = joins.map(join => {
    const value = existing.find(item => sameTransitionPair(item, join));
    const inactive = value ? transitionInactiveReason(timeline.tracks, existing, value, input.isStill) : null;
    const reason = join.reason ?? inactive ?? (value && !input.replace ? "Keep existing" : value?.protectDuration ? "Duration protected" : value?.durationFrames === input.durationFrames ? "Already this duration" : "");
    return { join, status: join.reason || inactive ? "skip" : reason ? "keep" : value ? "replace" : "add", reason, durationFrames: value?.durationFrames ?? input.durationFrames };
  });
  const targets = rows.filter(row => row.status === "add" || row.status === "replace");
  const retained = existing.filter(item => !targets.some(row => sameTransitionPair(row.join, item)));
  for (const row of targets) {
    let max = maxCrossfadeFrames(timeline.tracks, retained, row.join);
    // Reserve half of a shared middle image for each newly authored neighbor. Round shorter
    // choices to quarter seconds when possible, always showing the exact frames before Apply.
    if (targets.some(other => other !== row && other.join.rightClipId === row.join.leftClipId)) max = Math.min(max, row.join.left.durationFrames);
    if (targets.some(other => other !== row && other.join.leftClipId === row.join.rightClipId)) max = Math.min(max, row.join.right.durationFrames);
    row.durationFrames = input.durationFrames;
    if (input.durationFrames > max) {
      const step = Math.max(1, Math.round(timeline.frameRate / 4));
      row.durationFrames = Math.floor(max / step) * step || max;
      row.status = input.short === "skip" || max < 2 ? "skip" : "shorten";
      row.reason = max < 2 ? "No room for a blend" : input.short === "skip" ? "Short join skipped" : "Shorter duration needs acceptance";
    }
    if (row.status !== "skip" && (row.status !== "shorten" || input.short === "accept")) row.command = {
      kind: "transition-set", trackId: row.join.trackId, leftClipId: row.join.leftClipId, rightClipId: row.join.rightClipId, durationFrames: row.durationFrames };
  }
  return rows;
}
