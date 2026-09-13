import { useState } from "react";
import {
  deriveSpineCut,
} from "@arke-studio/contracts";
import { cx } from "../components/ui.js";
import { Portrait } from "../components/portrait.js";
import { seconds } from "../lib/format.js";
import { posterize } from "../lib/poster.js";
import {
  type PictureClipView,
} from "./editor-timeline.js";
import { ARTIFACT_DRAG_TYPE, dragAccepts, laneIcon } from "./editor-audio.js";
import { type DroppedKind } from "../lib/clip-gesture.js";

/**
 * The Cut on the song clock (80a): the track is the ruler, so the lane is the derived spine cut
 * laid out by position rather than the scene order — clips where an anchor is covered, slates
 * where a shot is anchored but has nothing to show, and black for the time no anchor claims.
 *
 * The one authored edit lives here: trim, on the selected clip, writing the selection (R-8).
 */
export function SpineCutTrack({
  slug,
  cut,
  selectedShotId,
  onSelectShot,
}: {
  slug: string | undefined;
  cut: ReturnType<typeof deriveSpineCut>;
  selectedShotId: string | null;
  onSelectShot: (shotId: string) => void;
}) {
  return (
    <>
      <div className="fy-track">
        <span className="fy-track__label">Picture</span>
        <div className="fy-track__lane">
          {cut.segments.map((seg, i) => {
            const span = Math.max(seg.endSec - seg.startSec, 0.25);
            if (seg.kind === "clip") {
              const isSelected = seg.shotId !== undefined && seg.shotId === selectedShotId;
              return (
                <button
                  key={`${seg.kind}-${i}`}
                  type="button"
                  className={cx("fy-cutseg", "fy-cutseg--pick", isSelected && "fy-cutseg--selected")}
                  style={{ flex: span }}
                  aria-pressed={isSelected}
                  onClick={() => seg.shotId && onSelectShot(seg.shotId)}
                >
                  <Portrait
                    worldSlug={slug}
                    path={seg.media ? posterize(seg.media.path) : ""}
                    label={`SC ${seg.sceneNumber}`}
                    radius={0}
                  />
                  <span className="fy-cutseg__tag">SC {seg.sceneNumber}</span>
                </button>
              );
            }
            if (seg.kind === "slate") {
              return (
                <div
                  key={`${seg.kind}-${i}`}
                  className="fy-cutseg fy-cutseg--gap fy-cutseg--gap-warn"
                  style={{ flex: span }}
                >
                  {seg.label}
                </div>
              );
            }
            return (
              <div key={`${seg.kind}-${i}`} className="fy-cutseg fy-cutseg--black" style={{ flex: span }}>
                {seconds(seg.endSec - seg.startSec)}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

/**
 * A lane that is not on the record yet (SPEC-039 R-13): the target keeps all five in view, and a
 * drop on one adds the track and places in one batch. Sound lanes take sound, picture takes
 * picture; the refusal shows while the drag is over the lane.
 */
export function EmptyEditorTrack({
  label,
  detail,
  kind,
  onDrop,
}: {
  label: string;
  detail: string;
  kind: string;
  onDrop?: (artifactId: string, frame: number, laneWidth: number, x: number) => void;
}) {
  const [over, setOver] = useState(false);
  const [refused, setRefused] = useState(false);
  const wantsSound = kind === "dialogue" || kind === "ambience" || kind === "music";
  const droppable = onDrop !== undefined && kind !== "subtitles";
  return (
    <div className={cx("fy-track fy-track--empty", over && "fy-track--over")} data-track={kind}>
      <span className="fy-track__label">
        <span className="fy-track__icon" aria-hidden="true">{laneIcon(kind)}</span>
        <span className="fy-track__name">{label}</span>
      </span>
      <div
        className={cx("fy-track__lane", refused && "fy-typedlane--refuse")}
        onDragOver={(event) => {
          if (!droppable) return;
          // Desktop files have no lane here to land on; the lanes that take them say so
          // themselves (issue 1035). Saying "picture lanes take picture" about a file nobody
          // has read was the false refusal this row used to make.
          if (Array.from(event.dataTransfer.types).includes("Files")) return;
          if (!dragAccepts(event.dataTransfer.types, wantsSound)) {
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
          if (!droppable) return;
          event.preventDefault();
          setOver(false);
          setRefused(false);
          const artifactId = event.dataTransfer.getData(ARTIFACT_DRAG_TYPE);
          if (!artifactId) return;
          const box = event.currentTarget.getBoundingClientRect();
          onDrop(artifactId, 0, box.width, event.clientX - box.left);
        }}
      >
        <span className="fy-track__empty">{refused ? (wantsSound ? "sound lanes take sound" : "picture lanes take picture") : detail}</span>
      </div>
    </div>
  );
}

/**
 * The target's strip under the last lane: a drop here makes a new lane of the item's own kind.
 * Desktop files land here too (issue 1035): a lane per kind, at the dropped frame.
 */
export function NewLaneStrip({ onDrop, onFileDrop = null, fileKinds = null }: {
  onDrop: ((artifactId: string, laneWidth: number, x: number) => void) | null;
  onFileDrop?: ((files: File[], laneWidth: number, x: number) => void) | null;
  fileKinds?: readonly DroppedKind[] | null;
}) {
  const [over, setOver] = useState(false);
  const filesOver = fileKinds !== null && fileKinds.length > 0 && onFileDrop !== null;
  return (
    <div className={cx("fy-track fy-track--new", over && "fy-track--over", filesOver && "fy-track--files")} data-track="new">
      <span className="fy-track__label">
        <span className="fy-track__name">+ lane</span>
      </span>
      <div
        className="fy-track__lane"
        onDragOver={(event) => {
          if (Array.from(event.dataTransfer.types).includes("Files")) {
            if (onFileDrop === null) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setOver(true);
            return;
          }
          if (onDrop === null || !Array.from(event.dataTransfer.types).includes(ARTIFACT_DRAG_TYPE)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          setOver(false);
          const box = event.currentTarget.getBoundingClientRect();
          if (event.dataTransfer.files?.length) {
            event.preventDefault(); event.stopPropagation();
            onFileDrop?.(Array.from(event.dataTransfer.files), box.width, event.clientX - box.left);
            return;
          }
          if (onDrop === null) return;
          event.preventDefault();
          const artifactId = event.dataTransfer.getData(ARTIFACT_DRAG_TYPE);
          if (!artifactId) return;
          onDrop(artifactId, box.width, event.clientX - box.left);
        }}
      >
        <span className="fy-track__empty">{onDrop === null && !filesOver ? "" : filesOver ? "Drop to add · new lane" : "drop here for a new lane"}</span>
      </div>
    </div>
  );
}

/** Scene bands over the Picture track: one band per run of clips from the same scene. */
export function SceneBands({ views, totalFrames }: { views: readonly PictureClipView[]; totalFrames: number }) {
  const bands: { key: string; number: number | null; startFrame: number; endFrame: number }[] = [];
  for (const view of views) {
    const last = bands[bands.length - 1];
    const end = view.clip.startFrame + view.clip.durationFrames;
    if (last && last.number === view.sceneNumber && last.endFrame === view.clip.startFrame) last.endFrame = end;
    else bands.push({ key: view.clip.id, number: view.sceneNumber, startFrame: view.clip.startFrame, endFrame: end });
  }
  const span = Math.max(totalFrames, 1);
  return (
    <div className="fy-track">
      <span className="fy-track__label" />
      <div className="fy-scenes fy-scenes--framed">
        {bands.map((band) => (
          <div
            key={band.key}
            className="fy-scenes__band"
            style={{ left: `${(band.startFrame / span) * 100}%`, width: `${((band.endFrame - band.startFrame) / span) * 100}%` }}
          >
            {band.number === null ? "placed" : `SC ${band.number}`}
          </div>
        ))}
      </div>
    </div>
  );
}
