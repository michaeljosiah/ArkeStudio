import {
  resolvedAuthoredDuration,
} from "@arke-studio/contracts";
import { type ReactNode } from "react";
import {
  deriveCut,
  deriveSpineCut,
  trimCeilingSec,
  type FrameRate,
  type ProductionBundle,
  type ProductionTimeline,
  type ResolvedPictureCut,
  type TimelineClip,
  type TimelineClipId,
  type TimelineCommand,
  type TimelineTrackId,
  type SourceLengthFrames,
  AUDIO_TRACK_KINDS,
  type TimelineTrack,
  type ArtifactSidecar,
} from "@arke-studio/contracts";
import { clock } from "../components/player.js";
import { reviewableTakesForShot } from "../lib/selectors.js";
import {
  PictureClipTiming,
  DetachAudio,
  TakePicker,
} from "./editor-timeline.js";
import { ClipGain, MixPanel, AudioClipSettings } from "./editor-audio.js";
import { CueInspector, SubtitleSources } from "./editor-subtitles.js";
import { TrimStrip } from "./editor-preview.js";

export type CutSelection = { kind: "picture"; id: string } | { kind: "overlay"; id: string } | { kind: "cue"; id: string };

function InspectorRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fy-cutinspect__row">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

export function CutInspector({
  worldId,
  prodId,
  production,
  cut,
  spineCut,
  artifacts,
  selection,
  selectedClip,
  selectedTrack,
  savedPictureOrder,
  frameRate,
  commandsDisabled,
  onCommands,
  timeline,
  subtitleView,
  onViewSubtitles,
  onTranscribe,
  onFill,
  mintClipId,
  sourceLength,
  nameOf,
  onScrub,
}: {
  worldId: string | undefined;
  prodId: string | undefined;
  production: ProductionBundle | null | undefined;
  cut: ReturnType<typeof deriveCut> | null;
  spineCut: ReturnType<typeof deriveSpineCut> | null;
  artifacts: readonly ArtifactSidecar[];
  selection: CutSelection | null;
  /** The selected clip on any timeline track, when the selection is one. */
  selectedClip: TimelineClip | null;
  selectedTrack: TimelineTrack | null;
  savedPictureOrder: boolean;
  frameRate: FrameRate;
  commandsDisabled: boolean;
  onCommands: (commands: TimelineCommand[], label?: string) => void;
  timeline: ProductionTimeline | null;
  subtitleView: TimelineTrackId | null;
  onViewSubtitles: (trackId: TimelineTrackId | null) => void;
  onTranscribe: ((trackId: TimelineTrackId, language: string) => void) | null;
  /** The export sheet (R-24): the cut view's preset row opens it. */
  /** A gap in the `Needs a decision` list selects its clip, where the takes are chosen (R-22). */
  onFill: (clipId: TimelineClipId) => void;
  mintClipId: () => TimelineClipId;
  /** Measured source lengths, so a typed Out stops where the source does. */
  sourceLength: SourceLengthFrames;
  /** The name a placed file is known by (issue 1005), beside the file the record cites. */
  nameOf: (artifact: ArtifactSidecar) => string;
  /** Bring the viewer to the edge a stepped or typed trim moved (issue 1036). */
  onScrub: (frame: number) => void;
}) {
  const selectedCue =
    selection?.kind === "cue" && timeline !== null
      ? (timeline.tracks
          .flatMap((track) => (track.cues ?? []).map((cue) => ({ track, cue })))
          .find(({ cue }) => cue.id === selection.id) ?? null)
      : null;
  if (selectedCue !== null && production) {
    return <CueInspector track={selectedCue.track} cue={selectedCue.cue} frameRate={frameRate} production={production} disabled={commandsDisabled} onCommands={onCommands} />;
  }
  const selectedOverlay =
    selection?.kind === "overlay"
      ? (production?.cut.overlays.find((clip) => clip.id === selection.id) ?? null)
      : null;
  const overlayArtifact = selectedOverlay
    ? (artifacts.find((artifact) => artifact.id === selectedOverlay.artifactId) ?? null)
    : null;
  const selectedSpine =
    selection?.kind === "picture"
      ? (spineCut?.segments.find(
          (segment) => segment.kind === "clip" && segment.shotId === selection.id,
        ) ?? null)
      : null;
  const clipShotId = selectedClip?.source.kind === "shot" ? selectedClip.source.shotId : null;
  const selectedStory =
    selection?.kind === "picture" && spineCut === null
      ? ((cut as ResolvedPictureCut | null)?.entries.find((entry) => entry.clipId === selection.id) ??
        (clipShotId !== null ? (cut?.entries.find((entry) => entry.shot.id === clipShotId) ?? null) : null))
      : null;
  const selectedShotId = selectedSpine?.shotId ?? clipShotId ?? selectedStory?.shot.id ?? null;
  const selectedTakeId = selectedSpine?.takeId ?? selectedStory?.takeId ?? null;
  const shotTakes = production && selectedShotId ? reviewableTakesForShot(production, selectedShotId) : [];
  const takeIndex = shotTakes.findIndex((take) => take.id === selectedTakeId);
  const takeLabel = takeIndex >= 0
    ? `Take ${takeIndex + 1} · ${shotTakes[takeIndex]!.model}`
    : selectedTakeId ? "Take unavailable" : "no accepted take";
  const ceiling =
    production && selectedShotId && selectedTakeId
      ? trimCeilingSec(production, selectedShotId, selectedTakeId)
      : null;
  const trim = selectedShotId ? (production?.selections[selectedShotId]?.trimInSec ?? 0) : 0;
  const takeSec = selectedTakeId
    ? production?.takeMediaInfo[selectedTakeId]?.mediaInfo.durationSec
    : undefined;

  if (selectedOverlay) {
    const mode = selectedOverlay.audio ?? "keep";
    return (
      <div className="fy-cutinspect">
        <div className="fy-cutinspect__eyebrow">OVERLAY CLIP</div>
        <h2>{overlayArtifact?.file.split("/").pop() ?? "Missing artifact"}</h2>
        <div className="fy-cutinspect__rows">
          <InspectorRow label="Source">{overlayArtifact?.file ?? selectedOverlay.artifactId}</InspectorRow>
          <InspectorRow label="Type">{overlayArtifact?.kind ?? "missing"}</InspectorRow>
          <InspectorRow label="In">{clock(selectedOverlay.startSec)}</InspectorRow>
          <InspectorRow label="Out">{clock(selectedOverlay.endSec)}</InspectorRow>
          <InspectorRow label="Duration">
            {(selectedOverlay.endSec - selectedOverlay.startSec).toFixed(1)}s
          </InspectorRow>
          <InspectorRow label="Lane">Overlay L{selectedOverlay.lane ?? 0}</InspectorRow>
          <InspectorRow label="Sound">
            {mode === "only" ? "sound only" : mode === "mute" ? "muted" : "kept where supported"}
          </InspectorRow>
        </div>
        <p className="fy-cutinspect__note">Drag the clip to move it. Drag either edge to trim; right-click for sound and remove actions.</p>
      </div>
    );
  }

  if (selectedClip && selectedTrack && selectedTrack.kind !== "picture" && production) {
    const label = selectedClip.source.label;
    const artifact = selectedClip.source.kind === "artifact" ? (artifacts.find((candidate) => candidate.id === (selectedClip.source.kind === "artifact" ? selectedClip.source.artifactId : "")) ?? null) : null;
    return (
      <div className="fy-cutinspect">
        <div className="fy-cutinspect__eyebrow">{selectedTrack.kind.toUpperCase()} CLIP</div>
        <h2>{artifact ? nameOf(artifact) : label}</h2>
        <div className="fy-cutinspect__rows">
          <InspectorRow label="Track">{selectedTrack.name}</InspectorRow>
          <InspectorRow label="Source">{artifact?.file ?? (selectedClip.source.kind === "take" ? selectedClip.source.takeId : label)}</InspectorRow>
          {selectedClip.source.kind === "take" && selectedClip.source.sheetId !== undefined && (
            <InspectorRow label="Voice">{selectedClip.source.sheetId}{selectedClip.source.voiceAssignedAtVersion !== undefined ? ` · sheet v${selectedClip.source.voiceAssignedAtVersion}` : ""}</InspectorRow>
          )}
        </div>
        <PictureClipTiming clip={selectedClip} clips={selectedTrack?.clips ?? [selectedClip]} frameRate={frameRate} disabled={commandsDisabled} onCommands={onCommands} onScrub={onScrub} sourceLength={sourceLength} timeline={timeline} />
        {AUDIO_TRACK_KINDS.has(selectedTrack.kind) && <ClipGain clip={selectedClip} disabled={commandsDisabled} onCommands={onCommands} />}
        {AUDIO_TRACK_KINDS.has(selectedTrack.kind) && timeline !== null && (
          <AudioClipSettings clip={selectedClip} track={selectedTrack} disabled={commandsDisabled} onCommands={onCommands} />
        )}
        <p className="fy-cutinspect__note">
          {selectedTrack.kind === "dialogue"
            ? "The Voice role lowers Music and Ambience clips while speech-first mixing is on."
            : "Choose an optional role to control speech-first mixing. Unspecified sound keeps its level."}
        </p>
      </div>
    );
  }

  if (selectedClip && selectedTrack && selectedTrack.kind === "picture" && selectedClip.source.kind === "artifact" && production) {
    const artifact = artifacts.find((candidate) => candidate.id === (selectedClip.source.kind === "artifact" ? selectedClip.source.artifactId : "")) ?? null;
    return (
      <div className="fy-cutinspect">
        <div className="fy-cutinspect__eyebrow">PLACED PICTURE</div>
        <h2>{artifact ? nameOf(artifact) : selectedClip.source.label}</h2>
        <div className="fy-cutinspect__rows">
          <InspectorRow label="Track">{selectedTrack.name}</InspectorRow>
          <InspectorRow label="Source">{artifact?.file ?? selectedClip.source.artifactId}</InspectorRow>
          <InspectorRow label="Type">{artifact?.kind ?? "missing"}</InspectorRow>
          {artifact?.kind === "video" && (
            <div className="fy-cutinspect__row">
              <span>Own sound</span>
              <strong>{selectedClip.audio === "mute" ? "muted" : "kept where measured"}</strong>
            </div>
          )}
        </div>
        <PictureClipTiming clip={selectedClip} clips={selectedTrack?.clips ?? [selectedClip]} frameRate={frameRate} disabled={commandsDisabled} onCommands={onCommands} onScrub={onScrub} sourceLength={sourceLength} timeline={timeline} />
        {timeline && selectedTrack?.kind === "picture" && <DetachAudio production={production} timeline={timeline} artifacts={artifacts} clip={selectedClip} disabled={commandsDisabled} onCommands={onCommands} mintClipId={mintClipId} />}
      </div>
    );
  }

  if ((selectedShotId || selectedClip) && production && worldId && prodId) {
    const sceneNumber = selectedSpine?.sceneNumber ?? selectedStory?.sceneNumber ?? (selectedClip?.source.kind === "shot" ? selectedClip.source.sceneNumber : 0);
    const title = selectedSpine?.label ?? selectedStory?.shot.title ?? selectedClip?.source.label ?? "Picture clip";
    const duration = selectedSpine
      ? selectedSpine.endSec - selectedSpine.startSec
      : selectedClip
        ? selectedClip.durationFrames / frameRate
        : resolvedAuthoredDuration(selectedStory ?? {});
    return (
      <div className="fy-cutinspect">
        <div className="fy-cutinspect__eyebrow">PICTURE CLIP</div>
        <h2>{title}</h2>
        <div className="fy-cutinspect__rows">
          {sceneNumber > 0 && <InspectorRow label="Scene">SC {sceneNumber}</InspectorRow>}
          {selectedShotId && <InspectorRow label="Shot">{selectedShotId.replace("sh_", "shot ")}</InspectorRow>}
          <InspectorRow label="Take"><span title={selectedTakeId ?? undefined}>{takeLabel}</span></InspectorRow>
          <InspectorRow label={selectedSpine ? "Window" : "Shot length"}>{duration.toFixed(1)}s</InspectorRow>
          {takeSec !== undefined && <InspectorRow label="Take length">{takeSec.toFixed(1)}s</InspectorRow>}
        </div>
        {selectedClip && (<>
          <PictureClipTiming clip={selectedClip} clips={selectedTrack?.clips ?? [selectedClip]} frameRate={frameRate} disabled={commandsDisabled} onCommands={onCommands} onScrub={onScrub} sourceLength={sourceLength} timeline={timeline} />
        {timeline && selectedTrack?.kind === "picture" && <DetachAudio production={production} timeline={timeline} artifacts={artifacts} clip={selectedClip} disabled={commandsDisabled} onCommands={onCommands} mintClipId={mintClipId} />}
        </>)}
        {selectedShotId && !savedPictureOrder && (
          <TrimStrip
            worldId={worldId}
            prodId={prodId}
            shotId={selectedShotId}
            heading={`SC ${sceneNumber} · ${selectedShotId.replace("sh_", "shot ")}`}
            title={title}
            figures={`${takeLabel} · ${selectedSpine ? "budget" : "shot"} ${duration.toFixed(1)}s${takeSec !== undefined && !selectedSpine ? ` · take ${takeSec.toFixed(1)}s` : ""}`}
            trim={trim}
            ceiling={ceiling}
          />
        )}
        {selectedClip && clipShotId !== null && (
          <TakePicker
            production={production}
            shotId={clipShotId}
            disabled={commandsDisabled}
            onSwitch={(takeId) => onCommands([{ kind: "switch-take", shotId: clipShotId, takeId }], "Switch take")}
          />
        )}
        <p className="fy-cutinspect__note">
          {savedPictureOrder
            ? "Picture order is owned by the saved timeline. The accepted take still resolves from this shot; the clip's own in and out points are authored here."
            : "Picture order follows the story and accepted shot selections until the first timeline edit. The first edit saves the whole assembly and applies the change."}
        </p>
      </div>
    );
  }

  return (
    <div className="fy-cutinspect">
      <div className="fy-cutinspect__eyebrow">CUT</div>
      <h2>{production?.meta.title ?? "Opening production…"}</h2>
      {/*
        Two of the three things design turn 122 sends away have gone, because neither is the
        selection: the cut's own summary — duration, clips, lanes, coverage — is the header two
        inches away, and `Export preset` belongs behind `Export film`, which is where a person
        goes to change it; it was here because the pane had room, which is the worst reason for
        anything to be anywhere.

        `Needs a decision` stays, against the turn, and the turn is what is wrong until the
        build catches up. It argued the list was the gap's third statement and could go because
        the gap is selectable and selecting it settles it — but `Fill` exists nowhere else in
        the editor, so this list is the only route from "a gap exists" to the clip with its takes
        shown. It goes when the gap carries its own control in the lane, which is what 121 drew.

        What stays besides is authoring: the mix and the subtitle sources are things this panel
        *does*, not things it reports.
      */}
      {cut !== null && spineCut === null && (() => {
        const open = (cut as ResolvedPictureCut).entries.filter((entry) => entry.hole !== true && entry.media === null);
        if (open.length === 0) return null;
        return (
          <div className="fy-cutinspect__decisions" data-testid="needs-decision">
            <div className="fy-cutinspect__eyebrow fy-cutinspect__eyebrow--warn">NEEDS A DECISION</div>
            {open.map((entry) => (
              <div key={entry.clipId ?? entry.shot.id} className="fy-cutinspect__decision">
                <span className="fy-mono">SC {entry.sceneNumber} · SH {entry.shot.number}</span>
                <span className="fy-cutinspect__decisiontitle">{entry.shot.title}</span>
                {entry.clipId !== undefined && (
                  <button type="button" className="fy-takepick__use" onClick={() => onFill(entry.clipId!)}>
                    Fill
                  </button>
                )}
              </div>
            ))}
          </div>
        );
      })()}
      {timeline !== null && <MixPanel mix={timeline.mix} disabled={commandsDisabled} onCommands={onCommands} />}
      {timeline !== null && (
        <SubtitleSources
          timeline={timeline}
          frameRate={frameRate}
          viewedTrackId={subtitleView}
          onViewTrack={onViewSubtitles}
          disabled={commandsDisabled}
          onCommands={onCommands}
          onTranscribe={onTranscribe}
        />
      )}
      <p className="fy-cutinspect__note">Select a clip to inspect its source and timing.</p>
    </div>
  );
}
