import { useState } from "react";
import {
  AUDIO_TRACK_KINDS,
  DEFAULT_MIX,
  basePictureTrack,
  formatFrames,
  orderedTrackClips,
  type FrameRate,
  type MixSettings,
  type ProductionTimeline,
  type SourceLengthFrames,
  type TimelineClip,
  type TimelineClipCommand,
  type TimelineClipId,
  type TimelineTrack,
  type TimelineTrackId,
} from "@arke-studio/contracts";
import { cx } from "../components/ui.js";
import { frameAtPixel, framesFromDelta, previewTimeline, trackDragCommand, type PictureGesture } from "../lib/picture-edit.js";

/**
 * The typed tracks beside the story's Picture (SPEC-038 R-12, R-13; SPEC-039 R-13, R-19c, R-23;
 * issue 681): every Picture track above the base, then Dialogue, Ambience and Music, in saved
 * order. A clip on these tracks moves by frame rather than by order — a bed is not a sequence —
 * and the lane accepts a Library drop, which becomes one `place` command at the dropped frame.
 * Mute and Solo are track commands on the row itself, so the rule that silences a track is the
 * same one the render plan reads.
 */

export const ARTIFACT_DRAG_TYPE = "application/x-arke-artifact";

export interface TrackDrop {
  trackId: TimelineTrackId;
  artifactId: string;
  frame: number;
}

function clipLabel(clip: TimelineClip): string {
  return clip.source.label;
}

/** Track rows in the target's lane order: overlay picture, then Dialogue, Ambience, Music. */
export function typedTracksOf(timeline: ProductionTimeline): TimelineTrack[] {
  const base = basePictureTrack(timeline);
  const ordered = [...timeline.tracks].sort((a, b) => a.order - b.order);
  const upperPicture = ordered.filter((track) => track.kind === "picture" && track.id !== base?.id);
  const kind = (wanted: TimelineTrack["kind"]): TimelineTrack[] => ordered.filter((track) => track.kind === wanted);
  return [...upperPicture, ...kind("dialogue"), ...kind("ambience"), ...kind("music")];
}

export function TypedTrackRows({
  timeline,
  totalFrames,
  frameRate,
  selectedClipId,
  onSelect,
  onCommands,
  onPreview,
  disabled,
  sourceLength,
  onDrop,
  playheadFrame,
  mintClipId,
}: {
  timeline: ProductionTimeline;
  totalFrames: number;
  frameRate: FrameRate;
  selectedClipId: string | null;
  onSelect: (clipId: TimelineClipId) => void;
  onCommands: (commands: TimelineClipCommand[], label?: string) => void;
  onPreview: (timeline: ProductionTimeline | null) => void;
  disabled: boolean;
  sourceLength: SourceLengthFrames;
  onDrop: (drop: TrackDrop) => void;
  playheadFrame: number;
  mintClipId: () => TimelineClipId;
}) {
  const [over, setOver] = useState<TimelineTrackId | null>(null);
  const span = Math.max(totalFrames, 1);
  const anySolo = timeline.tracks.some((track) => track.solo === true);
  const tracks = typedTracksOf(timeline);
  if (tracks.length === 0) return null;

  const begin = (track: TimelineTrack, clipId: TimelineClipId, gesture: PictureGesture) => (event: React.PointerEvent) => {
    if (event.button !== 0 || disabled) return;
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
    const clips = orderedTrackClips(track);
    const move = (pointer: PointerEvent) => {
      const delta = framesFromDelta(pointer.clientX - originX, laneWidth, span);
      command = trackDragCommand(clips, clipId, gesture, delta, sourceLength);
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
      if (command !== null && previewTimeline(timeline, [command], sourceLength) !== null) {
        onCommands([command], gesture === "move" ? "Move clip" : `Trim clip ${gesture === "trim-start" ? "head" : "tail"}`);
      }
    };
    const cancel = (pointer: PointerEvent) => finish(pointer);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", cancel);
  };

  const onClipKeyDown = (clipId: TimelineClipId, clip: TimelineClip) => (event: React.KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || disabled) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      onCommands([{ kind: event.shiftKey ? "ripple-delete" : "delete", clipId }], event.shiftKey ? "Ripple delete clip" : "Delete clip");
    } else if (event.key === "d" || event.key === "D") {
      onCommands([{ kind: "duplicate", clipId, newClipId: mintClipId() }], "Duplicate clip");
    } else if ((event.key === "s" || event.key === "S") && playheadFrame > clip.startFrame && playheadFrame < clip.startFrame + clip.durationFrames) {
      onCommands([{ kind: "split", clipId, atFrame: playheadFrame, newClipId: mintClipId() }], "Split at the playhead");
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <>
      {tracks.map((track) => {
        const audio = AUDIO_TRACK_KINDS.has(track.kind);
        const silenced = track.muted || (anySolo && audio && track.solo !== true);
        const kindLabel = track.kind === "picture" ? "picture" : track.kind;
        return (
          <div className={cx("fy-track", silenced && "fy-track--silent")} data-track={track.kind === "picture" ? "overlay" : track.kind} data-track-id={track.id} key={track.id}>
            <span className="fy-track__label fy-track__label--typed">
              <span className="fy-track__name" title={`${track.name} · ${kindLabel}`}>{track.name}</span>
              <span className="fy-trackbtns" role="group" aria-label={`${track.name} controls`}>
                <button
                  type="button"
                  aria-pressed={track.muted}
                  aria-label={`Mute ${track.name}`}
                  disabled={disabled}
                  onClick={() => onCommands([{ kind: "set-track", trackId: track.id, muted: !track.muted }], track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`)}
                >
                  M
                </button>
                {audio && (
                  <button
                    type="button"
                    aria-pressed={track.solo === true}
                    aria-label={`Solo ${track.name}`}
                    disabled={disabled}
                    onClick={() => onCommands([{ kind: "set-track", trackId: track.id, solo: track.solo !== true }], track.solo === true ? `Unsolo ${track.name}` : `Solo ${track.name}`)}
                  >
                    S
                  </button>
                )}
              </span>
            </span>
            <div
              className={cx("fy-track__lane", "fy-typedlane", over === track.id && "fy-typedlane--over")}
              onDragOver={(event) => {
                if (disabled || track.kind === "picture" && false) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setOver(track.id);
              }}
              onDragLeave={() => setOver((current) => (current === track.id ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                setOver(null);
                const artifactId = event.dataTransfer.getData(ARTIFACT_DRAG_TYPE);
                if (!artifactId || disabled) return;
                const box = event.currentTarget.getBoundingClientRect();
                onDrop({ trackId: track.id, artifactId, frame: frameAtPixel(event.clientX - box.left, box.width, span) });
              }}
            >
              {track.clips.length === 0 && (
                <span className="fy-track__empty">{audio ? "drop sound here" : "drop a picture here"}</span>
              )}
              {orderedTrackClips(track).map((clip) => {
                const selected = clip.id === selectedClipId;
                const label = `${clipLabel(clip)}, ${formatFrames(clip.startFrame, frameRate)} to ${formatFrames(clip.startFrame + clip.durationFrames, frameRate)}${silenced ? ", silent" : ""}${clip.gainDb !== undefined && clip.gainDb !== 0 ? `, ${clip.gainDb} dB` : ""}`;
                return (
                  <button
                    key={clip.id}
                    type="button"
                    data-clip={clip.id}
                    className={cx("fy-typedclip", audio && "fy-typedclip--audio", selected && "fy-typedclip--selected")}
                    style={{ left: `${(clip.startFrame / span) * 100}%`, width: `${Math.max((clip.durationFrames / span) * 100, 0.6)}%` }}
                    aria-pressed={selected}
                    aria-label={label}
                    title={label}
                    disabled={disabled}
                    onClick={() => onSelect(clip.id)}
                    onPointerDown={begin(track, clip.id, "move")}
                    onKeyDown={onClipKeyDown(clip.id, clip)}
                  >
                    <span className="fy-pictclip__grip fy-pictclip__grip--start" onPointerDown={begin(track, clip.id, "trim-start")} aria-hidden="true" />
                    <span className="fy-typedclip__name">{clipLabel(clip)}</span>
                    {clip.gainDb !== undefined && clip.gainDb !== 0 && <span className="fy-typedclip__gain">{clip.gainDb > 0 ? `+${clip.gainDb}` : clip.gainDb} dB</span>}
                    {clip.audio === "mute" && <span className="fy-typedclip__gain">MUTE</span>}
                    <span className="fy-pictclip__grip fy-pictclip__grip--end" onPointerDown={begin(track, clip.id, "trim-end")} aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}

/** A clip's gain, as the Inspector authors it: one command per press (SPEC-038 R-13). */
export function ClipGain({
  clip,
  disabled,
  onCommands,
}: {
  clip: TimelineClip;
  disabled: boolean;
  onCommands: (commands: TimelineClipCommand[], label?: string) => void;
}) {
  const gain = clip.gainDb ?? 0;
  const set = (next: number) => onCommands([{ kind: "set-clip-gain", clipId: clip.id, gainDb: Math.max(-60, Math.min(12, next)) }], "Set clip gain");
  return (
    <div className="fy-cutinspect__row fy-framestep">
      <span>Gain</span>
      <strong>
        <button type="button" className="fy-trim__step" aria-label="Gain 1 dB quieter" disabled={disabled || gain <= -60} onClick={() => set(gain - 1)}>
          −
        </button>
        <span className="fy-mono">{gain > 0 ? `+${gain}` : gain} dB</span>
        <button type="button" className="fy-trim__step" aria-label="Gain 1 dB louder" disabled={disabled || gain >= 12} onClick={() => set(gain + 1)}>
          +
        </button>
      </strong>
    </div>
  );
}

/** The production's one mix policy (SPEC-038 §2.2, SPEC-039 R-20, R-23). */
export function MixPanel({
  mix,
  disabled,
  onCommands,
}: {
  mix: MixSettings;
  disabled: boolean;
  onCommands: (commands: TimelineClipCommand[], label?: string) => void;
}) {
  const set = (patch: Partial<MixSettings>, label: string) => onCommands([{ kind: "set-mix", mix: patch }], label);
  return (
    <div className="fy-mixpanel" aria-label="Mix">
      <div className="fy-cutinspect__eyebrow">MIX</div>
      <div className="fy-cutinspect__rows">
        <div className="fy-cutinspect__row">
          <span>Speech first</span>
          <strong>
            <button
              type="button"
              className="fy-takepick__use"
              aria-pressed={mix.speechFirst}
              disabled={disabled}
              onClick={() => set({ speechFirst: !mix.speechFirst }, mix.speechFirst ? "Speech-first off" : "Speech-first on")}
            >
              {mix.speechFirst ? "On" : "Off"}
            </button>
          </strong>
        </div>
        <div className="fy-cutinspect__row fy-framestep">
          <span>Background under speech</span>
          <strong>
            <button type="button" className="fy-trim__step" aria-label="Duck 1 dB more" disabled={disabled || mix.duckingDb <= -24} onClick={() => set({ duckingDb: mix.duckingDb - 1 }, "Duck more")}>
              −
            </button>
            <span className="fy-mono">{mix.duckingDb} dB</span>
            <button type="button" className="fy-trim__step" aria-label="Duck 1 dB less" disabled={disabled || mix.duckingDb >= 0} onClick={() => set({ duckingDb: mix.duckingDb + 1 }, "Duck less")}>
              +
            </button>
          </strong>
        </div>
        <div className="fy-cutinspect__row">
          <span>Look-ahead</span>
          <strong>{mix.lookAheadMs} ms</strong>
        </div>
        <div className="fy-cutinspect__row">
          <span>Release</span>
          <strong>{mix.releaseMs} ms</strong>
        </div>
        <div className="fy-cutinspect__row">
          <span>Ceiling</span>
          <strong>{mix.limiterCeilingDb} dBFS</strong>
        </div>
      </div>
      {(mix.lookAheadMs !== DEFAULT_MIX.lookAheadMs || mix.releaseMs !== DEFAULT_MIX.releaseMs) && (
        <button type="button" className="fy-takepick__use" disabled={disabled} onClick={() => set({ lookAheadMs: DEFAULT_MIX.lookAheadMs, releaseMs: DEFAULT_MIX.releaseMs }, "Reset envelope")}>
          Reset envelope
        </button>
      )}
    </div>
  );
}
