import { useMemo } from "react";
import { resolvePictureTimeline, sourceLengthFramesFor, trackEndFrame, timelineReviewMarks,
  type ConversationActionCard, type ProductionCardPreview, type ProductionTimeline, type ProductionBundle, type ResolvedPictureCut } from "@arke-studio/contracts";
import { useStore } from "../lib/store.js";
import { PictureTrack, pictureClipViews } from "../screens/editor-timeline.js";
import { TypedTrackRows } from "../screens/editor-audio.js";
import { SubtitleTrackRow } from "../screens/editor-subtitles.js";

const nothing = () => {};
const mint = () => "cl_readonly" as const;
export function ProductionTimelineCard({ preview, action }: { preview: Extract<ProductionCardPreview, { kind: "timeline" }>; action: ConversationActionCard }) {
  const world = useStore().state?.world;
  const production = world?.meta.worldId === action.worldId ? world.productions.find(p => p.meta.id === action.productionId) : undefined;
  const marks = useMemo(() => timelineReviewMarks(preview), [preview]);
  if (!world || !production) return null;
  const totalFrames = Math.max(1, ...[preview.before, preview.after].flatMap(t => t.tracks.map(track => trackEndFrame(track))), preview.range?.endFrame ?? 0);
  const range = preview.range;
  const version = (timeline: ProductionTimeline, selections: ProductionBundle["selections"], label: string, reviewMarks: ReadonlyMap<string, string>) => {
    const projected = { ...production, selections, timeline: { status: "ready" as const, timeline } };
    let cut: ResolvedPictureCut | null = null;
    try { cut = resolvePictureTimeline(projected, projected.timeline, world.artifacts); } catch { /* Unavailable media remains the native labelled gap. */ }
    const views = pictureClipViews(timeline, cut, world.artifacts);
    const sourceLength = sourceLengthFramesFor(projected, world.artifacts);
    return <section aria-label={`${label} timeline`} data-version={label.toLowerCase()}><h4>{label}</h4>
      <div className="fy-production-timeline__scroll" tabIndex={0}><div className="fy-production-timeline__tracks">
        <PictureTrack production={projected} artifacts={world.artifacts} timeline={timeline} views={views} slug={world.meta.slug} totalFrames={totalFrames}
          frameRate={timeline.frameRate} selectedClipId={null} onSelect={nothing} onCommands={nothing} onPreview={nothing}
          tool="select" playheadFrame={range?.startFrame ?? 0} disabled mintClipId={mint} sourceLength={sourceLength} reviewMarks={reviewMarks} />
        <TypedTrackRows production={projected} artifacts={world.artifacts} slug={world.meta.slug} timeline={timeline} totalFrames={totalFrames}
          frameRate={timeline.frameRate} selectedClipId={null} onSelect={nothing} onCommands={nothing} onPreview={nothing} disabled
          sourceLength={sourceLength} onDrop={nothing} playheadFrame={range?.startFrame ?? 0} mintClipId={mint} reviewMarks={reviewMarks} />
        {timeline.tracks.filter(track => track.kind === "subtitle").map(track => <SubtitleTrackRow key={track.id} track={track} totalFrames={totalFrames}
          frameRate={timeline.frameRate} production={projected} selectedCueId={null} onSelectCue={nothing} onCommands={nothing} disabled playheadFrame={range?.startFrame ?? 0} />)}
        {range && <div className="fy-production-timeline__range-lane"><div aria-label="Affected playhead range" className="fy-production-timeline__range" style={{ left: `${range.startFrame / totalFrames * 100}%`, width: `${(range.endFrame - range.startFrame) / totalFrames * 100}%` }} /></div>}
      </div></div>
    </section>;
  };
  return <div className="fy-production-timeline" aria-label="Timeline change preview">
    <p>{range ? `Frames ${range.startFrame}–${range.endFrame}` : "Track settings"} · {preview.after.frameRate} fps</p>
    {version(preview.before, preview.beforeSelections, "Before", marks.before)}
    {version(preview.after, preview.afterSelections, "After", marks.after)}
    <p>Inserted · changed · removed</p>
  </div>;
}
