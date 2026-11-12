import { containedPictureRect, pictureStackAtFrame, type EffectClip, type EffectRenderProjection, type ProductionTimeline } from "@arke-studio/contracts";
import type { EffectAuthoringProps } from "../lib/editor-effect-authoring.js";
import { EffectAreaOverlay } from "./editor-effect-area.js";
import { effectTargetLabel } from "./editor-effect-target.js";

type TargetArea = { ok: true; label: string; rect: { x: number; y: number; width: number; height: number }; clipId?: string }
  | { ok: false; reason: string };

/** Use the renderer's measured contain geometry; guessing a full-frame scoped target edits the wrong place. */
export function effectTargetAreaAtFrame(effect: EffectClip, timeline: ProductionTimeline, projection: EffectRenderProjection, absoluteFrame: number): TargetArea {
  const target = effect.target, label = effectTargetLabel(target, timeline);
  if (absoluteFrame < projection.startFrame || absoluteFrame >= projection.endFrame) return { ok: false, reason: `${label} is outside the current Picture delivery.` };
  if (target.kind === "composition") return { ok: true, label, rect: { x: 0, y: 0, width: 1, height: 1 } };
  const track = timeline.tracks.find(row => row.kind === "picture" && (target.kind === "picture-track" ? row.id === target.trackId : row.clips.some(clip => clip.id === target.clipId)));
  if (!track) return { ok: false, reason: `${label}. Choose a replacement visual target in Inspector.` };
  if (track.muted) return { ok: false, reason: `${label} is hidden. Its emitting area cannot be placed on the preview.` };
  const pictures = pictureStackAtFrame(projection, absoluteFrame).filter(row => row.kind === "media" && (target.kind === "picture-track" ? row.trackId === target.trackId : row.clipId === target.clipId));
  if (pictures.length === 0) return { ok: false, reason: `${label} has no visible picture at this frame. Seek to its picture or use the Inspector area controls.` };
  if (pictures.length !== 1) return { ok: false, reason: `${label} contains more than one visible picture. Select a visual clip to position its area precisely.` };
  const picture = pictures[0]!;
  if (!picture.path) return { ok: false, reason: `${picture.label} has no available picture source.` };
  if (!picture.sourceSize) return { ok: false, reason: `${picture.label}: picture dimensions are unavailable. Use the Inspector area controls until dimensions are known.` };
  try {
    const rect = containedPictureRect(picture.sourceSize.width, picture.sourceSize.height, projection.width, projection.height);
    return { ok: true, label: picture.label, clipId: picture.clipId, rect: { x: rect.x / projection.width, y: rect.y / projection.height, width: rect.width / projection.width, height: rect.height / projection.height } };
  } catch { return { ok: false, reason: `${picture.label}: picture dimensions are unavailable. Use the Inspector area controls until dimensions are known.` }; }
}

/** This child belongs inside EditorPicturePreview's contained stage, not the surrounding viewer. */
export function EffectTargetArea(props: EffectAuthoringProps & { projection: EffectRenderProjection; absoluteFrame: number }) {
  const target = effectTargetAreaAtFrame(props.effect, props.timeline, props.projection, props.absoluteFrame);
  if (!target.ok) return <span className="fx-target-area__unavailable" role="status">Emitting area unavailable · {target.reason}</span>;
  return <div className="fx-target-area" aria-label={`Emitting area for ${target.label}`} data-target-clip={target.clipId}
    style={{ left: `${target.rect.x * 100}%`, top: `${target.rect.y * 100}%`, width: `${target.rect.width * 100}%`, height: `${target.rect.height * 100}%` }}>
    <EffectAreaOverlay key={target.clipId ?? "composition"} {...props} />
  </div>;
}
