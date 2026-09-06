import { useState } from "react";
import { ClipMenu, ExtractAudioMenuItem } from "./editor-clip-menu.js";
import {
  AUDIO_TRACK_KINDS,
  effectiveAudioRole,
  placementAudioRole,
  type AudioRole,
  type ArtifactSidecar,
  type ProductionBundle,
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
  PICTURE_TRACK_ID,
} from "@arke-studio/contracts";
import { cx } from "../components/ui.js";
import type { EditorTool } from "./editor-timeline.js";
import { frameAtPixel, framesFromDelta, previewTimeline, trackDragCommand, type PictureGesture } from "../lib/picture-edit.js";

/**
 * The typed tracks beside the story's Picture (SPEC-038 R-12, R-13; SPEC-039 R-13, R-19c, R-23;
 * issue 681): every Picture track above the base, then audio tracks, in saved
 * order. A clip on these tracks moves by frame rather than by order — a bed is not a sequence —
 * and the lane accepts a Library drop, which becomes one `place` command at the dropped frame.
 * Mute and Solo are track commands on the row itself, so the rule that silences a track is the
 * same one the render plan reads.
 */

import { Film, Mic, MusicMark, TextMark, Waveform, X } from "../components/icons.js";

export const ARTIFACT_DRAG_TYPE = "application/x-arke-artifact";
/**
 * What a dragged Library row can land on, carried as drag types because the payload itself is
 * unreadable during dragover (SPEC-039 R-10; the target refuses an incompatible lane while the
 * drag is still moving, not after the drop).
 */
export const LANE_DRAG_PICTURE = "application/x-arke-lane-picture";
export const LANE_DRAG_SOUND = "application/x-arke-lane-sound";
/** A Library shot on the move: its payload is `shot:<id>` in the artifact slot, and this marks it. */
export const SHOT_DRAG_TYPE = "application/x-arke-shot";

export function dragAccepts(types: ArrayLike<string> | readonly string[], wantsSound: boolean): boolean {
  const list = Array.from(types as ArrayLike<string>);
  if (!list.includes(ARTIFACT_DRAG_TYPE)) return false;
  // A drag from before the lane types existed (tests, other windows) says nothing about its kind and is let through.
  if (!list.includes(LANE_DRAG_PICTURE) && !list.includes(LANE_DRAG_SOUND)) return true;
  return list.includes(wantsSound ? LANE_DRAG_SOUND : LANE_DRAG_PICTURE);
}

/** The lane marks the target draws beside each name. */
export function laneIcon(kind: string): React.ReactNode {
  switch (kind) {
    case "picture":
    case "overlay":
      return <Film size={11} />;
    case "dialogue":
      return <Mic size={11} />;
    case "audio":
    case "ambience":
      return <Waveform size={11} />;
    case "music":
      return <MusicMark size={11} />;
    case "subtitle":
    case "subtitles":
      return <TextMark size={11} />;
    default:
      return null;
  }
}

export interface TrackDrop {
  trackId: TimelineTrackId;
  artifactId: string;
  frame: number;
}

function clipLabel(clip: TimelineClip): string {
  return clip.source.label;
}

/** Track rows in the target's lane order: overlay picture, then audio in saved order. */
export function typedTracksOf(timeline: ProductionTimeline): TimelineTrack[] {
  const base = basePictureTrack(timeline);
  const ordered = [...timeline.tracks].sort((a, b) => a.order - b.order);
  const upperPicture = ordered.filter((track) => track.kind === "picture" && track.id !== base?.id);
  return [...upperPicture, ...ordered.filter(track => AUDIO_TRACK_KINDS.has(track.kind))];
}

export function TypedTrackRows({
  production,
  artifacts,
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
  tool = "select",
}: {
  production?: ProductionBundle;
  artifacts?: readonly ArtifactSidecar[];
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
  /** The toolbar's tool applies to every track (round eight): Blade splits here, Hand pans here. */
  tool?: EditorTool;
}) {
  const [over, setOver] = useState<TimelineTrackId | null>(null);
  const [refused, setRefused] = useState<TimelineTrackId | null>(null);
  const [menu, setMenu] = useState<{ clipId: TimelineClipId; x: number; y: number } | null>(null);
  const span = Math.max(totalFrames, 1);
  const anySolo = timeline.tracks.some((track) => track.solo === true);
  const tracks = typedTracksOf(timeline);
  const menuClip = menu ? tracks.filter(track => track.kind === "picture").flatMap(track => track.clips).find(clip => clip.id === menu.clipId) : undefined;
  if (tracks.length === 0) return null;

  const begin = (track: TimelineTrack, clipId: TimelineClipId, gesture: PictureGesture) => (event: React.PointerEvent) => {
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

  const blade = (track: TimelineTrack, clip: TimelineClip) => (event: React.MouseEvent) => {
    const lane = (event.currentTarget as HTMLElement).closest<HTMLElement>(".fy-track__lane");
    if (lane === null) return;
    const box = lane.getBoundingClientRect();
    const frame = frameAtPixel(event.clientX - box.left, box.width, span);
    if (frame <= clip.startFrame || frame >= clip.startFrame + clip.durationFrames) return;
    onSelect(clip.id);
    onCommands([{ kind: "split", clipId: clip.id, atFrame: frame, newClipId: mintClipId() }], "Split clip");
    void track;
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

  const onClipKeyDown = (clipId: TimelineClipId, clip: TimelineClip) => (event: React.KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || disabled) return;
    if ((event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) && tracks.some(track => track.kind === "picture" && track.clips.some(candidate => candidate.id === clipId))) {
      const box = event.currentTarget.getBoundingClientRect();
      onSelect(clipId); setMenu({ clipId, x: box.left, y: box.bottom });
      event.preventDefault(); event.stopPropagation(); return;
    }
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
        // An empty extra lane can go (the target's ×); the base Picture track and a lane holding anything stay.
        const removable = track.clips.length === 0 && (track.cues ?? []).length === 0 && track.id !== PICTURE_TRACK_ID;
        return (
          <div className={cx("fy-track", silenced && "fy-track--silent")} data-track={track.kind === "picture" ? "overlay" : track.kind} data-track-id={track.id} key={track.id}>
            <span className="fy-track__label fy-track__label--typed">
              <span className="fy-track__icon" aria-hidden="true">{laneIcon(track.kind)}</span>
              <span className="fy-track__name" title={`${track.name} · ${kindLabel}`}>{track.name}</span>
              <span className="fy-trackbtns" role="group" aria-label={`${track.name} controls`}>
                {removable && (
                  <button
                    type="button"
                    className="fy-trackbtns__remove"
                    aria-label={`Remove ${track.name}`}
                    disabled={disabled}
                    onClick={() => onCommands([{ kind: "remove-track", trackId: track.id }], `Remove ${track.name}`)}
                  >
                    <X size={9} />
                  </button>
                )}
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
              className={cx(
                "fy-track__lane",
                "fy-typedlane",
                over === track.id && "fy-typedlane--over",
                refused === track.id && "fy-typedlane--refuse",
                tool === "hand" && "fy-pictlane--hand",
                tool === "blade" && "fy-pictlane--blade",
              )}
              onPointerDown={onLanePointerDown}
              onDragOver={(event) => {
                if (disabled) return;
                // The lane says no while the drag is still over it (R-10): sound on a picture lane, or the reverse.
                if (!dragAccepts(event.dataTransfer.types, audio)) {
                  event.dataTransfer.dropEffect = "none";
                  setRefused(track.id);
                  return;
                }
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setOver(track.id);
              }}
              onDragLeave={() => {
                setOver((current) => (current === track.id ? null : current));
                setRefused((current) => (current === track.id ? null : current));
              }}
              onDrop={(event) => {
                event.preventDefault();
                setOver(null);
                setRefused(null);
                const artifactId = event.dataTransfer.getData(ARTIFACT_DRAG_TYPE);
                if (!artifactId || disabled) return;
                const box = event.currentTarget.getBoundingClientRect();
                onDrop({ trackId: track.id, artifactId, frame: frameAtPixel(event.clientX - box.left, box.width, span) });
              }}
            >
              {track.clips.length === 0 && refused !== track.id && (
                <span className="fy-track__empty">{audio ? "drop sound here" : "drop a picture here"}</span>
              )}
              {refused === track.id && <span className="fy-track__refuse">{audio ? "sound lanes take sound" : "picture lanes take picture"}</span>}
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
                    onContextMenu={event => {
                      if (audio) return;
                      event.preventDefault(); event.stopPropagation();
                      if (disabled) return;
                      event.currentTarget.focus(); onSelect(clip.id);
                      setMenu({ clipId: clip.id, x: event.clientX, y: event.clientY });
                    }}
                    onClick={(event) => {
                      if (tool === "blade") {
                        blade(track, clip)(event);
                        return;
                      }
                      onSelect(clip.id);
                    }}
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
      {menu && menuClip && <ClipMenu at={menu} label={`Actions for ${clipLabel(menuClip)}`} onClose={() => setMenu(null)}>
        <ExtractAudioMenuItem production={production} timeline={timeline} artifacts={artifacts} clip={menuClip}
          disabled={disabled} onCommands={onCommands} mintClipId={mintClipId} onClose={() => setMenu(null)} />
      </ClipMenu>}
    </>
  );
}

/** A role describes the clip, without changing its identity, track or source references. */
export function AudioClipSettings({ clip, track, disabled, onCommands }: {
  clip: TimelineClip; track: TimelineTrack; disabled: boolean;
  onCommands: (commands: TimelineClipCommand[], label?: string) => void;
}) {
  const roles: Array<[AudioRole, string]> = [["unspecified", "Unspecified"], ["dialogue", "Voice"], ["music", "Music"], ["ambience", "Ambience"]];
  return <div className="fy-cutinspect__rows fy-audiosettings">
    <label className="fy-cutinspect__row">Clip role
      <select aria-label="Clip role" value={effectiveAudioRole(track, clip)} disabled={disabled || clip.source.kind === "performance"}
        onChange={event => onCommands([{ kind: "set-clip-role", clipId: clip.id, role: event.target.value as AudioRole }], "Change audio role")}>
        {roles.map(([role, label]) => <option key={role} value={role}>{label}</option>)}
      </select>
    </label>
    <label className="fy-cutinspect__row">Track name
      <input key={track.id + track.name} aria-label="Track name" defaultValue={track.name} disabled={disabled}
        onBlur={event => { const name = event.target.value.trim(); if (name && name !== track.name) onCommands([{ kind: "set-track", trackId: track.id, name }], "Rename audio track"); }} />
    </label>
    <label className="fy-cutinspect__row">Default for new clips
      <select aria-label="Default role for new clips" value={placementAudioRole(track)} disabled={disabled}
        onChange={event => onCommands([{ kind: "set-track", trackId: track.id, defaultRole: event.target.value as AudioRole }], "Change track default role")}>
        {roles.map(([role, label]) => <option key={role} value={role}>{label}</option>)}
      </select>
    </label>
    <p className="fy-cutinspect__note">The track default applies to future clips. This clip keeps its own role.</p>
  </div>;
}

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
