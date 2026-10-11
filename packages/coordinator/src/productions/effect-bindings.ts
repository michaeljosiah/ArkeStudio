import { buildRenderPlan, defaultExportPreset, resolveProductionArtifact, TimelineOperationRefused, type ArtifactSidecar, type ProductionBundle, type ProductionTimeline, type TimelineClip } from "@arke-studio/contracts";

/** The same finite renderer profile fences direct authoring, prepared review and delivery. */
export function refuseUnsupportedEffectRender(timeline: ProductionTimeline, production: ProductionBundle, artifacts: readonly ArtifactSidecar[]): void {
  if (!timeline.tracks.some(track => track.effects?.length)) return;
  const planned = buildRenderPlan({ production, artifacts, timeline: { status: "ready", timeline },
    scope: { kind: "production" }, preset: defaultExportPreset(production.meta) });
  if (!planned.ok) throw new TimelineOperationRefused(planned.reason);
}

/**
 * Binding chooses a placed source, not an arbitrary file or another production's take. Existing
 * missing bindings remain authored so the editor can name them; only new/replaced audio choices
 * are validated here. Mute and gain are deliberately irrelevant to eligibility (SPEC-053 R-9–11).
 */
export function refuseUnknownEffectAudioBindings(before: ProductionTimeline, after: ProductionTimeline,
  production: ProductionBundle, artifacts: readonly ArtifactSidecar[]): void {
  const old = new Map(before.tracks.flatMap(track => (track.effects ?? []).map(effect => [effect.id, effect] as const)));
  const placed = new Map<string, TimelineClip>(after.tracks.flatMap(track => track.clips.map(clip => [clip.id, clip] as const)));
  const requireSound = (clip: TimelineClip, video: boolean): void => {
    const refuse = (): never => { throw new TimelineOperationRefused(`${clip.id} is not known to contain ${video ? "video sound" : "sound"}; choose a measured audio source`); };
    const source = clip.source;
    if (source.kind === "artifact") {
      const resolved = resolveProductionArtifact(artifacts, source.artifactId, production.meta.id);
      if (!resolved.ok) throw new TimelineOperationRefused(`${clip.id} cites ${resolved.reason}`);
      if ((!video && resolved.artifact.kind === "audio") || (resolved.artifact.kind === "video" && resolved.artifact.mediaInfo?.hasAudio === true)) return;
      refuse();
    }
    if (source.kind === "performance") {
      const performance = production.performances.find(value => value.id === source.performanceId);
      if (!video && performance?.file && performance.target.shotId === source.shotId && performance.provenance.outputHash === source.sourceHash) return;
      refuse();
    }
    const takeId = source.kind === "take" ? source.takeId : source.kind === "shot" ? production.selections[source.shotId]?.acceptedTakeId : undefined;
    const take = production.takes.find(value => value.id === takeId);
    const pass = take?.segment ? production.takes.find(value => value.id === take.segment!.passTakeId) : take;
    if (pass === undefined || pass.media === undefined) return refuse();
    if (!video && pass.kind === "voice") return;
    if (pass.kind === "clip" && production.takeMediaInfo[pass.id]?.mediaInfo.hasAudio === true) return;
    refuse();
  };
  for (const effect of after.tracks.flatMap(track => track.effects ?? [])) {
    const input = effect.audioInput;
    if (!input || JSON.stringify(old.get(effect.id)?.audioInput) === JSON.stringify(input)) continue;
    // A split retains a binding rather than choosing it again, including a source awaiting repair.
    if (!old.has(effect.id) && [...old.values()].some(previous => previous.lineageId === effect.lineageId && JSON.stringify(previous.audioInput) === JSON.stringify(input))) continue;
    if (input.kind === "composition-mix") continue;
    if (input.kind === "audio-track") {
      const track = after.tracks.find(value => value.id === input.trackId);
      if (!track) throw new TimelineOperationRefused(`Audio track ${input.trackId} is not on this timeline`);
      for (const clip of track.clips) requireSound(clip, false);
    } else {
      const clip = placed.get(input.clipId);
      if (!clip) throw new TimelineOperationRefused(`Audio source ${input.clipId} is not placed on this timeline`);
      requireSound(clip, input.kind === "video-sound");
    }
  }
}
