import { useRef, useState } from "react";
import {
  cueStaleness,
  formatFrames,
  orderedCues,
  parseSubtitles,
  ulid,
  type FrameRate,
  type ProductionBundle,
  type ProductionTimeline,
  type SubtitleCue,
  type SubtitleCueId,
  type TimelineClipCommand,
  type TimelineTrack,
  type TimelineTrackId,
} from "@arke-studio/contracts";
import { cx } from "../components/ui.js";

/**
 * Subtitles on the editor (SPEC-038 R-21..R-26; SPEC-039 R-13, R-21; issue 683): one language
 * track at a time is viewed, its cues sit on the Subtitles lane, and every edit — words, timing,
 * speaker, an imported file, a draft heard from speech — is one fenced command. Nothing here
 * renders pixels into a file; burn-in is an output the export sheet chooses.
 */

export function subtitleTracksOf(timeline: ProductionTimeline): TimelineTrack[] {
  return [...timeline.tracks].filter((track) => track.kind === "subtitle").sort((a, b) => a.order - b.order);
}

export function SubtitleTrackRow({
  track,
  totalFrames,
  frameRate,
  production,
  selectedCueId,
  onSelectCue,
  onCommands,
  disabled,
  playheadFrame,
}: {
  track: TimelineTrack;
  totalFrames: number;
  frameRate: FrameRate;
  production: ProductionBundle;
  selectedCueId: string | null;
  onSelectCue: (cueId: SubtitleCueId) => void;
  onCommands: (commands: TimelineClipCommand[], label?: string) => void;
  disabled: boolean;
  playheadFrame: number;
}) {
  const span = Math.max(totalFrames, 1);
  const cues = orderedCues(track.cues ?? []);
  return (
    <div className={cx("fy-track", track.muted && "fy-track--silent")} data-track="subtitles" data-track-id={track.id}>
      <span className="fy-track__label fy-track__label--typed">
        <span className="fy-track__name" title={`${track.name} · ${track.language ?? ""}`}>
          {track.name}
        </span>
        <span className="fy-trackbtns" role="group" aria-label={`${track.name} controls`}>
          <button
            type="button"
            aria-pressed={track.muted}
            aria-label={`Hide ${track.name}`}
            disabled={disabled}
            onClick={() => onCommands([{ kind: "set-track", trackId: track.id, muted: !track.muted }], track.muted ? `Show ${track.name}` : `Hide ${track.name}`)}
          >
            M
          </button>
        </span>
      </span>
      <div className="fy-track__lane fy-typedlane fy-cuelane">
        {cues.length === 0 && <span className="fy-track__empty">no subtitles yet · add one at the playhead</span>}
        {cues.map((cue) => {
          const selected = cue.id === selectedCueId;
          const stale = cueStaleness(cue, production);
          const label = `${cue.text.split("\n").join(" ")}, ${formatFrames(cue.startFrame, frameRate)} to ${formatFrames(cue.endFrame, frameRate)}${stale.stale ? ", stale" : ""}`;
          return (
            <button
              key={cue.id}
              type="button"
              data-cue={cue.id}
              className={cx("fy-typedclip", "fy-cue", selected && "fy-typedclip--selected", stale.stale && "fy-cue--stale")}
              style={{ left: `${(cue.startFrame / span) * 100}%`, width: `${Math.max(((cue.endFrame - cue.startFrame) / span) * 100, 0.6)}%` }}
              aria-pressed={selected}
              aria-label={label}
              title={label}
              disabled={disabled}
              onClick={() => onSelectCue(cue.id)}
              onKeyDown={(event) => {
                if (event.key === "Delete" || event.key === "Backspace") {
                  event.preventDefault();
                  onCommands([{ kind: "delete-cue", cueId: cue.id }], "Delete subtitle");
                }
              }}
            >
              <span className="fy-typedclip__name">{cue.text.split("\n").join(" ")}</span>
              {stale.stale && <span className="fy-typedclip__gain">STALE</span>}
            </button>
          );
        })}
      </div>
      <span className="fy-track__tail">
        <button
          type="button"
          className="fy-trackbtns__add"
          disabled={disabled || (track.cues ?? []).some((cue) => playheadFrame >= cue.startFrame && playheadFrame < cue.endFrame)}
          aria-label={`Add subtitle at ${formatFrames(playheadFrame, frameRate)}`}
          onClick={() => {
            const next = cues.find((cue) => cue.startFrame > playheadFrame);
            const endFrame = Math.min(playheadFrame + frameRate * 2, next?.startFrame ?? Number.MAX_SAFE_INTEGER);
            onCommands(
              [{ kind: "add-cue", trackId: track.id, cue: { id: `cu_${ulid()}`, text: "New subtitle", startFrame: playheadFrame, endFrame: Math.max(playheadFrame + 1, endFrame) } }],
              "Add subtitle",
            );
          }}
        >
          +
        </button>
      </span>
    </div>
  );
}

/** One cue's words, timing and speaker, authored as commands (SPEC-039 R-21). */
export function CueInspector({
  track,
  cue,
  frameRate,
  production,
  disabled,
  onCommands,
}: {
  track: TimelineTrack;
  cue: SubtitleCue;
  frameRate: FrameRate;
  production: ProductionBundle;
  disabled: boolean;
  onCommands: (commands: TimelineClipCommand[], label?: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [speaker, setSpeaker] = useState<string | null>(null);
  const stale = cueStaleness(cue, production);
  const shownText = draft ?? cue.text;
  const commitText = () => {
    if (draft !== null && draft.trim() !== "" && draft !== cue.text) onCommands([{ kind: "edit-cue", cueId: cue.id, text: draft.trim() }], "Edit subtitle");
    setDraft(null);
  };
  const commitSpeaker = () => {
    if (speaker === null) return;
    const next = speaker.trim();
    if (next !== (cue.speaker ?? "")) onCommands([{ kind: "edit-cue", cueId: cue.id, speaker: next === "" ? null : next }], "Change subtitle speaker");
    setSpeaker(null);
  };
  const step = (edge: "start" | "end", delta: number) => {
    const command: TimelineClipCommand = edge === "start" ? { kind: "edit-cue", cueId: cue.id, startFrame: cue.startFrame + delta } : { kind: "edit-cue", cueId: cue.id, endFrame: cue.endFrame + delta };
    onCommands([command], `Trim subtitle ${edge}`);
  };
  return (
    <div className="fy-cutinspect">
      <div className="fy-cutinspect__eyebrow">SUBTITLE · {track.language ?? track.name}</div>
      <h2>{track.name}</h2>
      {stale.stale && (
        <p className="fy-cutinspect__note fy-cue__stale" role="status">
          Stale · {stale.reason}. The words below are still yours.
        </p>
      )}
      <label className="fy-cue__field">
        <span className="fy-cutinspect__eyebrow">TEXT</span>
        <textarea
          value={shownText}
          rows={3}
          disabled={disabled}
          aria-label="Subtitle text"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitText}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              commitText();
            }
          }}
        />
      </label>
      <label className="fy-cue__field">
        <span className="fy-cutinspect__eyebrow">SPEAKER</span>
        <input
          type="text"
          value={speaker ?? cue.speaker ?? ""}
          placeholder="sheet slug, or empty"
          disabled={disabled}
          aria-label="Subtitle speaker"
          onChange={(event) => setSpeaker(event.target.value)}
          onBlur={commitSpeaker}
        />
      </label>
      <div className="fy-cutinspect__rows">
        <div className="fy-cutinspect__row fy-framestep">
          <span>In</span>
          <strong>
            <button type="button" className="fy-trim__step" aria-label="In one frame earlier" disabled={disabled || cue.startFrame === 0} onClick={() => step("start", -1)}>
              −
            </button>
            <span className="fy-mono">{formatFrames(cue.startFrame, frameRate)}</span>
            <button type="button" className="fy-trim__step" aria-label="In one frame later" disabled={disabled || cue.startFrame + 1 >= cue.endFrame} onClick={() => step("start", 1)}>
              +
            </button>
          </strong>
        </div>
        <div className="fy-cutinspect__row fy-framestep">
          <span>Out</span>
          <strong>
            <button type="button" className="fy-trim__step" aria-label="Out one frame earlier" disabled={disabled || cue.endFrame - 1 <= cue.startFrame} onClick={() => step("end", -1)}>
              −
            </button>
            <span className="fy-mono">{formatFrames(cue.endFrame, frameRate)}</span>
            <button type="button" className="fy-trim__step" aria-label="Out one frame later" disabled={disabled} onClick={() => step("end", 1)}>
              +
            </button>
          </strong>
        </div>
        {cue.provenance !== undefined && (
          <div className="fy-cutinspect__row">
            <span>From</span>
            <strong>{cue.provenance.kind === "speech-to-text" ? `speech-to-text · ${cue.provenance.model}` : `${cue.provenance.format.toUpperCase()} import`}</strong>
          </div>
        )}
      </div>
      <button type="button" className="fy-takepick__use" disabled={disabled} onClick={() => onCommands([{ kind: "delete-cue", cueId: cue.id }], "Delete subtitle")}>
        Delete subtitle
      </button>
    </div>
  );
}

/**
 * Subtitle sources (SPEC-038 R-24, R-25): a language track, a file read and reported row by
 * row before anything is sent, and an explicit draft from the Dialogue clips' speech.
 */
export function SubtitleSources({
  timeline,
  frameRate,
  viewedTrackId,
  onViewTrack,
  disabled,
  onCommands,
  onTranscribe,
}: {
  timeline: ProductionTimeline;
  frameRate: FrameRate;
  viewedTrackId: TimelineTrackId | null;
  onViewTrack: (trackId: TimelineTrackId | null) => void;
  disabled: boolean;
  onCommands: (commands: TimelineClipCommand[], label?: string) => void;
  /** Null while speech-to-text cannot be asked for (no saved timeline). */
  onTranscribe: ((trackId: TimelineTrackId, language: string) => void) | null;
}) {
  const tracks = subtitleTracksOf(timeline);
  const [language, setLanguage] = useState("en");
  const [report, setReport] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const viewed = tracks.find((track) => track.id === viewedTrackId) ?? null;
  const validLanguage = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language);

  const importFile = async (file: File) => {
    const format = file.name.toLowerCase().endsWith(".vtt") ? "vtt" : "srt";
    const text = await file.text();
    const parsed = parseSubtitles(text, format, frameRate);
    const problems = parsed.problems.map((problem) => `line ${problem.line}: ${problem.message}`);
    if (parsed.cues.length === 0) {
      setReport(`Nothing imported from ${file.name}${problems.length > 0 ? ` · ${problems.join(" · ")}` : ""}`);
      return;
    }
    const trackId: TimelineTrackId = viewed?.id ?? `tr_subs-${language}`;
    const commands: TimelineClipCommand[] = [];
    if (viewed === null) commands.push({ kind: "add-subtitle-track", trackId, name: `Subtitles (${language})`, language });
    commands.push({
      kind: "import-cues",
      trackId,
      cues: parsed.cues.map((cue) => ({ id: `cu_${ulid()}`, ...cue })),
      replace: viewed !== null && (viewed.cues ?? []).length > 0 ? window.confirm(`Replace the ${viewed.cues!.length} subtitles on ${viewed.name}?`) : false,
      provenance: { kind: "import", format, at: new Date().toISOString() },
    });
    onCommands(commands, `Import ${file.name}`);
    setReport(
      `${parsed.cues.length} subtitle${parsed.cues.length === 1 ? "" : "s"} from ${file.name}${problems.length > 0 ? ` · not imported: ${problems.join(" · ")}` : ""}`,
    );
    if (viewed === null) onViewTrack(trackId);
  };

  return (
    <div className="fy-subsources" aria-label="Subtitles">
      <div className="fy-cutinspect__eyebrow">SUBTITLES · {tracks.length}</div>
      <div className="fy-cutinspect__rows">
        <div className="fy-cutinspect__row">
          <span>Viewing</span>
          <strong>
            <select
              aria-label="Subtitle track to view"
              value={viewedTrackId ?? ""}
              onChange={(event) => onViewTrack(event.target.value === "" ? null : (event.target.value as TimelineTrackId))}
            >
              <option value="">none</option>
              {tracks.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.name} · {track.language}
                </option>
              ))}
            </select>
          </strong>
        </div>
        <div className="fy-cutinspect__row">
          <span>Language</span>
          <strong>
            <input
              type="text"
              value={language}
              aria-label="Subtitle language"
              placeholder="en"
              disabled={disabled}
              onChange={(event) => setLanguage(event.target.value.trim())}
            />
          </strong>
        </div>
      </div>
      <div className="fy-subsources__actions">
        <button
          type="button"
          className="fy-takepick__use"
          disabled={disabled || !validLanguage || tracks.some((track) => track.language === language)}
          onClick={() => {
            const trackId: TimelineTrackId = `tr_subs-${language}`;
            onCommands([{ kind: "add-subtitle-track", trackId, name: `Subtitles (${language})`, language }], `Add ${language} subtitles`);
            onViewTrack(trackId);
          }}
        >
          Add track
        </button>
        <button type="button" className="fy-takepick__use" disabled={disabled || !validLanguage} onClick={() => fileInput.current?.click()}>
          Import SRT/VTT
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".srt,.vtt,text/vtt,text/plain"
          hidden
          aria-label="Subtitle file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void importFile(file);
          }}
        />
        <button
          type="button"
          className="fy-takepick__use"
          disabled={disabled || !validLanguage || onTranscribe === null}
          title={onTranscribe === null ? "Needs a saved timeline with Dialogue clips" : "One cue per Dialogue clip, from the words the local model hears"}
          onClick={() => onTranscribe?.(viewed?.id ?? `tr_subs-${language}`, viewed?.language ?? language)}
        >
          Draft from speech
        </button>
      </div>
      {report !== null && (
        <p className="fy-cutinspect__note" role="status">
          {report}
        </p>
      )}
    </div>
  );
}
