import { useEffect, useRef, useState } from "react";
import { ClipMenu, ExtractAudioMenuItem } from "./editor-clip-menu.js";
import {
  artifactPicturePath,
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
import { mediaUrl } from "../lib/media.js";
import { FILMSTRIP_HEIGHT_PX, useFilmstrip } from "../lib/filmstrip.js";
import {
  clipAtFrame,
  frameAtPixel,
  pictureDragCommand,
  previewTimeline,
  timingEntryCommand,
  type PictureGesture,
  type TimingField,
} from "../lib/picture-edit.js";
import { fileKindsFromTransfer, laneTakesFiles, reorderPreview, type DroppedKind } from "../lib/clip-gesture.js";
import { Film } from "../components/icons.js";
import { startClipGesture, type GestureUpdate } from "./editor-gesture.js";
import { DropTarget, GestureChip, chipSeconds } from "./editor-marks.js";
import { ARTIFACT_DRAG_TYPE, dragAccepts, libraryDrag } from "./editor-audio.js";

/**
 * The Picture track as an editable sequence (SPEC-037 R-19..R-23, SPEC-039 R-13..R-18).
 *
 * Every gesture here reduces to one semantic command sent on release; the track never keeps a
 * timeline of its own. A trim is previewed by applying the algebra to the live record, so what
 * the hand sees is exactly what the coordinator will write. A move is different (issue 1034):
 * the record is untouched until release, the clip itself travels with the hand, and the slot
 * the reorder will put it in is drawn — because previewing a reorder by applying it showed a
 * jump where the reference shows a drag.
 */

export type EditorTool = "select" | "blade" | "hand";

export interface PictureClipView {
  clip: TimelineClip;
  label: string;
  /** World-relative poster path, or null when the clip has nothing to show. */
  poster: string | null;
  /** The footage behind the clip, for a strip of frames across it; null for a still or a gap. */
  footage: { path: string; inSec: number } | null;
  /** No accepted take resolves for this clip: it plays as a labelled gap. */
  gap: boolean;
  sceneNumber: number | null;
  shotId: string | null;
}

/** Join the base Picture track with what the resolver found for each clip. */
export function pictureClipViews(
  timeline: ProductionTimeline,
  cut: ResolvedPictureCut | null,
  artifacts: readonly ArtifactSidecar[] = [],
  /** The name a placed file is known by (issue 1005); the record's label is the file name. */
  nameOf: (artifact: ArtifactSidecar) => string = (artifact) => artifact.file.split("/").pop() ?? artifact.file,
): PictureClipView[] {
  const base = basePictureTrack(timeline);
  if (base === null) return [];
  const frameRate = timeline.frameRate;
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
    const still = artifact !== undefined && artifact.kind !== "video";
    return {
      clip,
      label: clip.source.kind === "shot"
        ? `${entry?.shot.title ?? clip.source.label}${mediaPath ? "" : " · no accepted take"}`
        : artifact ? nameOf(artifact) : clip.source.label,
      // A placed file's picture is its poster or itself (issue 1037); a take's is the frame beside it.
      poster: artifact ? artifactPicturePath(artifact) : mediaPath ? posterize(mediaPath) : null,
      // The resolver's in-point already carries the clip's own source offset (contracts
      // `resolvePictureTimeline`); only the legacy derivation, which knows shots and not clips,
      // leaves the offset to be added here.
      footage: mediaPath && !still
        ? { path: mediaPath, inSec: entry?.media?.inSec ?? clip.sourceInFrames / frameRate }
        : null,
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

/**
 * A clip's width on screen, kept current as the lane resizes and the zoom changes. The strip
 * asks for as many frames as fit, so the number is measured rather than derived from a
 * percentage nobody has turned into pixels yet.
 */
function useMeasuredWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const read = () => setWidth(Math.round(element.getBoundingClientRect().width));
    read();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** Frames across a video clip (issue 1037), over its poster until each one has decoded. */
export function Filmstrip({ slug, footage, durationSec, widthPx, heightPx = FILMSTRIP_HEIGHT_PX }: {
  slug: string | undefined;
  footage: { path: string; inSec: number } | null;
  durationSec: number;
  widthPx: number;
  heightPx?: number;
}) {
  const src = footage !== null && slug !== undefined ? mediaUrl(slug, footage.path) : null;
  const frames = useFilmstrip({ src, inSec: footage?.inSec ?? 0, durationSec, widthPx, heightPx });
  if (frames.every((frame) => frame === null)) return null;
  return (
    <span className="fy-filmstrip" aria-hidden="true" data-frames={frames.filter((frame) => frame !== null).length}>
      {frames.map((frame, index) => (
        <span key={index} className="fy-filmstrip__frame" style={{ width: `${100 / frames.length}%` }}>
          {frame !== null && <img src={frame} alt="" draggable={false} />}
        </span>
      ))}
    </span>
  );
}

/** One clip on the sequence: its picture, its strip, its two handles and its tag. */
function PictureClip({ view, slug, frameRate, style, className, children, ...rest }: {
  view: PictureClipView;
  slug: string | undefined;
  frameRate: FrameRate;
  style: React.CSSProperties;
  className: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "style" | "className">) {
  const ref = useRef<HTMLButtonElement>(null);
  const width = useMeasuredWidth(ref);
  // A poster that never arrives — a build with no ffmpeg draws none — leaves the kind's mark, not
  // an empty frame with a name on it. Remembered per picture, so a shot that gains a frame, or a
  // clip whose picture changes, asks again.
  const [missingFor, setMissingFor] = useState<string | null>(null);
  const pictureKey = `${slug ?? ""}|${view.poster ?? ""}`;
  const posterMissing = view.poster !== null && missingFor === pictureKey;
  return (
    <button ref={ref} type="button" className={className} style={style} data-in-sec={view.footage?.inSec} {...rest}>
      {children}
      {view.gap ? (
        <span className="fy-pictclip__gap">{view.label}</span>
      ) : (
        <>
          {view.poster === null || posterMissing
            ? <div className="fy-portrait--fallback"><Film size={18} /></div>
            : <Portrait worldSlug={slug} path={view.poster} label="" radius={0} onAvailabilityChange={(available) => setMissingFor(available ? null : pictureKey)} />}
          <Filmstrip slug={slug} footage={view.footage} durationSec={view.clip.durationFrames / frameRate} widthPx={width} />
          <span className="fy-cutseg__tag">{view.label.replace(/^shot /, "")}</span>
        </>
      )}
    </button>
  );
}

export function PictureTrack({
  production,
  artifacts,
  timeline,
  views,
  slug,
  totalFrames,
  frameRate,
  selectedClipId,
  onSelect,
  onCommands,
  onPreview,
  onScrub,
  tool,
  playheadFrame,
  disabled,
  mintClipId,
  sourceLength,
  snapFrames = null,
  fileKinds = null,
  pendingSlot = null,
  onDrop,
  onFileDrop,
}: {
  production?: ProductionBundle;
  artifacts?: readonly ArtifactSidecar[];
  timeline: ProductionTimeline;
  views: readonly PictureClipView[];
  slug: string | undefined;
  totalFrames: number;
  frameRate: FrameRate;
  selectedClipId: string | null;
  onSelect: (clipId: TimelineClipId) => void;
  onCommands: (commands: TimelineClipCommand[], label?: string) => void;
  onPreview: (timeline: ProductionTimeline | null) => void;
  /** Bring the viewer to a frame while an edge moves, and park it there on release (issue 1036). */
  onScrub?: (frame: number) => void;
  tool: EditorTool;
  playheadFrame: number;
  disabled: boolean;
  mintClipId: () => TimelineClipId;
  /** Measured source lengths, so a tail drag stops where the source does. */
  sourceLength: SourceLengthFrames;
  /** Frames an edge may snap onto while Snap is on, for the clip in hand; null when Snap is off. */
  snapFrames?: ((except: TimelineClipId) => readonly number[]) | null;
  /** What desktop files are over the window right now, for the lane to say what a drop will do. */
  fileKinds?: readonly DroppedKind[] | null;
  /** A drop that is being imported: its slot is drawn until the clip is real. */
  pendingSlot?: { frame: number; label: string } | null;
  /** A picture from the Library dropped on the base track (R-10); absent while the record cannot be edited. */
  onDrop?: (drop: { artifactId: string; frame: number }) => void;
  onFileDrop?: (files: File[], frame: number) => void;
}) {
  const [menu, setMenu] = useState<{ clipId: TimelineClipId; x: number; y: number } | null>(null);
  const [hover, setHover] = useState<{ frame: number; refused: boolean; files: boolean } | null>(null);
  const [drag, setDrag] = useState<GestureUpdate | null>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const clips = views.map((view) => view.clip);
  // A drag that ends on another lane, or outside the window, fires no dragleave here.
  useEffect(() => {
    const clear = () => setHover(null);
    window.addEventListener("drop", clear);
    window.addEventListener("dragend", clear);
    return () => {
      window.removeEventListener("drop", clear);
      window.removeEventListener("dragend", clear);
    };
  }, []);

  const span = Math.max(totalFrames, 1);
  const menuView = menu === null ? null : (views.find((view) => view.clip.id === menu.clipId) ?? null);
  const playheadInside = (clip: TimelineClip): boolean =>
    playheadFrame > clip.startFrame && playheadFrame < clip.startFrame + clip.durationFrames;
  const percent = (frames: number): string => `${(frames / span) * 100}%`;

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

  /*
   * A press begins a gesture on the shared engine (issue 1034). A trim previews the algebra's
   * answer on the record and scrubs the viewer to the edge in hand; a move leaves the record
   * alone, follows the hand with the clip, and draws the slot the reorder will use.
   */
  const begin = (clipId: TimelineClipId, gesture: PictureGesture) => (event: React.PointerEvent) => {
    if (event.button !== 0 || disabled || tool !== "select") return;
    onSelect(clipId);
    const clip = clips.find((candidate) => candidate.id === clipId);
    const element = event.currentTarget as HTMLElement;
    const lane = element.closest<HTMLElement>(".fy-track__lane");
    if (clip === undefined || lane === null) return;
    let command: TimelineClipCommand | null = null;
    let lastScrub: number | null = null;
    const scrub = (frame: number) => {
      const clamped = Math.max(0, Math.min(span, frame));
      if (clamped === lastScrub) return;
      lastScrub = clamped;
      onScrub?.(clamped);
    };
    startClipGesture({
      event,
      lane,
      canvas: lane.closest<HTMLElement>(".fy-timeline__canvas"),
      totalFrames: span,
      clip,
      gesture,
      // The clip's own edges are left out, or a small move would stick where it started.
      snapFrames: snapFrames === null ? null : snapFrames(clipId),
      onUpdate: (update) => {
        if (gesture === "move") {
          setDrag(update);
          return;
        }
        command = pictureDragCommand(clips, clipId, gesture, update.deltaFrames, sourceLength);
        onPreview(command === null ? null : previewTimeline(timeline, [command], sourceLength));
        setDrag(update);
        // The frame at the edge in hand, in the record as it stands: a head trim shows its new
        // first frame, a tail trim its new last one. The source frame is the same either way,
        // so the viewer's committed spans answer without a draft.
        const delta = command !== null && command.kind === "trim" ? command.deltaFrames : 0;
        scrub(gesture === "trim-start" ? clip.startFrame + delta : clip.startFrame + clip.durationFrames + delta - 1);
      },
      onEnd: (final) => {
        setDrag(null);
        onPreview(null);
        if (final === null) return;
        if (gesture === "move") {
          const move = pictureDragCommand(clips, clipId, "move", final.deltaFrames, sourceLength);
          if (move !== null && previewTimeline(timeline, [move], sourceLength) !== null) onCommands([move], "Move clip");
          return;
        }
        // From the release itself, not the last move: the pointer can land elsewhere between
        // the two, and Alt can change what snaps. A click that only selected sends nothing.
        const trim = pictureDragCommand(clips, clipId, gesture, final.deltaFrames, sourceLength);
        if (trim !== null && previewTimeline(timeline, [trim], sourceLength) !== null) {
          onCommands([trim], `Trim clip ${gesture === "trim-start" ? "head" : "tail"}`);
          // Parked on the edge the cut now has, where the reference leaves it.
          const delta = trim.kind === "trim" ? trim.deltaFrames : 0;
          onScrub?.(gesture === "trim-start" ? clip.startFrame + delta : Math.max(clip.startFrame, clip.startFrame + clip.durationFrames + delta - 1));
        }
      },
    });
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
    if (event.altKey || event.ctrlKey || event.metaKey || disabled) return;
    const key = event.key;
    if (key === "ContextMenu" || (key === "F10" && event.shiftKey)) {
      const box = event.currentTarget.getBoundingClientRect();
      onSelect(clipId); setMenu({ clipId, x: box.left, y: box.bottom });
      event.preventDefault(); event.stopPropagation(); return;
    }
    if (key === "Delete" || key === "Backspace") act(clipId, event.shiftKey ? "ripple" : "delete");
    else if (key === "[") act(clipId, "earlier");
    else if (key === "]") act(clipId, "later");
    else if (key === "s" || key === "S") act(clipId, "split");
    else if (key === "d" || key === "D") act(clipId, "duplicate");
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  /** Where the pointer is over the lane, in frames. */
  const frameUnder = (event: React.DragEvent): number => {
    const box = event.currentTarget.getBoundingClientRect();
    return frameAtPixel(event.clientX - box.left, box.width, span);
  };
  const hoverAt = (frame: number, refused: boolean, files: boolean) =>
    setHover((current) => (current !== null && current.frame === frame && current.refused === refused && current.files === files ? current : { frame, refused, files }));

  // The slot a move will land in, and how far each neighbour slides to open it.
  const reorder = drag !== null && drag.gesture === "move" ? reorderPreview(clips, drag.clipId, drag.deltaFrames) : null;
  const dragged = drag === null ? null : (clips.find((clip) => clip.id === drag.clipId) ?? null);
  const dragging = drag !== null && dragged !== null;
  const ghostStart = dragging && drag.gesture === "move" ? Math.max(0, Math.min(span - dragged.durationFrames, dragged.startFrame + drag.deltaFrames)) : null;
  // What the trim chip states: the edge in hand and the length the clip will have.
  const trimmed = dragging && drag.gesture !== "move" ? views.find((view) => view.clip.id === drag.clipId)?.clip ?? null : null;
  const libraryHover = hover !== null && !hover.files ? libraryDrag() : null;
  const fileHover = hover !== null && hover.files;
  const filesOver = fileKinds !== null && fileKinds.length > 0;

  return (
    <div className="fy-track" data-track="picture">
      <span className="fy-track__label">
        <span className="fy-track__icon" aria-hidden="true"><Film size={11} /></span>
        <span className="fy-track__name">Picture</span>
      </span>
      <div
        ref={laneRef}
        className={cx(
          "fy-track__lane",
          "fy-pictlane",
          hover !== null && !hover.refused && "fy-lane--over",
          hover !== null && hover.refused && "fy-lane--refused",
          filesOver && !disabled && onFileDrop && "fy-lane--files",
          dragging && "fy-pictlane--dragging",
          tool === "hand" && "fy-pictlane--hand",
          tool === "blade" && "fy-pictlane--blade",
        )}
        data-dropping={filesOver && !disabled && onFileDrop ? "true" : undefined}
        onPointerDown={onLanePointerDown}
        onDragOver={(event) => {
          const kinds = fileKindsFromTransfer(event.dataTransfer);
          if (kinds.length > 0) {
            if (disabled || !onFileDrop) return;
            event.preventDefault();
            // Sound has no picture to put here (SPEC-043 R-3); anything else lands, and a file
            // the browser cannot name is read by the import and refused there if it must be.
            const refused = !laneTakesFiles(kinds, false);
            event.dataTransfer.dropEffect = refused ? "none" : "copy";
            hoverAt(frameUnder(event), refused, true);
            return;
          }
          if (onDrop === undefined || disabled) return;
          if (!dragAccepts(event.dataTransfer.types, false)) {
            event.dataTransfer.dropEffect = "none";
            hoverAt(frameUnder(event), true, false);
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          hoverAt(frameUnder(event), false, false);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setHover(null);
        }}
        onDrop={(event) => {
          setHover(null);
          if (event.dataTransfer.files?.length) {
            event.preventDefault(); event.stopPropagation();
            if (!disabled && onFileDrop && laneTakesFiles(fileKindsFromTransfer(event.dataTransfer), false)) {
              onFileDrop(Array.from(event.dataTransfer.files), frameUnder(event));
            }
            return;
          }
          if (onDrop === undefined) return;
          event.preventDefault();
          const artifactId = event.dataTransfer.getData(ARTIFACT_DRAG_TYPE);
          if (!artifactId || disabled) return;
          onDrop({ artifactId, frame: frameUnder(event) });
        }}
      >
        {views.length === 0 && hover === null && pendingSlot === null && (
          <span className="fy-track__empty">
            {filesOver && onFileDrop && !disabled ? "Drop to add · Picture" : onDrop === undefined ? "No picture yet" : "drop a picture here, or add from the Library"}
          </span>
        )}
        {hover !== null && hover.refused && <span className="fy-track__refuse">picture lanes take picture</span>}
        {hover !== null && !hover.refused && (
          <DropTarget
            frame={hover.frame}
            span={span}
            frameRate={frameRate}
            widthFrames={libraryHover?.durationFrames ?? null}
            label={fileHover ? "Drop to add · Picture" : `Drop ${libraryHover?.label ?? "here"} · Picture`}
          />
        )}
        {pendingSlot !== null && (
          <span className="fy-landing fy-landing--pending" style={{ left: percent(pendingSlot.frame), width: percent(Math.max(1, Math.round(span / 10))) }} data-testid="pending-slot">
            <span className="fy-landing__label">{pendingSlot.label} · importing…</span>
          </span>
        )}
        {reorder !== null && dragged !== null && reorder.index !== reorder.from && (
          <span className="fy-slot" style={{ left: percent(reorder.slotStartFrame), width: percent(dragged.durationFrames) }} data-testid="drop-slot" aria-hidden="true" />
        )}
        {drag !== null && drag.snappedTo !== null && (
          <span className="fy-snapline" style={{ left: percent(drag.snappedTo) }} data-testid="snap-line" aria-hidden="true" />
        )}
        {views.map((view) => {
          const { clip } = view;
          const selected = clip.id === selectedClipId;
          const isGhost = dragging && drag.gesture === "move" && clip.id === drag.clipId;
          const shift = reorder?.shifts.get(clip.id) ?? 0;
          const left = isGhost && ghostStart !== null ? ghostStart : clip.startFrame + shift;
          return (
            <PictureClip
              key={clip.id}
              view={view}
              slug={slug}
              frameRate={frameRate}
              data-clip={clip.id}
              className={cx(
                "fy-cutseg",
                "fy-pictclip",
                view.gap ? "fy-cutseg--gap fy-cutseg--gap-warn" : "fy-cutseg--pick",
                selected && "fy-cutseg--selected",
                isGhost && "fy-pictclip--ghost",
                shift !== 0 && "fy-pictclip--shifted",
              )}
              style={{
                left: percent(left),
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
                event.stopPropagation();
                if (disabled) return;
                event.currentTarget.focus({ preventScroll: true });
                onSelect(clip.id);
                setMenu({ clipId: clip.id, x: event.clientX, y: event.clientY });
              }}
            >
              <span className="fy-pictclip__grip fy-pictclip__grip--start" onPointerDown={begin(clip.id, "trim-start")} aria-hidden="true"><i /></span>
              <span className="fy-pictclip__grip fy-pictclip__grip--end" onPointerDown={begin(clip.id, "trim-end")} aria-hidden="true"><i /></span>
            </PictureClip>
          );
        })}
        {dragging && drag.gesture === "move" && reorder !== null && (
          <GestureChip x={drag.pointerX} frame={reorder.slotStartFrame} frameRate={frameRate} />
        )}
        {dragging && drag.gesture !== "move" && trimmed !== null && (
          <GestureChip
            x={drag.pointerX}
            frame={drag.gesture === "trim-start" ? trimmed.startFrame : trimmed.startFrame + trimmed.durationFrames}
            frameRate={frameRate}
            detail={chipSeconds(trimmed.durationFrames, frameRate)}
          />
        )}
      </div>
      {menu !== null && menuView !== null && (
        <ClipMenu at={menu} label={`Actions for ${menuView.label}`} onClose={() => setMenu(null)}>
          <ExtractAudioMenuItem production={production} timeline={timeline} artifacts={artifacts} clip={menuView.clip}
            disabled={disabled} onCommands={onCommands} mintClipId={mintClipId} onClose={() => setMenu(null)} />
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
              disabled={disabled || off}
              onClick={() => {
                act(menu.clipId, action);
                setMenu(null);
              }}
            >
              {label}
            </button>
          ))}
        </ClipMenu>
      )}
    </div>
  );
}

/**
 * One timing row: the keyboard path of a trim drag (R-23). The value is typed as timecode and
 * committed on Enter or blur, or nudged a frame at a time; either way one command per edit.
 */
function TimingRow({
  label,
  value,
  frameRate,
  onStep,
  onEnter,
  disabled,
}: {
  label: string;
  value: number;
  frameRate: FrameRate;
  onStep: (deltaFrames: number) => void;
  onEnter: (text: string) => void;
  disabled: boolean;
}) {
  const shown = formatFrames(value, frameRate);
  return (
    <div className="fy-cutinspect__row fy-framestep">
      <span>{label}</span>
      <strong>
        <button type="button" className="fy-trim__step" aria-label={`${label} one frame earlier`} disabled={disabled} onClick={() => onStep(-1)}>
          −
        </button>
        <input
          // Remounted when the record moves, so the field always starts from what was written.
          key={shown}
          className="fy-timecode"
          defaultValue={shown}
          aria-label={`${label} timecode`}
          disabled={disabled}
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.currentTarget.value = shown;
              event.currentTarget.blur();
              // Escape here drops the edit and nothing more: left to bubble, the Cut's pane
              // listener reads it as "close the Inspector" on a compact layout.
              event.stopPropagation();
            }
          }}
          onBlur={(event) => {
            const text = event.currentTarget.value.trim();
            if (text !== shown) onEnter(text);
            // Whatever was sent, the row shows the record: a clamped or refused value must not
            // stay on screen as typed, reading as if it had landed.
            event.currentTarget.value = shown;
          }}
        />
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

/**
 * A clip's timing, as the target Inspector states it and as the keyboard edits it. A typed edge
 * reduces through the drag's clamp, so it never asks the coordinator for a range it would refuse;
 * a stepped one goes as it is, one frame being the finest thing there is to refuse. Either way
 * the viewer goes to the edge that moved (issue 1036), as it does under a grip.
 */
export function PictureClipTiming({
  clip,
  clips,
  frameRate,
  disabled,
  onCommands,
  onScrub,
  sourceLength,
  timeline = null,
}: {
  clip: TimelineClip;
  /** The clip's track, so a typed edge stops where its neighbours and its source do. */
  clips: readonly TimelineClip[];
  frameRate: FrameRate;
  disabled: boolean;
  onCommands: (commands: TimelineClipCommand[], label?: string) => void;
  onScrub?: (frame: number) => void;
  sourceLength: SourceLengthFrames;
  /** The record a step is checked against before it is sent, so the viewer never parks on an edge the cut refused. */
  timeline?: ProductionTimeline | null;
}) {
  const end = clip.startFrame + clip.durationFrames;
  /** Where the viewer goes after a command: the edge it moved, in the record it will produce. */
  const follow = (command: TimelineClipCommand) => {
    if (command.kind === "trim") {
      onScrub?.(command.edge === "start" ? clip.startFrame + command.deltaFrames : Math.max(clip.startFrame, end + command.deltaFrames - 1));
    } else if (command.kind === "move-to-frame") {
      onScrub?.(command.startFrame);
    }
  };
  const send = (command: TimelineClipCommand, label: string) => {
    // A step the algebra would refuse — a tail past its source, an edge into a neighbour, a move
    // onto another clip — sends nothing and moves the viewer nowhere; the row keeps the record.
    if (timeline !== null && previewTimeline(timeline, [command], sourceLength) === null) return;
    onCommands([command], label);
    follow(command);
  };
  const typed = (field: TimingField, label: string) => (text: string) => {
    const command = timingEntryCommand(clips, clip.id, field, text, frameRate, sourceLength);
    if (command !== null) send(command, label);
  };
  const trimEnd = (delta: number) => send({ kind: "trim", clipId: clip.id, edge: "end", deltaFrames: delta }, "Trim clip tail");
  return (
    <div className="fy-cutinspect__rows">
      <TimingRow label="Position" value={clip.startFrame} frameRate={frameRate} disabled={disabled}
        onStep={delta => send({ kind: "move-to-frame", clipId: clip.id, startFrame: Math.max(0, clip.startFrame + delta) }, "Move clip")}
        onEnter={typed("position", "Move clip")} />
      <TimingRow
        label="In"
        value={clip.startFrame}
        frameRate={frameRate}
        disabled={disabled}
        onStep={(delta) => send({ kind: "trim", clipId: clip.id, edge: "start", deltaFrames: delta }, "Trim clip head")}
        onEnter={typed("in", "Trim clip head")}
      />
      <TimingRow label="Out" value={end} frameRate={frameRate} disabled={disabled} onStep={trimEnd} onEnter={typed("out", "Trim clip tail")} />
      <TimingRow label="Duration" value={clip.durationFrames} frameRate={frameRate} disabled={disabled} onStep={trimEnd} onEnter={typed("duration", "Trim clip tail")} />
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
