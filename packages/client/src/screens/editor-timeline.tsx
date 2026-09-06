import { useEffect, useState } from "react";
import {
  basePictureTrack,
  detachAudioCommands,
  type ArtifactSidecar,
  formatFrames,
  orderedTrackClips,
  type FrameRate,
  type ProductionBundle,
  type ProductionTimeline,
  type ResolvedPictureCut,
  type SourceLengthFrames,
  type TimelineClip,
  type TimelineClipCommand,
  type TimelineClipId,
} from "@arke-studio/contracts";
import { Portrait } from "../components/portrait.js";
import { cx } from "../components/ui.js";
import { posterize } from "../lib/poster.js";
import {
  clipAtFrame,
  frameAtPixel,
  framesFromDelta,
  pictureDragCommand,
  previewTimeline,
  type PictureGesture,
} from "../lib/picture-edit.js";
import { Film } from "../components/icons.js";
import { ARTIFACT_DRAG_TYPE, dragAccepts } from "./editor-audio.js";

/**
 * The Picture track as an editable sequence (SPEC-037 R-19..R-23, SPEC-039 R-13..R-18).
 *
 * Every gesture here reduces to one semantic command sent on release; the track never keeps a
 * timeline of its own. While a drag is in flight the preview is the pure algebra applied to the
 * live record, so what the hand sees is exactly what the coordinator will write — or, when the
 * algebra refuses, the untouched record, which is what the coordinator would leave.
 */

export type EditorTool = "select" | "blade" | "hand";

export const CLIP_MENU_WIDTH_PX = 232;
export const CLIP_MENU_HEIGHT_PX = 236;

export interface PictureClipView {
  clip: TimelineClip;
  label: string;
  /** World-relative poster path, or null when the clip has nothing to show. */
  poster: string | null;
  /** No accepted take resolves for this clip: it plays as a labelled gap. */
  gap: boolean;
  sceneNumber: number | null;
  shotId: string | null;
}

/** Join the base Picture track with what the resolver found for each clip. */
export function pictureClipViews(timeline: ProductionTimeline, cut: ResolvedPictureCut | null, artifacts: readonly ArtifactSidecar[] = []): PictureClipView[] {
  const base = basePictureTrack(timeline);
  if (base === null) return [];
  const played = (cut?.entries ?? []).filter((entry) => entry.hole !== true);
  const byClip = new Map(played.filter((entry) => entry.clipId !== undefined).map((entry) => [entry.clipId, entry] as const));
  // Before the first save the cut is the legacy derivation, which names shots and not clips; the
  // seeded record's clips are one per shot, so the shot is the join there.
  const byShot = new Map(played.map((entry) => [entry.shot.id, entry] as const));
  return orderedTrackClips(base).map((clip) => {
    const shotId = clip.source.kind === "shot" ? clip.source.shotId : null;
    const entry = byClip.get(clip.id) ?? (shotId !== null ? byShot.get(shotId) : undefined);
    const artifact = clip.source.kind === "artifact" ? artifacts.find(item => clip.source.kind === "artifact" && item.id === clip.source.artifactId) : undefined;
    const mediaPath = artifact ? `artifacts/${artifact.file}` : entry?.media?.path;
    return {
      clip,
      label: clip.source.kind === "shot"
        ? `${entry?.shot.title ?? clip.source.label}${mediaPath ? "" : " · no accepted take"}`
        : clip.source.label,
      // Imported videos have no take-directory frame.png; show their label until a poster exists.
      poster: artifact?.kind === "video" ? null : mediaPath ? posterize(mediaPath) : null,
      gap: !mediaPath,
      sceneNumber: clip.source.kind === "shot" ? clip.source.sceneNumber : null,
      shotId,
    };
  });
}

function describeClip(view: PictureClipView, frameRate: FrameRate): string {
  const { clip } = view;
  return `${view.label}, ${formatFrames(clip.startFrame, frameRate)} to ${formatFrames(clip.startFrame + clip.durationFrames, frameRate)}${view.gap ? ", gap" : ""}`;
}

export function PictureTrack({
  timeline,
  views,
  slug,
  totalFrames,
  frameRate,
  selectedClipId,
  onSelect,
  onCommands,
  onPreview,
  tool,
  playheadFrame,
  disabled,
  mintClipId,
  sourceLength,
  onDrop,
  onFileDrop,
}: {
  timeline: ProductionTimeline;
  views: readonly PictureClipView[];
  slug: string | undefined;
  totalFrames: number;
  frameRate: FrameRate;
  selectedClipId: string | null;
  onSelect: (clipId: TimelineClipId) => void;
  onCommands: (commands: TimelineClipCommand[], label?: string) => void;
  onPreview: (timeline: ProductionTimeline | null) => void;
  tool: EditorTool;
  playheadFrame: number;
  disabled: boolean;
  mintClipId: () => TimelineClipId;
  /** Measured source lengths, so a tail drag stops where the source does. */
  sourceLength: SourceLengthFrames;
  /** A picture from the Library dropped on the base track (R-10); absent while the record cannot be edited. */
  onDrop?: (drop: { artifactId: string; frame: number }) => void;
  onFileDrop?: (files: File[], frame: number) => void;
}) {
  const [menu, setMenu] = useState<{ clipId: TimelineClipId; x: number; y: number } | null>(null);
  const [over, setOver] = useState(false);
  const [refused, setRefused] = useState(false);
  const clips = views.map((view) => view.clip);

  useEffect(() => {
    if (menu === null) return;
    const close = () => setMenu(null);
    // Capture-phase, so a press a clip's own handler stops still closes the menu — but a press
    // inside the menu is the menu being used, and closing on it would unmount the item before
    // its click could fire.
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".fy-clipmenu")) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("pointerdown", closeOutside, { capture: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", closeOutside, { capture: true });
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, { capture: true });
    };
  }, [menu]);

  const span = Math.max(totalFrames, 1);
  const menuView = menu === null ? null : (views.find((view) => view.clip.id === menu.clipId) ?? null);
  const playheadInside = (clip: TimelineClip): boolean =>
    playheadFrame > clip.startFrame && playheadFrame < clip.startFrame + clip.durationFrames;

  /** The keyboard and menu path of every gesture: one command per action (R-23, SPEC-039 R-17). */
  const act = (clipId: TimelineClipId, action: "split" | "duplicate" | "delete" | "ripple" | "earlier" | "later"): void => {
    if (disabled) return;
    const clip = clips.find((candidate) => candidate.id === clipId);
    if (clip === undefined) return;
    switch (action) {
      case "split":
        if (!playheadInside(clip)) return;
        onCommands([{ kind: "split", clipId, atFrame: playheadFrame, newClipId: mintClipId() }], "Split at the playhead");
        return;
      case "duplicate":
        onCommands([{ kind: "duplicate", clipId, newClipId: mintClipId() }], "Duplicate clip");
        return;
      case "delete":
        onCommands([{ kind: "delete", clipId }], "Delete clip");
        return;
      case "ripple":
        onCommands([{ kind: "ripple-delete", clipId }], "Ripple delete clip");
        return;
      case "earlier":
      case "later":
        onCommands([{ kind: "move-adjacent", clipId, direction: action }], `Move clip ${action}`);
        return;
    }
  };

  const begin = (clipId: TimelineClipId, gesture: PictureGesture) => (event: React.PointerEvent) => {
    if (event.button !== 0 || disabled || tool !== "select") return;
    onSelect(clipId);
    event.preventDefault();
    event.stopPropagation();
    const element = event.currentTarget as HTMLElement;
    const lane = element.closest<HTMLElement>(".fy-track__lane");
    const laneWidth = lane?.getBoundingClientRect().width ?? 0;
    if (laneWidth <= 0) return;
    element.setPointerCapture(event.pointerId);
    const originX = event.clientX;
    let command: TimelineClipCommand | null = null;
    const move = (pointer: PointerEvent) => {
      const delta = framesFromDelta(pointer.clientX - originX, laneWidth, span);
      command = pictureDragCommand(clips, clipId, gesture, delta, sourceLength);
      onPreview(command === null ? null : previewTimeline(timeline, [command], sourceLength));
    };
    const finish = (pointer: PointerEvent) => {
      element.releasePointerCapture(pointer.pointerId);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", cancel);
      onPreview(null);
    };
    const up = (pointer: PointerEvent) => {
      finish(pointer);
      // A click that only selected sends nothing: a write with no change is not an edit.
      if (command !== null && previewTimeline(timeline, [command], sourceLength) !== null) {
        onCommands([command], gesture === "move" ? "Move clip" : `Trim clip ${gesture === "trim-start" ? "head" : "tail"}`);
      }
    };
    // A gesture the browser took away — a touch the OS claimed, capture lost — was never
    // completed, so it writes nothing: the preview clears and the record stays as it was.
    const cancel = (pointer: PointerEvent) => finish(pointer);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", cancel);
  };

  const onLanePointerDown = (event: React.PointerEvent) => {
    if (tool !== "hand" || event.button !== 0) return;
    const canvas = (event.currentTarget as HTMLElement).closest<HTMLElement>(".fy-timeline__canvas");
    if (canvas === null) return;
    event.preventDefault();
    const element = event.currentTarget as HTMLElement;
    element.setPointerCapture(event.pointerId);
    let lastX = event.clientX;
    const move = (pointer: PointerEvent) => {
      canvas.scrollLeft -= pointer.clientX - lastX;
      lastX = pointer.clientX;
    };
    const up = (pointer: PointerEvent) => {
      element.releasePointerCapture(pointer.pointerId);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
  };

  const blade = (clipId: TimelineClipId) => (event: React.MouseEvent) => {
    if (tool !== "blade" || disabled) return;
    event.stopPropagation();
    const lane = (event.currentTarget as HTMLElement).closest<HTMLElement>(".fy-track__lane");
    if (lane === null) return;
    const box = lane.getBoundingClientRect();
    const frame = frameAtPixel(event.clientX - box.left, box.width, span);
    const clip = clips.find((candidate) => candidate.id === clipId);
    if (clip === undefined || frame <= clip.startFrame || frame >= clip.startFrame + clip.durationFrames) return;
    onSelect(clipId);
    onCommands([{ kind: "split", clipId, atFrame: frame, newClipId: mintClipId() }], "Split clip");
  };

  const onClipKeyDown = (clipId: TimelineClipId) => (event: React.KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const key = event.key;
    if (key === "Delete" || key === "Backspace") act(clipId, event.shiftKey ? "ripple" : "delete");
    else if (key === "[") act(clipId, "earlier");
    else if (key === "]") act(clipId, "later");
    else if (key === "s" || key === "S") act(clipId, "split");
    else if (key === "d" || key === "D") act(clipId, "duplicate");
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="fy-track" data-track="picture">
      <span className="fy-track__label">
        <span className="fy-track__icon" aria-hidden="true"><Film size={11} /></span>
        <span className="fy-track__name">Picture</span>
      </span>
      <div
        className={cx("fy-track__lane", "fy-pictlane", over && "fy-typedlane--over", refused && "fy-typedlane--refuse", tool === "hand" && "fy-pictlane--hand", tool === "blade" && "fy-pictlane--blade")}
        onPointerDown={onLanePointerDown}
        onDragOver={(event) => {
          if (!disabled && onFileDrop && Array.from(event.dataTransfer.types).includes("Files")) {
            event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setOver(true); return;
          }
          if (onDrop === undefined || disabled) return;
          if (!dragAccepts(event.dataTransfer.types, false)) {
            event.dataTransfer.dropEffect = "none";
            setRefused(true);
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setOver(true);
        }}
        onDragLeave={() => {
          setOver(false);
          setRefused(false);
        }}
        onDrop={(event) => {
          if (event.dataTransfer.files?.length) {
            event.preventDefault(); event.stopPropagation(); setOver(false);
            if (!disabled && onFileDrop) {
              const box = event.currentTarget.getBoundingClientRect();
              onFileDrop(Array.from(event.dataTransfer.files), frameAtPixel(event.clientX - box.left, box.width, span));
            }
            return;
          }
          if (onDrop === undefined) return;
          event.preventDefault();
          setOver(false);
          setRefused(false);
          const artifactId = event.dataTransfer.getData(ARTIFACT_DRAG_TYPE);
          if (!artifactId || disabled) return;
          const box = event.currentTarget.getBoundingClientRect();
          onDrop({ artifactId, frame: frameAtPixel(event.clientX - box.left, box.width, span) });
        }}
      >
        {views.length === 0 && !refused && <span className="fy-track__empty">{onDrop === undefined ? "No picture yet" : "drop a picture here, or add a scene from the Library"}</span>}
        {refused && <span className="fy-track__refuse">picture lanes take picture</span>}
        {views.map((view) => {
          const { clip } = view;
          const selected = clip.id === selectedClipId;
          return (
            <button
              key={clip.id}
              type="button"
              data-clip={clip.id}
              className={cx(
                "fy-cutseg",
                "fy-pictclip",
                view.gap ? "fy-cutseg--gap fy-cutseg--gap-warn" : "fy-cutseg--pick",
                selected && "fy-cutseg--selected",
              )}
              style={{
                left: `${(clip.startFrame / span) * 100}%`,
                width: `${Math.max((clip.durationFrames / span) * 100, 0.6)}%`,
              }}
              aria-pressed={selected}
              aria-label={describeClip(view, frameRate)}
              title={describeClip(view, frameRate)}
              disabled={disabled}
              onClick={(event) => {
                if (tool === "blade") {
                  blade(clip.id)(event);
                  return;
                }
                onSelect(clip.id);
              }}
              onPointerDown={begin(clip.id, "move")}
              onKeyDown={onClipKeyDown(clip.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                onSelect(clip.id);
                setMenu({ clipId: clip.id, x: event.clientX, y: event.clientY });
              }}
            >
              <span className="fy-pictclip__grip fy-pictclip__grip--start" onPointerDown={begin(clip.id, "trim-start")} aria-hidden="true" />
              {view.gap ? (
                <span className="fy-pictclip__gap">{view.label}</span>
              ) : (
                <>
                  {view.poster === null
                    ? <div className="fy-portrait--fallback"><Film size={18} /></div>
                    : <Portrait worldSlug={slug} path={view.poster} label={view.label} radius={0} />}
                  <span className="fy-cutseg__tag">{view.label.replace(/^shot /, "")}</span>
                </>
              )}
              <span className="fy-pictclip__grip fy-pictclip__grip--end" onPointerDown={begin(clip.id, "trim-end")} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      {menu !== null && menuView !== null && (
        <div
          className="fy-clipmenu"
          role="menu"
          aria-label={`Actions for ${menuView.label}`}
          style={{
            left: Math.min(menu.x, Math.max(0, window.innerWidth - CLIP_MENU_WIDTH_PX - 8)),
            top: Math.min(menu.y, Math.max(0, window.innerHeight - CLIP_MENU_HEIGHT_PX - 8)),
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {(
            [
              ["split", "Split at playhead", !playheadInside(menuView.clip)],
              ["duplicate", "Duplicate", false],
              ["earlier", "Move earlier", views[0]?.clip.id === menu.clipId],
              ["later", "Move later", views[views.length - 1]?.clip.id === menu.clipId],
              ["delete", "Delete", false],
              ["ripple", "Ripple delete", false],
            ] as const
          ).map(([action, label, off]) => (
            <button
              key={action}
              type="button"
              role="menuitem"
              className="fy-clipmenu__item"
              disabled={off}
              onClick={() => {
                act(menu.clipId, action);
                setMenu(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Frame steppers: the keyboard path of a trim drag (R-23), one command per press. */
function FrameStepper({
  label,
  value,
  frameRate,
  onStep,
  disabled,
}: {
  label: string;
  value: number;
  frameRate: FrameRate;
  onStep: (deltaFrames: number) => void;
  disabled: boolean;
}) {
  return (
    <div className="fy-cutinspect__row fy-framestep">
      <span>{label}</span>
      <strong>
        <button type="button" className="fy-trim__step" aria-label={`${label} one frame earlier`} disabled={disabled} onClick={() => onStep(-1)}>
          −
        </button>
        <span className="fy-mono">{formatFrames(value, frameRate)}</span>
        <button type="button" className="fy-trim__step" aria-label={`${label} one frame later`} disabled={disabled} onClick={() => onStep(1)}>
          +
        </button>
      </strong>
    </div>
  );
}

/** The immutable candidates for one shot, with their append-only review state (SPEC-039 R-22). */
export function TakePicker({
  production,
  shotId,
  disabled,
  onSwitch,
}: {
  production: ProductionBundle;
  shotId: string;
  disabled: boolean;
  onSwitch: (takeId: string) => void;
}) {
  const current = production.selections[shotId]?.acceptedTakeId ?? null;
  const candidates = production.takes.filter(
    (take) =>
      take.kind === "clip" &&
      take.coversShots.includes(shotId) &&
      take.boardSheetParent !== true &&
      !(take.segment === undefined && take.coversShots.length > 1),
  );
  const decisionFor = (takeId: string): string | null => {
    const decision = [...production.reviews].reverse().find((review) => review.takeId === takeId);
    return decision === null || decision === undefined ? null : decision.decision === "accept" ? "accepted" : "rejected";
  };
  return (
    <div className="fy-takepick" aria-label="Takes">
      <div className="fy-cutinspect__eyebrow">TAKES · {candidates.length}</div>
      {candidates.length === 0 && <p className="fy-cutinspect__note">No footage covers this shot yet.</p>}
      {candidates.map((take) => {
        const inUse = take.id === current;
        const decision = decisionFor(take.id);
        return (
          <div key={take.id} className={cx("fy-takepick__row", inUse && "fy-takepick__row--current")}>
            <span className="fy-takepick__id">{take.id.slice(-6)}</span>
            <span className="fy-mono">
              {take.model}
              {decision === null ? "" : ` · ${decision}`}
              {inUse ? " · in the cut" : ""}
            </span>
            <span className="fy-h1row__push" />
            <button
              type="button"
              className="fy-takepick__use"
              disabled={disabled || inUse}
              aria-pressed={inUse}
              onClick={() => onSwitch(take.id)}
            >
              {inUse ? "In use" : "Use"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** A Picture clip's timing, as the target Inspector states it and as the keyboard trims it. */
export function PictureClipTiming({
  clip,
  frameRate,
  disabled,
  onCommands,
}: {
  clip: TimelineClip;
  frameRate: FrameRate;
  disabled: boolean;
  onCommands: (commands: TimelineClipCommand[], label?: string) => void;
}) {
  const end = clip.startFrame + clip.durationFrames;
  return (
    <div className="fy-cutinspect__rows">
      <FrameStepper label="Position" value={clip.startFrame} frameRate={frameRate} disabled={disabled}
        onStep={delta => onCommands([{ kind: "move-to-frame", clipId: clip.id, startFrame: Math.max(0, clip.startFrame + delta) }], "Move clip")} />
      <FrameStepper
        label="In"
        value={clip.startFrame}
        frameRate={frameRate}
        disabled={disabled}
        onStep={(delta) => onCommands([{ kind: "trim", clipId: clip.id, edge: "start", deltaFrames: delta }], "Trim clip head")}
      />
      <FrameStepper
        label="Out"
        value={end}
        frameRate={frameRate}
        disabled={disabled}
        onStep={(delta) => onCommands([{ kind: "trim", clipId: clip.id, edge: "end", deltaFrames: delta }], "Trim clip tail")}
      />
      <div className="fy-cutinspect__row">
        <span>Duration</span>
        <strong>{formatFrames(clip.durationFrames, frameRate)}</strong>
      </div>
      <div className="fy-cutinspect__row">
        <span>Source in</span>
        <strong>{formatFrames(clip.sourceInFrames, frameRate)}</strong>
      </div>
    </div>
  );
}

export { clipAtFrame };

export function DetachAudio({ production, timeline, artifacts, clip, disabled, onCommands, mintClipId }: {
  production: ProductionBundle; timeline: ProductionTimeline; artifacts: readonly ArtifactSidecar[];
  clip: TimelineClip; disabled: boolean; onCommands: (commands: TimelineClipCommand[], label?: string) => void;
  mintClipId: () => TimelineClipId;
}) {
  let reason: string | null = null;
  try { detachAudioCommands(production, timeline, artifacts, clip.id, "cl_detach-preview"); }
  catch (error) { reason = error instanceof Error ? error.message : String(error); }
  return <div className="fy-cutinspect__rows">
    <button type="button" className="fy-tlbtn fy-tlbtn--text" disabled={disabled || reason !== null}
      onClick={() => onCommands([{ kind: "detach-audio", clipId: clip.id, newClipId: mintClipId() }], "Detach audio")}>Detach audio</button>
    {reason && <p className="fy-cutinspect__note">{reason}</p>}
  </div>;
}
