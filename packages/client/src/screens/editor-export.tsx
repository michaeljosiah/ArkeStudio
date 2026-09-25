import { useState } from "react";
import { PublicationExport } from "./publication-export.js";
import {
  deriveSpineCut,
  resolvePictureTimeline,
  episodeTimelineRange,
  PRESETS,
  defaultExportPreset,
  productionShape,
  type ProductionBundle,
  type RenderPlan,
  buildRenderPlan,
  legacyArtifactScopeRefusal,
  type WorldBundle,
} from "@arke-studio/contracts";
import { EditorDialog } from "../components/editor-dialog.js";
import { runtimeSeconds } from "../lib/format.js";
import { subtitleTracksOf } from "./editor-subtitles.js";
import {
  cancelExport,
  exportCut,
  useExports,
} from "../lib/store.js";
import { storyShotCount } from "./production-story.js";

/**
 * `Add to the library` (SPEC-039 R-8, amended 2026-09-02): the target's picker — scenes on the
 * left, that scene's shots in the middle, filed artifacts on the right, each a checkbox — and one
 * `add-to-library` command on confirm. What is already in the Library shows checked and stays.
 */
/**
 * The export sheet (SPEC-039 R-24, T-5): the target's 430px sheet over the editor — option rows
 * as chips, the gap warning, one primary — with the old Exports screen's judgement behind it:
 * the render plan decides what can be delivered, the same plan the preview draws. Sound options
 * are the timeline's mix, so choosing one is a timeline command, not a private export setting.
 */
function exportAudioStatus(plan: RenderPlan): string | null {
  if (plan.unmeasuredAudio?.length) return plan.audio.length === 0
    ? "No sound — video audio not measured"
    : "Some video sound is unavailable — measurement missing";
  return plan.audio.length === 0 ? "No sound — no audible audio in this cut" : null;
}

export function ExportSheet({
  open,
  onClose,
  worldId,
  prodId,
  world,
  production,
  timelineState,
  onMix,
  commandsDisabled,
}: {
  open: boolean;
  onClose: () => void;
  worldId: string | undefined;
  prodId: string | undefined;
  world: WorldBundle | null;
  production: ProductionBundle | null;
  timelineState: NonNullable<ProductionBundle["timeline"]>;
  onMix: (speechFirst: boolean) => void;
  commandsDisabled: boolean;
}) {
  const exportsState = useExports();
  const [selection, setSelection] = useState<{ worldId: string | undefined; prodId: string | undefined; preset: keyof typeof PRESETS } | null>(null);
  const preset = selection && selection.worldId === worldId && selection.prodId === prodId
    ? selection.preset : defaultExportPreset(production?.meta ?? {});
  const setPreset = (value: keyof typeof PRESETS) => setSelection({ worldId, prodId, preset: value });
  const [subtitleTrack, setSubtitleTrack] = useState<string>("");
  const [subtitleMode, setSubtitleMode] = useState<"none" | "burn-in" | "sidecar" | "burn-in+sidecar">("none");
  const [sidecarFormat, setSidecarFormat] = useState<"srt" | "vtt">("srt");
  if (!open) return null;
  const ready = timelineState.status === "ready";
  let cut: ReturnType<typeof resolvePictureTimeline> | null = null;
  let blockedBy: string | null = null;
  const nothingOnTimeline = "Nothing on the timeline yet. Add to the Library and place, or ask Arke.";
  const legacyScopeRefusal = production ? legacyArtifactScopeRefusal(production, world?.artifacts ?? [], timelineState) : null;
  if (production === null) blockedBy = "No production here.";
  else if (timelineState.status === "invalid") blockedBy = `Timeline unavailable · ${timelineState.message}`;
  else if (legacyScopeRefusal !== null) blockedBy = legacyScopeRefusal;
  else if (!ready) blockedBy = production.spine !== null ? "Open the song on the timeline first." : nothingOnTimeline;
  else {
    try {
      cut = resolvePictureTimeline(production, timelineState, world?.artifacts ?? []);
    } catch (error) {
      blockedBy = error instanceof Error ? error.message : String(error);
    }
  }
  const plan =
    production !== null && ready && blockedBy === null
      ? buildRenderPlan({ production, artifacts: world?.artifacts ?? [], timeline: timelineState, scope: { kind: "production" }, preset })
      : null;
  if (plan !== null && !plan.ok && blockedBy === null) blockedBy = plan.reason;
  /*
   * Nothing to render, said before the encode (issue 453): an empty plan is `concat=n=0`, which is
   * not a filter graph, and the coordinator would only fail it after reporting it running. The
   * Exports screen used to block here; with the screen gone (SPEC-039 T-5) the sheet does. A saved
   * record with nothing on it is, to the person, the same state as no record at all.
   */
  const nothingPlaced = plan?.ok === true && plan.plan.items.length === 0;
  if (nothingPlaced && blockedBy === null) blockedBy = plan?.ok && plan.plan.unmeasuredAudio?.length
    ? "Video audio has not been measured. Import the source video to measure it before exporting."
    : nothingOnTimeline;
  const runtimeSec = plan?.ok === true ? plan.plan.totalSec : null;
  const gaps = cut?.gaps ?? 0;
  const covered = cut === null ? 0 : cut.covered;
  const shotCount = storyShotCount(production);
  const subtitleTracks = ready ? subtitleTracksOf(timelineState.timeline) : [];
  const chosenSubtitleTrack = subtitleTracks.find((track) => track.id === subtitleTrack) ?? subtitleTracks[0] ?? null;
  const subtitleChoice =
    chosenSubtitleTrack !== null && subtitleMode !== "none" ? { trackId: chosenSubtitleTrack.id, mode: subtitleMode, sidecar: sidecarFormat } : undefined;
  const speechFirst = ready ? timelineState.timeline.mix.speechFirst : true;
  const audioStatus = plan?.ok && blockedBy === null ? exportAudioStatus(plan.plan) : null;
  const noAudio = plan?.ok === true && plan.plan.audio.length === 0;
  const mine = Object.entries(exportsState).filter(([, entry]) => entry.productionId === prodId);
  const revision = ready ? timelineState.timeline.revision : null;
  const episodic = production !== null && productionShape(production.meta).isEpisodic;
  const chip = (on: boolean, label: string, pick: () => void, disabled = false) => (
    <button key={label} type="button" className="fy-exsheet__chip" aria-pressed={on} disabled={disabled} onClick={pick}>
      {label}
    </button>
  );
  const presetChips: Array<[keyof typeof PRESETS, string]> = [
    ["review-cut", `${PRESETS["review-cut"].width} × ${PRESETS["review-cut"].height} · review`],
    ["master", `${PRESETS.master.width} × ${PRESETS.master.height} · master`],
    ["vertical-master", `${PRESETS["vertical-master"].width} × ${PRESETS["vertical-master"].height} · vertical master`],
    ["social-excerpt", `${PRESETS["social-excerpt"].width} × ${PRESETS["social-excerpt"].height} · vertical`],
  ];
  const meta =
    cut === null || nothingPlaced
      ? blockedBy ?? ""
      : `${runtimeSeconds(runtimeSec ?? cut.totalSec)}${shotCount ? ` · ${covered} of ${shotCount} shot${shotCount === 1 ? "" : "s"}` : ""}${gaps > 0 ? ` · ${gaps} gap${gaps === 1 ? "" : "s"}` : ""}`;
  return (
    <EditorDialog open={open} title="Export film" subtitle={meta} onClose={onClose} width={430} labelledBy="export-sheet-title">
      <div className="fy-exsheet" data-testid="export-sheet">
        <div className="fy-exsheet__row">
          <span className="fy-exsheet__name">Format</span>
          <span className="fy-exsheet__opts">{chip(true, "H.264 · mp4", () => {})}</span>
        </div>
        <div className="fy-exsheet__row">
          <span className="fy-exsheet__name">Resolution</span>
          <span className="fy-exsheet__opts" role="group" aria-label="Resolution">
            {presetChips.map(([key, label]) => chip(preset === key, label, () => setPreset(key)))}
          </span>
        </div>
        <div className="fy-exsheet__row">
          <span className="fy-exsheet__name">Subtitles</span>
          <span className="fy-exsheet__opts" role="group" aria-label="Subtitle output">
            {subtitleTracks.length === 0 ? (
              <span className="fy-mono fy-exsheet__none">no subtitle track</span>
            ) : (
              (
                [
                  ["burn-in", "Burned in"],
                  ["sidecar", "Sidecar"],
                  ["burn-in+sidecar", "Both"],
                  ["none", "None"],
                ] as const
              ).map(([value, label]) => chip(subtitleMode === value, label, () => setSubtitleMode(value)))
            )}
          </span>
        </div>
        {subtitleTracks.length > 1 && (
          <div className="fy-exsheet__row">
            <span className="fy-exsheet__name">Track</span>
            <select className="fy-exsheet__select" aria-label="Subtitle track" value={chosenSubtitleTrack?.id ?? ""} onChange={(event) => setSubtitleTrack(event.target.value)}>
              {subtitleTracks.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.name} · {track.language}
                </option>
              ))}
            </select>
          </div>
        )}
        {(subtitleMode === "sidecar" || subtitleMode === "burn-in+sidecar") && (
          <div className="fy-exsheet__row">
            <span className="fy-exsheet__name">Sidecar</span>
            <span className="fy-exsheet__opts" role="group" aria-label="Sidecar format">
              {chip(sidecarFormat === "srt", ".srt", () => setSidecarFormat("srt"))}
              {chip(sidecarFormat === "vtt", ".vtt", () => setSidecarFormat("vtt"))}
            </span>
          </div>
        )}
        <div className="fy-exsheet__row">
          <span className="fy-exsheet__name">Audio</span>
          <span className="fy-exsheet__opts" role="group" aria-label="Audio">
            {chip(speechFirst, "Stereo · ducked", () => onMix(true), !ready || commandsDisabled || noAudio)}
            {chip(!speechFirst, "Stereo · flat", () => onMix(false), !ready || commandsDisabled || noAudio)}
            {audioStatus && <span className="fy-exsheet__warn" role="status">{audioStatus}</span>}
            {plan?.ok && !!plan.plan.unmeasuredAudio?.length && <span className="fy-clipmenu__note">
              {plan.plan.unmeasuredAudio.map(item => item.label).join(", ")}
            </span>}
          </span>
        </div>
        {blockedBy !== null && (
          <div className="fy-exsheet__warn" role="status">
            {blockedBy}
          </div>
        )}
        {blockedBy === null && gaps > 0 && (
          <div className="fy-exsheet__warn" role="status">
            {gaps} shot{gaps === 1 ? " has" : "s have"} no accepted take. Exporting now writes a black slate where {gaps === 1 ? "it sits" : "they sit"}.
          </div>
        )}
        {episodic && production !== null && ready && (
          <div className="fy-exsheet__episodes">
            <span className="fy-exsheet__name">Episodes</span>
            {production.episodes.map((episode) => {
              const range = episodeTimelineRange(production, timelineState.timeline, episode.id);
              const episodePlan = range.ok ? buildRenderPlan({ production, artifacts: world?.artifacts ?? [], timeline: timelineState,
                scope: { kind: "episode", episodeId: episode.id }, preset }) : null;
              const refused = !range.ok ? range.reason : episodePlan && !episodePlan.ok ? episodePlan.reason : null;
              const episodeAudio = episodePlan?.ok ? exportAudioStatus(episodePlan.plan) : null;
              // A duplicate order should never be minted (issue 947), but a person reading this
              // list still needs to tell two same-numbered rows apart at a glance.
              const duplicateOrder = production.episodes.filter((e) => e.order === episode.order).length > 1;
              return (
                <div key={episode.id} className="fy-exsheet__episode">
                  <span className="fy-mono">
                    {duplicateOrder && <span className="fy-dot fy-dot--warn" title="Duplicate number" />}
                    {String(episode.order).padStart(2, "0")}
                  </span>
                  <span className="fy-exsheet__eptitle">{episode.release?.title ?? episode.title}</span>
                  {episodeAudio && <span className="fy-exsheet__refused" role="status">
                    {episodeAudio}
                    {episodePlan?.ok && !!episodePlan.plan.unmeasuredAudio?.length &&
                      <span className="fy-clipmenu__note">{episodePlan.plan.unmeasuredAudio.map(item => item.label).join(", ")}</span>}
                  </span>}
                  {refused !== null ? (
                    <span className="fy-mono fy-exsheet__refused">{refused}</span>
                  ) : (
                    <button type="button" className="fy-exsheet__chip" disabled={commandsDisabled} onClick={() => worldId && prodId && exportCut(worldId, prodId, preset, revision, episode.id, subtitleChoice)}>
                      Export episode
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {production && worldId && <PublicationExport worldId={worldId} production={production} world={world} preset={preset} disabled={commandsDisabled} />}
        {mine.length > 0 && (
          <div className="fy-exsheet__delivered">
            <span className="fy-exsheet__name">Delivered</span>
            {mine.slice(-4).map(([id, entry]) => (
              <div key={id} className="fy-exsheet__export">
                <span className="fy-mono">render {id.slice(0, 8)}</span>
                <span className="fy-mono fy-exsheet__status">
                  {entry.status}
                  {entry.status === "running" ? ` · ${Math.round(entry.percent)}%` : ""}
                  {entry.output ? ` · ${entry.output}` : ""}
                  {entry.sidecar ? ` · ${entry.sidecar}` : ""}
                  {entry.error ? ` · ${entry.error}` : ""}
                </span>
                {entry.status === "running" && (
                  <button type="button" className="fy-exsheet__chip" onClick={() => worldId && cancelExport(worldId, id)}>
                    Cancel
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="fy-exsheet__foot">
        <span className="fy-mono">renders locally · no provider call</span>
        <span className="fy-h1row__push" />
        <button type="button" className="fy-libpick__cancel" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="fy-libpick__confirm"
          data-primary="true"
          disabled={blockedBy !== null || !worldId || !prodId || commandsDisabled}
          onClick={() => {
            if (blockedBy !== null || !worldId || !prodId || commandsDisabled) return;
            exportCut(worldId, prodId, preset, revision, undefined, subtitleChoice);
            onClose();
          }}
        >
          {gaps > 0 ? "Export with gaps" : "Export film"}
        </button>
      </div>
    </EditorDialog>
  );
}

// ---- The song clock's export view -------------------------------------------

/**
 * Everything the Exports pane needed to say, decided in one place (issue 283, design 60c). The
 * pane is gone — delivery is the editor's export sheet (SPEC-039 T-5) — but the Cut still reads
 * this view to know which clock a production is on and whether its master is measured.
 *
 * Three review rounds found the same class of defect: a state the screen had not enumerated,
 * falling through a ternary to a number or a sentence belonging to a different state -- the
 * scene-order runtime printed beside "there is no timeline", every missing second called
 * "labelled black" when only slates carry labels, a shot anchored nowhere omitted from the film
 * and from the warning. Each was fixed where it appeared, and the next round found another.
 *
 * So the states are named once, exhaustively, and the runtime, the block and the wording are all
 * derived from the same value. A state that is not in this union cannot be rendered, and a
 * sentence cannot outlive the condition it was written for.
 */
type ExportView =
  | { kind: "scene-order" }
  | { kind: "unavailable"; reason: string }
  | { kind: "no-track" }
  | { kind: "unmeasured" }
  | { kind: "silent"; durationSec: number }
  | { kind: "spine"; cut: ReturnType<typeof deriveSpineCut> };

export function exportViewFor(
  world:
    | { artifacts: readonly { id: string; production?: string | null; mediaInfo?: { durationSec: number; hasAudio: boolean } }[] }
    | null
    | undefined,
  production: ProductionBundle | null | undefined,
): ExportView {
  const spine = production?.spine;
  if (!production || !spine || !world) return { kind: "scene-order" };
  const reason = legacyArtifactScopeRefusal(production, world.artifacts);
  if (reason !== null) return { kind: "unavailable", reason };
  const track = world.artifacts.find((a) => a.id === spine.trackArtifactId);
  // A spine naming an artifact this world does not have is not the same as one nobody measured:
  // the coordinator has no path to probe, so no export can succeed and none should be offered.
  if (track === undefined) return { kind: "no-track" };
  if (track.mediaInfo === undefined) return { kind: "unmeasured" };
  // Measured is not usable. A track with no audio stream refuses every preset in the coordinator.
  if (!track.mediaInfo.hasAudio) return { kind: "silent", durationSec: track.mediaInfo.durationSec };
  return { kind: "spine", cut: deriveSpineCut(production, spine, track.mediaInfo.durationSec) };
}
