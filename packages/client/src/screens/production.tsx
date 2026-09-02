import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { NavLink, Outlet, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import {
  deriveCut,
  deriveSpineCut,
  exportAudioClips,
  exportOverlays,
  isMediaOnly,
  mediaCanvasSec,
  MEDIA_CANVAS_HEADROOM_SEC,
  placedExtentSec,
  placedFilmSec,
  trimCeilingSec,
  guestsOf,
  pendingGuestsOf,
  pendingSheets,
  productionFrameRate,
  resolvePictureTimeline,
  libraryItemKey,
  pickableArtifacts,
  seedFirstPictureTimeline,
  previewEditorRequest,
  editorRequestStaleness,
  timelineSourceFingerprint,
  storyTimelineFingerprint,
  episodeTimelineRange,
  frameDispatchFor,
  modelCapabilityCopy,
  pickableSheets,
  PRESETS,
  productionAspect,
  productionShape,
  STANDARD_ASPECTS,
  DELIVERIES,
  legacyVoiceModel,
  supportedDeliveries,
  type CompiledPass,
  type CompiledReference,
  type Delivery,
  worldSheets,
  attachmentFor,
  lookHoldingScope,
  type CharacterLook,
  type FrameRate,
  type ProductionBundle,
  type ProductionTimeline,
  type ResolvedPictureCut,
  type ResolvedPictureEntry,
  type Scene,
  type TimelineClip,
  type TimelineChangeHistoryEntry,
  type Shot,
  type Take,
  type TimelineClipId,
  type TimelineLibraryItem,
  type TimelineCommand,
  type TimelineTrackId,
  PICTURE_TRACK_ID,
  basePictureTrack,
  buildRenderPlan,
  orderedTrackClips,
  secondsToFrames,
  sourceLengthFramesFor,
  storyOrderDrift,
  ulid,
  AUDIO_TRACK_KINDS,
  cueAtSec,
  type SubtitleStyle,
  type TimelineTrack,
  type Sheet,
  type WorldBundle,
  type ArtifactSidecar,
  MAX_CLIP_LANE,
  type CutOverlay,
  orderedShots,
  legacySceneView,
} from "@arke-studio/contracts";
import { DegradedBanner, EmptyState, Screen } from "../components/layout.js";
import { Badge, Button, Card, Input, Textarea, cx } from "../components/ui.js";
import {
  Archive,
  Book,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Collapse,
  Copy,
  Duck,
  Film,
  Folder,
  Hand,
  Home,
  ListOrdered,
  Locate,
  Message,
  Mic,
  Minus,
  PanelLeft,
  PauseSolid,
  Play,
  Plus,
  Pointer,
  RotateCcw,
  RotateCw,
  Scissors,
  Scroll,
  Search,
  Snap,
  Sparkle,
  Trash,
  Upload,
  Users,
  VideoMark,
  Waveform,
} from "../components/icons.js";
import { EDITOR_KEYS, EditorDialog } from "../components/editor-dialog.js";
import { AppChrome } from "../components/chrome.js";
import { useWorldOpenRefusal, WorldOpenRefusal } from "../components/world-open-refusal.js";
import { Composer } from "../components/composer.js";
import { ProductionConversation, StagedDecision } from "../components/conversation.js";
import { productionModel } from "../components/dispatch-bar.js";
import { Portrait, sheetPortraitPath } from "../components/portrait.js";
import { RemoteVoiceUploadConfirmation } from "../components/remote-voice-upload-confirmation.js";
import { clock } from "../components/player.js";
import { useRailCollapsed } from "../lib/rail-collapsed.js";
import { mediaUrl } from "../lib/media.js";
import { runtimeSeconds, seconds, usd } from "../lib/format.js";
import { acceptedTakeId, isDayOne, mediaTakeFor, takeDecisions, takesForShot, useProduction } from "../lib/selectors.js";
import { lookTileLabel } from "./character-reference.js";
import { DevelopmentWorkspace } from "./development.js";
import { posterize, posterNameFor } from "../lib/poster.js";
import { formatTimecode, useScrubDrag } from "../lib/timeline-drag.js";
import { onMediaReady, syncMediaElement, useTransport } from "../lib/playback-engine.js";
import { mediaTimeFor, videoTimeFor, spanAt, spineSpans, type PlaybackSpan } from "../lib/cut-playback.js";
import { planSpans } from "../lib/plan-playback.js";
import { SceneWorkspace } from "./scene-workspace/workspace.js";
import {
  MIN_CLIP_SEC,
  applyClipDrag,
  snapPointsFor,
  type ClipGesture,
  type ClipPlacement,
} from "../lib/clip-drag.js";
import {
  PictureClipTiming,
  PictureTrack,
  TakePicker,
  pictureClipViews,
  type EditorTool,
  type PictureClipView,
} from "./editor-timeline.js";
import { ARTIFACT_DRAG_TYPE, ClipGain, LANE_DRAG_PICTURE, LANE_DRAG_SOUND, MixPanel, MoveToLane, SHOT_DRAG_TYPE, TypedTrackRows, dragAccepts, laneIcon, type TrackDrop } from "./editor-audio.js";
import { CueInspector, SubtitleSources, SubtitleTrackRow, subtitleTracksOf } from "./editor-subtitles.js";
import { EditorRequestCards } from "./editor-requests.js";
import { usePlanAudio } from "../lib/plan-audio.js";
import {
  acceptTake,
  attachCharacterLook,
  cancelExport,
  createSheetFromSentence,
  attachHostFiles,
  attachHostText,
  hostCanAttach,
  createScene,
  exportCut,
  rejectTake,
  placeOverlay,
  proposeEpisode,
  removeOverlay,
  moveOverlay,
  moveTimelineHistory,
  moveTimelinePictureClip,
  sendTimelineAssemble,
  sendTimelineCommands,
  decideEditorRequest,
  sendTimelineTranscribe,
  rejoinOverlayAudio,
  splitOverlayAudio,
  uploadArtifacts,
  setProductionAspect,
  setShotTrim,
  useExports,
  useStore,
  requestVoiceLine,
  sendBenchOpenSubject,
  subscribeBenchSubjectOpened,
  subscribeQueueResults,
  subscribeSceneCreateResults,
  subscribeTimelineRefusals,
  subscribeVoiceUploadConfirmations,
} from "../lib/store.js";

/** Production screens (§2.9), composed to the prototype frames 11a/14a/11b/24a/25a/25b/10b. */

// ---- small shared pieces ---------------------------------------------------

/**
 * The artifacts a production may see (SPEC-020 R-13): the world's own, plus the ones it owns.
 * Another production's scoped material is absent — selecting audio by kind alone would put one
 * production's scratch takes in every other production's Audio screen.
 */
function artifactsFor<T extends { production?: string }>(
  artifacts: readonly T[],
  productionId: string | undefined,
): T[] {
  return artifacts.filter((a) => a.production === undefined || a.production === productionId);
}

/** Render @mentions the way the prototype does: quiet mono chips inside prose. */
export function Mentions({ text }: { text: string }) {
  const parts = text.split(/(@[A-Za-z0-9-]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("@") ? (
          <span key={i} className="fy-mention">
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/** Deterministic decorative waveform — seeded by the label, no randomness. */
export function Wave({ seed, width = 290, height = 16 }: { seed: string; width?: number; height?: number }) {
  const bars: ReactNode[] = [];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  for (let x = 0; x + 3 <= width; x += 8) {
    h = (h * 1103515245 + 12345) >>> 0;
    const t = (h % 1000) / 1000;
    const bar = 3 + t * (height - 4);
    bars.push(<rect key={x} x={x} y={(height - bar) / 2} width={3} height={bar} rx={1.5} />);
  }
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <g fill="currentColor">{bars}</g>
    </svg>
  );
}

/** A take's poster image, on the shared convention (lib/poster.ts). */
export function takeMediaPath(
  production: Pick<ProductionBundle, "meta" | "takes">,
  take: ProductionBundle["takes"][number],
): string | null {
  const mediaTake = mediaTakeFor(production, take);
  if (mediaTake === null) return null;
  return `productions/${production.meta.id}/takes/${mediaTake.id}/${posterNameFor(mediaTake.media)}`;
}

/**
 * The scene's on-disk stem, from the bundle's scan-captured record (issue 387) — never a
 * reconstruction from number and slug, which goes blind the moment a file's name stops
 * matching. Null means the bundle predates the record; the senders skip rather than guess.
 */
export function sceneFileOf(
  production: { sceneFiles: Record<string, string> } | null | undefined,
  scene: Scene,
): string | null {
  return production?.sceneFiles[scene.id] ?? null;
}

/**
 * Where a scene pressed outside any episode goes: the episode in view, else the last one, else
 * nowhere — a film has no episodes and its scenes belong to none.
 */
export function defaultEpisodeFor(
  production: { episodes: readonly { id: string; order: number }[] } | null | undefined,
  currentEpisodeId?: string,
): string | undefined {
  if (!production) return undefined;
  if (currentEpisodeId !== undefined && production.episodes.some((episode) => episode.id === currentEpisodeId)) {
    return currentEpisodeId;
  }
  return [...production.episodes].sort((a, b) => a.order - b.order).at(-1)?.id;
}

/**
 * The one way a scene begins (SPEC-036 R-37): pressed anywhere, it makes an empty scene and
 * opens it. Pending until the correlated result arrives, the way a production create is
 * (issue 384): success opens the scene it made, never the list; failure is the toaster's to
 * say, so the button here only has to come back.
 */
export function useNewScene(worldId: string | undefined, prodId: string | undefined) {
  const navigate = useNavigate();
  const connection = useStore().connection;
  const [pendingRequest, setPendingRequest] = useState<string | null>(null);
  useEffect(() => {
    if (pendingRequest === null) return;
    return subscribeSceneCreateResults((result) => {
      if (result.requestId !== pendingRequest) return;
      setPendingRequest(null);
      // The destination is the result's own world and production, not this route's (codex,
      // PR 708): the layout stays mounted across a production switch, and a scene made in the
      // one you left must not be opened under the one you arrived at.
      if (result.disposition === "created" && result.sceneId !== undefined) {
        navigate(
          `/w/${encodeURIComponent(result.worldId)}/p/${encodeURIComponent(result.productionId)}/scenes/${encodeURIComponent(result.sceneId)}`,
        );
      }
    });
  }, [pendingRequest, navigate]);
  // A result lost to a dropped connection never arrives — reconnect brings a snapshot, not the
  // answer — and a press that waited on it would stay disabled for the session (codex, PR 708).
  // The scene may well exist by then; the rail shows it, and the press is offered again.
  useEffect(() => {
    if (connection !== "open") setPendingRequest(null);
  }, [connection]);
  return {
    pending: pendingRequest !== null,
    create: (episodeId?: string) => {
      if (!worldId || !prodId || pendingRequest !== null) return;
      setPendingRequest(createScene(worldId, prodId, episodeId === undefined ? {} : { episodeId }));
    },
  };
}

/**
 * The layout's one pending press, shared with the screens under it (codex, PR 708): a press on
 * the Scenes screen followed by a rail link unmounts that screen with its listener, and the
 * scene it made would never be opened. The layout outlives the screens, so it holds the request,
 * and every New scene control in a production reads the same pending state.
 */
const NewSceneContext = createContext<ReturnType<typeof useNewScene> | null>(null);

/** The layout's press where there is one, else this screen's own (screens rendered alone). */
function useSharedNewScene(worldId: string | undefined, prodId: string | undefined) {
  const own = useNewScene(worldId, prodId);
  return useContext(NewSceneContext) ?? own;
}

function decisionTone(decision: string | undefined): "ok" | "warn" | "sketch" {
  if (decision === "accepted") return "ok";
  if (decision === "rejected") return "sketch";
  return "warn";
}

// ---- the production shell (frames 11a/14a left rail) -----------------------

export function ProductionLayout() {
  const { worldId, prodId, episodeId, sceneId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const refusal = useWorldOpenRefusal(worldId);
  const navigate = useNavigate();
  const location = useLocation();
  const exportsState = useExports();
  // The rail is the format's (design 54a): a surface the format cannot use is not present,
  // not greyed. A story production has nothing to dispatch, so its rail never says so.
  const shape = production ? productionShape(production.meta) : null;
  const isStory = shape?.hasChapters === true;
  let cut: ReturnType<typeof deriveCut> | null = null;
  if (production) {
    try {
      cut = production.spine ? deriveCut(production) : resolvePictureTimeline(production, production.timeline);
    } catch {
      // Invalid timeline state is stated in the editor and Exports; the rail must not substitute
      // the legacy runtime while those screens correctly block it.
    }
  }
  /*
   * The rail and the switcher state a length, and it has to be the length the Cut screen states.
   *
   * A production with no story keeps its clock in the clips (issue 453), and the derived cut
   * reads zero there — so both of these advertised a `0s` cut for a film that plays and exports,
   * one panel away from a header saying how long it actually runs (issue 508).
   *
   * Gated exactly as the Cut and Exports screens gate it: a production with a spine is never
   * this, however unresolved that spine is, or the rail would call the clips the film while the
   * screen beside it still treated the song as authoritative.
   */
  const mediaOnly =
    cut !== null && isMediaOnly(cut) && exportViewFor(world, production).kind === "scene-order";
  const filmSec = mediaOnly ? placedFilmSec(production?.cut.overlays ?? [], world?.artifacts ?? []) : 0;
  const audioCount =
    (artifactsFor(world?.artifacts ?? [], prodId).filter((a) => a.kind === "audio").length ?? 0) +
    (production?.scenes
      .flatMap((s) => orderedShots(s))
      .filter((s) => s.audio?.kind === "vo" || s.audio?.kind === "dialogue").length ?? 0);
  const artifactCount = (world?.artifacts ?? []).filter((artifact) => artifact.production === undefined).length;
  const exportCount = Object.values(exportsState).filter((e) => e.productionId === prodId).length;
  const guestCount = prodId
    ? guestsOf(world?.sheets ?? [], prodId).filter((s) => s.retired !== true).length
    : 0;
  const base = `/w/${worldId}/p/${prodId}`;
  /*
   * Folded (82a, then turn 101): the Cut opens the world's artifacts beside it, and the width has
   * to come from somewhere. It comes from the labels, never from the destinations — every place
   * the rail reached is still one click away, as a mark with its name on the tooltip.
   *
   * That was route-driven, which meant the width was the app's decision and not the person's. It
   * is a control now, remembered for the session — the module variable behind useRailCollapsed
   * says why it is not longer-lived; the Cut is only what it does before anybody has said
   * otherwise. `null` is "never asked", which is why this is not a plain boolean.
  */
  const [railChoice, setRailChoice] = useRailCollapsed();
  const [episodeExpansion, setEpisodeExpansion] = useState<Record<string, boolean>>({});
  const newScene = useNewScene(worldId, prodId);
  const sceneDetailDefault = /\/scenes\/[^/]+\/?$/.test(location.pathname);
  const folded = railChoice ?? (location.pathname.endsWith("/cut") || sceneDetailDefault);
  /*
   * A mark for every destination, without exception (turn 101). Folded, the label is the tooltip
   * and the mark is the whole item, so a rail entry with no mark is an entry that disappears —
   * which is what happened to `New scene` and `Story structure`, both drawn as a different shape.
   * One shape, one mark, one count: that is the whole of "standardised".
   */
  const MARKS: Record<string, (p: { size?: number }) => ReactNode> = {
    "": Home,
    artifacts: Folder,
    cast: Users,
    story: Message,
    overview: Scroll,
    season: Film,
    "story/chapters": Book,
    "story-structure": Folder,
    scenes: Film,
    "branch-map": ListOrdered,
    takes: VideoMark,
    generate: Sparkle,
    cut: VideoMark,
    audio: Waveform,
    exports: Archive,
  };
  /*
   * An episode is reached by drilling into the episode tree, and both of its screens live outside
   * the `season` path — the chat under `story/episodes/:id`, the page under `episodes/:id` (turn 91).
   * Neither lights the Episodes item on its own, so the tree claims both child routes explicitly.
   */
  const inEpisode = /\/episodes\//.test(location.pathname);
  /* `/season` keeps working as an address and now lands on the same screen as the index. */
  const inSeason = inEpisode || location.pathname.endsWith("/season");
  /* A scene's chat lives under `story/` beside the production's own, so Scenes owns it too. */
  // A scene's screens include the full shot underneath it (turn 94's ownership rule) — no `$`,
  // or the rail goes blank exactly at /scenes/:id/shots/:id, three levels deep.
  const inScene = /\/scenes\/[^/]+/.test(location.pathname);
  const item = (
    slug: string,
    label: string,
    count?: string,
    end?: boolean,
    also?: boolean,
    under?: boolean,
    destination?: string,
    active?: boolean,
  ) => {
    const Mark = MARKS[slug];
    return (
      <NavLink
        key={`${slug || "dash"}:${label}`}
        to={destination ?? `${base}${slug ? `/${slug}` : ""}`}
        end={end ?? slug === ""}
        title={folded ? label : undefined}
        aria-current={active === undefined ? undefined : active ? "page" : "false"}
        className={({ isActive }) =>
          cx(
            "fy-prodrail__item",
            under && "fy-prodrail__item--under",
            (active ?? (isActive || also)) && "fy-prodrail__item--active",
          )
        }
      >
        {Mark !== undefined && (
          <span className="fy-prodrail__mark" aria-hidden={!folded}>
            <Mark size={15} />
          </span>
        )}
        <span className="fy-prodrail__label">{label}</span>
        {count !== undefined && <span className="fy-prodrail__count">{count}</span>}
      </NavLink>
    );
  };
  /*
   * Two figures, because the rail states the cut and the switcher states how much of it is
   * covered — and one figure for a production with no story, which has no shots to cover and only
   * ever had one length. It is written as a measurement, the way the Cut header and the Exports
   * button write it: a 0.4s film is real and exportable, and rounding it to `0s` would make it
   * look exactly like the empty production the export refuses.
   */
  const railFigure = mediaOnly ? runtimeSeconds(filmSec) : seconds(cut?.totalSec ?? 0);
  const cutFigure = mediaOnly
    ? runtimeSeconds(filmSec)
    : seconds((cut?.totalSec ?? 0) - (cut?.uncoveredSec ?? 0));
  // The switch card counts what the format counts: seconds of cut for video, chapters for story.
  const switchSub = production
    ? shape?.isEpisodic
      ? `series · ${production.episodes.length} episode${production.episodes.length === 1 ? "" : "s"} · ${production.scenes.length} scene${production.scenes.length === 1 ? "" : "s"}`
      : isStory
      ? `${shape!.displayLabel.toLowerCase()} · ${production.chapters.length} chapter${production.chapters.length === 1 ? "" : "s"}`
      : `${shape!.displayLabel.toLowerCase()}${cut ? ` · ${cutFigure} cut` : ""}`
    : "";
  const currentEpisodeId =
    episodeId ?? production?.episodes.find((episode) => sceneId !== undefined && episode.scenes.includes(sceneId))?.id;
  const episodes = [...(production?.episodes ?? [])].sort((a, b) => a.order - b.order);
  const scenesById = new Map((production?.scenes ?? []).map((scene) => [scene.id, scene]));
  const episodePrefix = prodId === undefined ? null : `productions/${prodId}/episodes/`;
  const episodeStems = new Set(Object.values(production?.episodeFiles ?? {}));
  const pendingEpisodeCreate =
    episodePrefix !== null &&
    (world?.proposals ?? []).some((staged) =>
      staged.proposal.targets.some((target) => {
        if (!target.path.startsWith(episodePrefix) || !target.path.endsWith(".json")) return false;
        const stem = target.path.slice(episodePrefix.length, -".json".length);
        return stem.length > 0 && !stem.includes("/") && !episodeStems.has(stem);
      }),
    );
  const generateView = new URLSearchParams(location.search).get("view");
  const inGenerate = location.pathname.endsWith("/generate");
  const takesActive = inGenerate && generateView !== "bench";
  const generateActive = inGenerate && generateView === "bench";
  return (
    <div className="fy-app">
      <AppChrome
        back={{ label: "World", to: `/w/${worldId}` }}
        context={{
          label: production && shape ? `${production.meta.title} · ${shape.displayLabel.toLowerCase()}` : "…",
          to: `/w/${worldId}/productions`,
        }}
      />
      <div className="fy-prod">
        <div
          className={cx(
            "fy-prodrail",
            shape?.isEpisodic && "fy-prodrail--episodic",
            folded && "fy-prodrail--folded",
          )}
        >
          {/* The person's own control (turn 101), where the prototype puts it. It sits above the
              switcher so folding never moves the thing you were about to press. */}
          <button
            type="button"
            className="fy-prodrail__collapse"
            title={folded ? "Expand the rail" : "Collapse the rail"}
            aria-label={folded ? "Expand the rail" : "Collapse the rail"}
            aria-expanded={!folded}
            onClick={() => setRailChoice(!folded)}
          >
            <PanelLeft size={14} />
          </button>
          <button
            type="button"
            className="fy-prodrail__switch"
            aria-label={`Switch production. Current production: ${production?.meta.title ?? "loading"}`}
            title={folded ? `Switch production · ${production?.meta.title ?? "loading"}` : undefined}
            onClick={() => navigate(`/w/${worldId}/productions`)}
          >
            <span className="fy-prodrail__switchmark" aria-hidden>
              {(production?.meta.title ?? "P").trim().charAt(0).toUpperCase() || "P"}
            </span>
            <div className="fy-prodrail__switchcopy">
              <div className="fy-prodrail__switchname">{production?.meta.title ?? "…"}</div>
              <div className="fy-prodrail__switchsub">{switchSub}</div>
            </div>
            <span className="fy-prodrail__switchchevron">
              {shape?.isEpisodic ? <ChevronsUpDown size={13} /> : <ChevronRight size={14} />}
            </span>
          </button>
          <span className="fy-prodrail__fold-divider" aria-hidden />
          {shape?.isEpisodic ? (
            <>
              {item("", "Overview", undefined, true)}
              {item(
                "season",
                "Episodes",
                String(production?.episodes.length ?? 0),
                true,
                inSeason || inScene,
              )}
              <div className="fy-prodrail__episodes">
                {episodes.map((episode) => {
                  const open = episodeExpansion[episode.id] ?? episode.id === currentEpisodeId;
                  return (
                    <div key={episode.id} className="fy-prodrail__episode">
                      <button
                        type="button"
                        className="fy-prodrail__episode-toggle"
                        aria-expanded={open}
                        aria-label={`${open ? "Collapse" : "Expand"} Episode ${episode.order}: ${episode.title}`}
                        onClick={() =>
                          setEpisodeExpansion((current) => ({ ...current, [episode.id]: !open }))
                        }
                      >
                        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                        <span className="fy-prodrail__episode-name">
                          Episode {episode.order} · {episode.title}
                        </span>
                        <span className="fy-prodrail__episode-count">{episode.scenes.length}</span>
                      </button>
                      {open && (
                        <div className="fy-prodrail__scenes">
                          {episode.scenes.map((id, index) => {
                            const scene = scenesById.get(id);
                            return scene === undefined ? (
                              <span key={id} className="fy-prodrail__scene fy-prodrail__scene--missing">
                                {index + 1} · Missing scene
                              </span>
                            ) : (
                              <NavLink
                                key={scene.id}
                                to={`${base}/scenes/${scene.id}`}
                                className={({ isActive }) =>
                                  cx("fy-prodrail__scene", isActive && "fy-prodrail__scene--active")
                                }
                              >
                                <span className="fy-prodrail__scene-name">
                                  {scene.number} · {scene.title}
                                </span>
                                <span className="fy-prodrail__scene-dot" aria-hidden />
                              </NavLink>
                            );
                          })}
                          <button
                            type="button"
                            className="fy-prodrail__new-scene"
                            disabled={newScene.pending}
                            onClick={() => newScene.create(episode.id)}
                          >
                            <Plus size={11} />
                            New scene
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
                {production && (
                  <button
                    type="button"
                    className="fy-prodrail__new-episode"
                    disabled={pendingEpisodeCreate}
                    onClick={() => {
                      if (!worldId || !prodId) return;
                      const order = Math.max(0, ...production.episodes.map((episode) => episode.order)) + 1;
                      proposeEpisode(worldId, prodId, {
                        title: `Episode ${String(order).padStart(2, "0")}`,
                        order,
                      });
                    }}
                  >
                    <Plus size={11} />
                    {pendingEpisodeCreate ? "New episode pending" : "New episode"}
                  </button>
                )}
              </div>
              <span className="fy-prodrail__section-divider" aria-hidden="true" />
              {item(
                "takes",
                "Takes",
                String(production?.takes.length ?? 0),
                false,
                false,
                false,
                `${base}/generate`,
                takesActive,
              )}
              {item(
                "artifacts",
                "Artifacts",
                String(artifactCount),
                false,
                false,
                false,
                `/w/${worldId}/artifacts`,
              )}
              {item("audio", "Audio", String(audioCount))}
              {item(
                "generate",
                "Generate",
                String(production?.takes.length ?? 0),
                false,
                false,
                false,
                `${base}/generate?view=bench`,
                generateActive,
              )}
              {item("cut", "Cut", cut ? railFigure : "0:00")}
              {item("exports", "Exports", String(exportCount))}
            </>
          ) : (
            <>
              {item("", "Dashboard")}
              {/* Cast is on both formats' rails (SPEC-020 R-9): a story has a cast as much as a
                  video does, and the count is the guests — the number the rail can say something
                  true about, since the world's cast is shared and belongs to the world's own rail. */}
              {item("cast", "Cast", String(guestCount))}
              {isStory ? (
                <>
                  {item("story", "Develop", "chat", true)}
                  {item("overview", "Overview", production?.story ? `v${production.story.version}` : "—")}
                  {item("story/chapters", "Chapters", String(production?.chapters.length ?? 0))}
                  {item("audio", "Audio", String(audioCount))}
                  {item("exports", "Exports", String(exportCount))}
                </>
              ) : (
                <>
                  {item("story", "Develop", "chat", true)}
                  {item("overview", "Overview", production?.story ? `v${production.story.version}` : "—")}
                  {item("scenes", "Scenes", String(production?.scenes.length ?? 0), false, inScene)}
                  {/* Interactive video's structural authority (epic 401): only this Video kind routes here. */}
                  {shape?.isBranching &&
                    item("branch-map", "Branch map", String(production?.routing?.choices.length ?? 0))}
                  {/* A press, not a destination (SPEC-036 R-37): it makes the scene and opens it. */}
                  <button
                    type="button"
                    className="fy-prodrail__item fy-prodrail__item--under fy-prodrail__item--press"
                    title={folded ? "New scene" : undefined}
                    disabled={newScene.pending}
                    onClick={() => newScene.create(defaultEpisodeFor(production, currentEpisodeId))}
                  >
                    <span className="fy-prodrail__mark" aria-hidden={!folded}>
                      <Plus size={15} />
                    </span>
                    <span className="fy-prodrail__label">New scene</span>
                  </button>
                  <span className="fy-prodrail__section-divider" aria-hidden="true" />
                  {/* Stills is a lens on Generate now (design 55a), not a rail destination. */}
                  {item("generate", "Generate", String(production?.takes.length ?? 0))}
                  {item("cut", "Cut", cut ? railFigure : "0:00")}
                  {item("audio", "Audio", String(audioCount))}
                  {item("exports", "Exports", String(exportCount))}
                </>
              )}
            </>
          )}
          <div className="fy-prodrail__spacer" />
          <NavLink
            to={`/w/${worldId}`}
            className="fy-prodrail__foot"
            title={folded ? `Part of ${world?.meta.name ?? "the world"}` : undefined}
          >
            <ChevronLeft size={13} />
            {/* The label folds with every other label; the mark and its tooltip carry it. */}
            <span className="fy-prodrail__label">Part of {world?.meta.name ?? "the world"}</span>
          </NavLink>
        </div>
        <div className="fy-prodwrap">
          {/* The production tree is a sibling of the world tree, not a child of it (App.tsx), so
              the world-open refusal has to be stated here too — otherwise a reload or deep link
              onto a production leaves every screen under it on its loader forever (issue 571). */}
          {refusal ? (
            <WorldOpenRefusal worldId={worldId!} reason={refusal.reason} />
          ) : (
            <NewSceneContext.Provider value={newScene}>
              <Outlet />
            </NewSceneContext.Provider>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Cast (SPEC-020) -------------------------------------------------------

/**
 * The production's cast, in two bands: the guests it owns, and the world's cast it draws on.
 *
 * The bands are the whole point of the screen (R-9). Both sets of people are equally usable in a
 * shot — a guest is a full sheet, and resolution never asks who owns it (R-5) — so the only thing
 * separating them is what happens to them when this production ends. Naming that on the surface
 * is cheaper than discovering it later, when a one-off barman has quietly become part of the
 * world's permanent record.
 */
/**
 * The picker's labels, disambiguated only where they collide (codex round 2).
 *
 * A look's caption is the exploration's own words, and one exploration returns several results —
 * so accepting more than one from a batch gives looks whose `prompt` and `kind` are identical and
 * whose ids and files are not. The picker is text, unlike the gallery it came from, so those
 * arrived as several indistinguishable options over different images.
 *
 * Numbered in acceptance order, which is the order the kit stores them in, and only where a
 * caption is claimed more than once — a lone look carries no number to read.
 */
export function lookPickerLabels(looks: readonly CharacterLook[]): Map<string, string> {
  const caption = (look: CharacterLook): string => lookTileLabel(look.prompt, look.kind);
  const claims = new Map<string, number>();
  for (const look of looks) claims.set(caption(look), (claims.get(caption(look)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const look of looks) {
    const text = caption(look);
    if ((claims.get(text) ?? 0) < 2) {
      labels.set(look.id, text);
      continue;
    }
    const nth = (seen.get(text) ?? 0) + 1;
    seen.set(text, nth);
    labels.set(look.id, `${text} ${nth}`);
  }
  return labels;
}

/**
 * What choosing this option would take it away from (design 67, codex round 1).
 *
 * A look holds one `attachedTo`, so picking one that is already spoken for is a *move*: the
 * other production silently drops back to its identity package, or a scene loses its override.
 * The option says where it currently rides, so the move is visible at the point of choice — a
 * label rather than a confirmation, because the change is one field and reattaching undoes it.
 *
 * The look this production already holds says nothing: it is the selected option, and "here" is
 * not news.
 */
export function lookOptionScope(
  look: CharacterLook,
  production: ProductionBundle,
  productions: readonly ProductionBundle[],
): string | null {
  const scope = look.attachedTo;
  if (!scope) return null;
  if (scope.productionId === production.meta.id) {
    if (scope.kind === "production") return null;
    const scene = production.scenes.find((candidate) => candidate.id === scope.sceneId);
    return scene ? `Sc ${scene.number}` : null;
  }
  const owner = productions.find((candidate) => candidate.meta.id === scope.productionId);
  if (!owner) return null;
  if (scope.kind === "production") return `in ${owner.meta.title}`;
  const scene = owner.scenes.find((candidate) => candidate.id === scope.sceneId);
  // A scope whose scene is gone rides nowhere, so there is nothing here to warn about taking.
  return scene ? `in ${owner.meta.title} Sc ${scene.number}` : null;
}

/**
 * What each character wears in this production (design 67).
 *
 * A look is attached on the character's own looks page, and until now the production it was
 * attached *to* had no idea: `production.tsx` never mentioned character looks, and the dispatch
 * dialog counts references without naming one. So the one decision that changes what a model
 * receives for this production was made on a screen belonging to the world, and confirmed
 * nowhere. This is the return path — the production says who it is sending, and lets the choice
 * be made where the consequence lives.
 *
 * Rows exist only for characters that have accepted looks: a character with no alternatives has
 * no choice to offer, and a row saying so is noise.
 */
function ProductionWardrobe({
  world,
  production,
  characters,
}: {
  world: WorldBundle;
  production: ProductionBundle;
  characters: Sheet[];
}) {
  const rows = characters
    .map((sheet) => {
      const kit = world.referenceKits.find((candidate) => candidate.sheetId === sheet.id) ?? null;
      const looks = kit?.looks ?? [];
      return { sheet, kit, looks };
    })
    .filter((row) => row.looks.length > 0);
  if (rows.length === 0) return null;
  return (
    <>
      <div className="fy-eyebrow-sm" style={{ padding: "10px 90px 0" }}>
        WARDROBE · IN {production.meta.title.toUpperCase()} · {rows.length}
      </div>
      <div className="fy-wardrobe">
        {rows.map(({ sheet, kit, looks }) => {
          // The file the dispatcher would actually attach, resolved by the same function it
          // resolves with — not a second opinion about what rides.
          const riding = attachmentFor(kit, sheet, "primary", { productionId: production.meta.id });
          // The same rule the dispatcher resolves with, not a second `.find` over the same array
          // (codex round 4): on an upgraded kit holding two production-scoped looks, marking the
          // first while the dispatcher carries the latest is a false confirmation of the one
          // thing this row exists to confirm.
          const held = lookHoldingScope(kit, { kind: "production", productionId: production.meta.id });
          /* Scene attachments are stated, not offered: this row is the production's altitude,
             and a scene's own choice belongs on the scene. Narrower scope wins at dispatch, so
             a row claiming to be the whole answer while a scene overrides it would be lying. */
          const labels = lookPickerLabels(looks);
          // Read per scene, not per look, so each scene resolves to the one look the dispatcher
          // would carry. Walking the looks instead listed every claimant, and an upgraded kit can
          // hold two on one scene — so the line reported two live appearances for a scene that
          // dispatches one, on the row whose whole job is saying which. It also reads in scene
          // order now, which is the order somebody looks for a scene in.
          const perScene = production.scenes.flatMap((scene) => {
            const look = lookHoldingScope(kit, {
              kind: "scene",
              productionId: production.meta.id,
              sceneId: scene.id,
            });
            return look ? [{ id: look.id, scene, label: labels.get(look.id) ?? "" }] : [];
          });
          return (
            <div className="fy-wardrobe__row" key={sheet.id}>
              <div className="fy-wardrobe__thumb">
                <Portrait
                  worldSlug={world.meta.slug}
                  path={riding.file ?? sheetPortraitPath(sheet.id)}
                  label={sheet.name}
                  radius={8}
                />
              </div>
              <div className="fy-wardrobe__who">
                <span className="fy-wardrobe__name">{sheet.name}</span>
                {perScene.length > 0 && (
                  <span className="fy-wardrobe__scenes">
                    {perScene.map((entry) => `Sc ${entry.scene.number} · ${entry.label}`).join("  ")}
                  </span>
                )}
              </div>
              <label className="fy-wardrobe__pick">
                <span>Wears</span>
                <select
                  value={held?.id ?? ""}
                  onChange={(event) => {
                    const chosen = event.target.value;
                    // One frame either way (issue 384's lesson about concurrent frames): choosing a
                    // look attaches it and the coordinator displaces the incumbent; choosing the
                    // identity package detaches the one that is held.
                    if (chosen === "") {
                      if (held) attachCharacterLook(world.meta.worldId, sheet.id, held.id, null);
                      return;
                    }
                    attachCharacterLook(world.meta.worldId, sheet.id, chosen, {
                      kind: "production",
                      productionId: production.meta.id,
                    });
                  }}
                >
                  <option value="">Identity package</option>
                  {looks.map((look) => {
                    const elsewhere = lookOptionScope(look, production, world.productions);
                    return (
                      <option key={look.id} value={look.id}>
                        {labels.get(look.id) ?? ""}
                        {elsewhere ? ` · ${elsewhere}` : ""}
                      </option>
                    );
                  })}
                </select>
              </label>
            </div>
          );
        })}
      </div>
    </>
  );
}

export function ProductionCastScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const [drafting, setDrafting] = useState<{
    type: "character" | "location" | "faction";
    name: string;
    sentence: string;
  } | null>(null);

  if (!world || !production) {
    return (
      <Screen id="production-cast">
        <EmptyState title="Opening the cast…" />
      </Screen>
    );
  }
  const guests = guestsOf(world.sheets, production.meta.id).filter((s) => s.retired !== true);
  const fromWorld = worldSheets(world.sheets).filter((s) => s.retired !== true);
  // Guests under review are kept off the world's surfaces, so they have to be visible here or a
  // staged guest is nowhere at all until it is accepted (SPEC-020 R-8, R-9).
  const pendingGuests = (["character", "location", "faction"] as const).flatMap((kind) =>
    pendingGuestsOf(pendingSheets(world.proposals, kind), production.meta.id),
  );
  // Owned artifacts are off the world's shelf (R-13), so this is the only place they appear.
  const owned = world.artifacts.filter((a) => a.production === production.meta.id);
  const kindLabel = (sheet: Sheet) =>
    sheet.type === "character" ? "character" : sheet.type === "location" ? "location" : "faction";

  const card = (sheet: Sheet, guest: boolean) => (
    <button
      key={sheet.id}
      type="button"
      className="fy-gridcard fy-gridcard--media fy-gridcard--fixed"
      onClick={() =>
        navigate(`/w/${worldId}/${sheet.type === "character" ? "cast" : `${sheet.type}s`}/${sheet.id}`)
      }
    >
      <div className="fy-gridcard__frame" style={{ height: 210 }}>
        <Portrait worldSlug={world.meta.slug} path={sheetPortraitPath(sheet.id)} label={sheet.name} />
      </div>
      <div className="fy-gridcard__pad">
        <div className="fy-gridcard__title">
          <span className="fy-gridcard__name">{sheet.name}</span>
          <span
            className={`fy-dot fy-dot--${sheet.status === "locked" ? "ok" : "sketch"}`}
            style={{ width: 6, height: 6 }}
          />
        </div>
        <div className="fy-gridcard__body">{sheet.role ?? sheet.region ?? kindLabel(sheet)}</div>
        <div className="fy-gridcard__foot" style={{ marginTop: 9 }}>
          {guest ? `guest · v${sheet.version}` : `${kindLabel(sheet)} · v${sheet.version}`}
        </div>
      </div>
    </button>
  );

  const columns = (n: number) => ({
    gridTemplateColumns: `repeat(${Math.min(Math.max(n, 2), 4)}, minmax(0, 1fr))`,
  });

  return (
    <div data-screen="production-cast">
      <div className="fy-corner">
        <Button
          variant="primary"
          onClick={() =>
            setDrafting(drafting === null ? { type: "character", name: "", sentence: "" } : null)
          }
        >
          New guest
        </Button>
      </div>
      <div className="fy-hero">
        <div className="fy-eyebrow-sm">CAST · {production.meta.title.toUpperCase()}</div>
        <h1 className="fy-hero__title" style={{ fontSize: 52 }}>
          Cast
        </h1>
        <p className="fy-hero__lede" style={{ fontSize: 15, maxWidth: 520 }}>
          Guests belong to this production alone. The world's cast is shared with everything else{" "}
          {world.meta.name} holds — change one and every production sees it.
        </p>
      </div>

      {drafting !== null && (
        <Card className="scr-form">
          <div className="scr-field">
            <label className="scr-field__label">
              A guest of {production.meta.title} — a full sheet, kept out of the world's cast until you
              promote it
            </label>
            <div style={{ display: "flex", gap: "var(--space-2)", marginBottom: 8 }}>
              {(["character", "location", "faction"] as const).map((type) => (
                <Button
                  key={type}
                  variant={drafting.type === type ? "primary" : "ghost"}
                  onClick={() => setDrafting({ ...drafting, type })}
                >
                  {type}
                </Button>
              ))}
            </div>
            <Input
              placeholder="Name"
              value={drafting.name}
              onChange={(e) => setDrafting({ ...drafting, name: e.target.value })}
            />
          </div>
          <div className="scr-field">
            <label className="scr-field__label">
              One sentence — the agent drafts the rest inside the sketch
            </label>
            <Textarea
              rows={2}
              value={drafting.sentence}
              onChange={(e) => setDrafting({ ...drafting, sentence: e.target.value })}
            />
          </div>
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button
              variant="primary"
              disabled={drafting.name.trim().length === 0 || drafting.sentence.trim().length === 0}
              onClick={() => {
                if (worldId) {
                  createSheetFromSentence(
                    worldId,
                    drafting.type,
                    drafting.name.trim(),
                    drafting.sentence.trim(),
                    false,
                    production.meta.id,
                  );
                }
                setDrafting(null);
              }}
            >
              Stage guest
            </Button>
            <Button variant="ghost" onClick={() => setDrafting(null)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      <div className="fy-eyebrow-sm" style={{ padding: "10px 90px 0" }}>
        GUESTS · ONLY IN {production.meta.title.toUpperCase()} · {guests.length + pendingGuests.length}
      </div>
      {guests.length + pendingGuests.length === 0 ? (
        <div style={{ padding: "0 90px" }}>
          <EmptyState
            title="No guests yet"
            hint="People and places this production needs but the world does not — the barman with two lines, the room above the chandlery."
          />
        </div>
      ) : (
        <div className="fy-cardgrid" style={columns(guests.length + pendingGuests.length)}>
          {pendingGuests.map((p) => (
            <div
              key={p.proposalId}
              className="fy-gridcard fy-gridcard--media fy-gridcard--fixed fy-gridcard--quiet"
            >
              <div className="fy-gridcard__frame" style={{ height: 210 }} />
              <div className="fy-gridcard__pad">
                <div className="fy-gridcard__title">
                  <span className="fy-gridcard__name">{p.name}</span>
                </div>
                <div className="fy-gridcard__body">awaiting review</div>
                <div className="fy-gridcard__foot" style={{ marginTop: 9 }}>
                  guest · not yet accepted
                </div>
              </div>
            </div>
          ))}
          {guests.map((sheet) => card(sheet, true))}
        </div>
      )}

      <div className="fy-eyebrow-sm" style={{ padding: "10px 90px 0" }}>
        FROM {world.meta.name.toUpperCase()} · SHARED · {fromWorld.length}
      </div>
      {fromWorld.length === 0 ? (
        <div style={{ padding: "0 90px" }}>
          <EmptyState
            title="The world has no cast yet"
            hint="Everything this production cites would be its own."
          />
        </div>
      ) : (
        <div className="fy-cardgrid" style={columns(fromWorld.length)}>
          {fromWorld.map((sheet) => card(sheet, false))}
        </div>
      )}

      <ProductionWardrobe
        world={world}
        production={production}
        characters={[...guests, ...fromWorld].filter((sheet) => sheet.type === "character")}
      />

      {owned.length > 0 && (
        <>
          <div className="fy-eyebrow-sm" style={{ padding: "10px 90px 0" }}>
            FILED HERE · ONLY IN {production.meta.title.toUpperCase()} · {owned.length}
          </div>
          <div style={{ padding: "8px 90px 30px", display: "grid", gap: 8 }}>
            {owned.map((artifact) => (
              <div
                key={artifact.id}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 10,
                  padding: "9px 4px",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <span style={{ flex: 1, font: "400 13px var(--font-sans)" }}>{artifact.file}</span>
                <span className="fy-mono" style={{ color: "var(--muted-foreground)" }}>
                  {artifact.kind}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---- Dashboard (11a; day-one variant from 33a) -----------------------------

/**
 * The production's front page (design turn 93).
 *
 * An episodic production's is its season: turn 91 settled that a production is exactly one
 * season, so the production's address and the season's are the same address, and keeping them
 * apart is what let one screen say "nothing written yet" while the other said "3 written". Every
 * other medium keeps the dashboard, which has no season to be.
 *
 * The branch is a component boundary rather than an early return — returning before the
 * dashboard's own hooks breaks the Rules of Hooks the moment a production's shape settles after
 * first render, which is what happens on every cold open.
 */
export function ProductionHomeScreen() {
  const { worldId, prodId } = useParams();
  const { production } = useProduction(worldId, prodId);
  if (production && productionShape(production.meta).isEpisodic) return <DevelopmentWorkspace />;
  return <ProductionDashboardScreen />;
}

export function ProductionDashboardScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const newScene = useSharedNewScene(worldId, prodId);
  if (!world || !production) {
    return (
      <Screen id="production-dashboard">
        <EmptyState title="Opening production…" />
      </Screen>
    );
  }
  // The dashboard resumes the format's unit of work (design 54a). For story that is the
  // chapter, and nothing here mentions shots, takes, clips or dispatch.
  if (productionShape(production.meta).hasChapters) {
    const chapters = production.chapters;
    const drafted = chapters.filter((c) => (c.words ?? 0) > 0);
    const totalWords = chapters.reduce((sum, c) => sum + (c.words ?? 0), 0);
    const inHand = chapters.find((c) => !c.words) ?? null;
    const inHandIdx = inHand ? chapters.indexOf(inHand) : -1;
    // The design shows the neighbourhood of the chapter in hand, not the whole book —
    // the chapter tree is one click away for that.
    const windowStart =
      inHandIdx >= 0
        ? Math.max(0, Math.min(inHandIdx - 1, chapters.length - 4))
        : Math.max(0, chapters.length - 4);
    const nearby = chapters.slice(windowStart, windowStart + 4);
    return (
      <div className="fy-prodmain" data-screen="production-dashboard">
        <div className="fy-h1row">
          <h1 className="fy-h1">{chapters.length === 0 ? "Day one." : "Here's where you left off."}</h1>
          <span className="fy-h1row__meta">
            {chapters.length === 0
              ? "the spine comes first"
              : `${drafted.length} chapter${drafted.length === 1 ? "" : "s"} drafted${
                  inHand ? ` · chapter ${String(inHand.order).padStart(2, "0")} in hand` : ""
                } · ${totalWords.toLocaleString()} words`}
          </span>
        </div>
        <div className="fy-threadcard" style={{ flex: "none" }}>
          <div className="fy-threadcard__head">
            <span className="fy-threadcard__label">
              {chapters.length === 0
                ? "THE SPINE COMES FIRST"
                : inHand
                  ? `IN HAND · CHAPTER ${inHand.order} OF ${chapters.length}`
                  : `ALL ${chapters.length} CHAPTERS DRAFTED`}
            </span>
          </div>
          <div className="fy-threadcard__title">
            {chapters.length === 0 ? "Find the spine together" : (inHand?.title ?? "Nothing waits on you")}
          </div>
          <div className="fy-threadcard__sub">
            {chapters.length === 0
              ? "Talk the story into an overview; chapters hang beneath it."
              : inHand
                ? `${inHand.status}${production.story ? ` · against the overview at v${production.story.version}` : ""}`
                : "Every chapter has words. The overview steers whatever comes next."}
          </div>
          <div className="fy-threadcard__actions">
            <Button variant="primary" onClick={() => navigate(`/w/${worldId}/p/${prodId}/story`)}>
              {chapters.length === 0 ? "Open Production Chat" : "Continue in Production Chat"}
            </Button>
          </div>
        </div>
        {chapters.length > 0 && (
          <div>
            <div className="fy-listhead">
              Chapters
              <button
                type="button"
                className="fy-linkbtn"
                onClick={() => navigate(`/w/${worldId}/p/${prodId}/story/chapters`)}
              >
                All {chapters.length} chapter{chapters.length === 1 ? "" : "s"}
              </button>
            </div>
            {nearby.map((c) => (
              <div key={c.id} className="fy-listrow">
                <span className="fy-mono">{String(c.order).padStart(2, "0")}</span>
                <span className="fy-listrow__text" style={{ font: "600 13px var(--font-sans)" }}>
                  {c.title}
                </span>
                <Badge tone="outline">v{c.version}</Badge>
                <span className="fy-mono">{c.words ? `${c.words.toLocaleString()} words` : c.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  const dayOne = isDayOne(production);
  const decisions = takeDecisions(production);
  const pending = production.takes.filter((t) => decisions[t.id] === "pending");
  const shots = production.scenes.flatMap((s) => orderedShots(s));
  const acceptedShots = shots.filter((s) => acceptedTakeId(production, s.id)).length;
  const nextGap = production.scenes
    .flatMap((scene) => orderedShots(scene).map((shot) => ({ scene, shot })))
    .find(({ shot }) => !acceptedTakeId(production, shot.id));
  const latest = [...production.takes]
    .sort((a, b) => (b.completedAt ?? b.dispatchedAt).localeCompare(a.completedAt ?? a.dispatchedAt))
    .slice(0, 4);
  const recentDecided = production.takes
    .filter((t) => decisions[t.id] !== "pending")
    .slice(-3)
    .reverse();

  return (
    <div className="fy-prodmain" data-screen="production-dashboard">
      {/* Day one is the production's own name and nothing else (turn 53b): the world it came from
          is on the rail, and saying so again here is the announcement that screen deliberately
          dropped. */}
      <div className="fy-h1row">
        <h1 className="fy-h1">{dayOne ? production.meta.title : "Here's where you left off."}</h1>
        {!dayOne && (
          <span className="fy-h1row__meta">
            {acceptedShots} of {shots.length} shots covered · {pending.length} need you
          </span>
        )}
      </div>
      {dayOne ? (
        <>
          <DayOne
            worldId={worldId!}
            prodId={prodId!}
            onOpen={(path, opening) =>
              navigate(`/w/${worldId}/p/${prodId}${path}`, opening ? { state: { opening } } : {})
            }
            newScene={newScene}
          />
          {/* Below the frame's content, not above it: 53b opens on the production's own name and
              a box to type in. Delivery postdates that drawing and is the app's own (issue 389),
              so it sits where it cannot interrupt the opening. */}
          <DeliveryAspect production={production} worldId={worldId} prodId={prodId} />
        </>
      ) : (
        <>
          <DeliveryAspect production={production} worldId={worldId} prodId={prodId} />
          <div className="fy-dashrow">
            <div className="fy-threadcard">
              <div className="fy-threadcard__head">
                <span className="fy-threadcard__label">
                  AWAITING REVIEW · {pending.length} TAKE{pending.length === 1 ? "" : "S"}
                </span>
              </div>
              <div className="fy-threadcard__title">
                {pending.length > 0 ? "Takes are back and waiting on your eye" : "Nothing waits on you"}
              </div>
              <div className="fy-threadcard__sub">
                {pending.length > 0
                  ? "Accept locks the clip into the cut; a rejection cites the sheet it drifted from."
                  : "Every take that came back has a decision. The next move is dispatch."}
              </div>
              <div className="fy-threadcard__actions">
                <Button onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}>
                  {pending.length > 0 ? "Review takes" : "Open Generate"}
                </Button>
              </div>
            </div>
            {nextGap && (
              <div className="fy-nextcard">
                <div className="fy-nextcard__frame">
                  <Portrait
                    worldSlug={world.meta.slug}
                    path={
                      nextGap.scene.board
                        ? `productions/${production.meta.id}/${nextGap.scene.board.image}`
                        : (world.keyArt ?? "")
                    }
                    label={`${nextGap.shot.id.replace("sh_", "Shot ")}: frame`}
                    radius={0}
                  />
                </div>
                <div className="fy-nextcard__body">
                  <div className="fy-nextcard__title">
                    {nextGap.shot.id.replace("sh_", "Shot ")} has no clip yet
                    <span className="fy-dot fy-dot--warn" />
                  </div>
                  <div className="fy-nextcard__sub">
                    Scene {nextGap.scene.number} · {nextGap.shot.title} · {seconds(nextGap.shot.durationSec)}
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <Button onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}>
                      Open in Generate
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
          <div>
            <div className="fy-listhead">
              Latest clips
              {/* The same keyboard rule as the chapter link: a destination is a button, not a span. */}
              <button
                type="button"
                className="fy-linkbtn"
                onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}
              >
                All {production.takes.length} takes
              </button>
            </div>
            <div className="fy-cliprow">
              {latest.map((t) => (
                <div
                  key={t.id}
                  className="fy-clip"
                  onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}
                >
                  <div className="fy-clip__frame">
                    <Portrait
                      worldSlug={world.meta.slug}
                      path={takeMediaPath(production, t) ?? ""}
                      label={t.coversShots[0]?.replace("sh_", "shot ") ?? t.id}
                    />
                  </div>
                  <div className="fy-clip__meta">
                    <span className={`fy-dot fy-dot--${decisionTone(decisions[t.id])}`} />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t.coversShots.map((s) => s.replace("sh_", "shot ")).join(", ")}
                    </span>
                    <span className="fy-mono">
                      {seconds(
                        t.coversShots.reduce(
                          (sum, id) => sum + (shots.find((s) => s.id === id)?.durationSec ?? 0),
                          0,
                        ),
                      )}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          {/* The pending queue is stated once, in the card above, which links to where it is
              decided (design 55). Re-listing the same takes here was a second copy to keep true. */}
          <div className="fy-dashrow">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fy-listhead">Activity</div>
              {recentDecided.length === 0 && <div className="fy-mono">no decisions yet</div>}
              {recentDecided.map((t) => (
                <div key={t.id} className="fy-listrow">
                  <span className={`fy-dot fy-dot--${decisions[t.id] === "accepted" ? "ok" : "sketch"}`} />
                  <span className="fy-listrow__text">
                    {t.coversShots.map((s) => s.replace("sh_", "shot ")).join(", ")} · {decisions[t.id]}
                  </span>
                  <span className="fy-mono">{usd(t.cost.actualMicroUsd ?? t.cost.estimatedMicroUsd)}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The one editable delivery-profile field (issue 389): validated and normalized server-side,
 * refused per route at dispatch, and every planning surface reads it.
 */
function DeliveryAspect({
  production,
  worldId,
  prodId,
}: {
  production: { meta: { aspect?: string } };
  worldId: string | undefined;
  prodId: string | undefined;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span className="fy-mono">Delivery</span>
      <select
        aria-label="Delivery aspect"
        value={productionAspect(production.meta)}
        onChange={(e) => worldId && prodId && setProductionAspect(worldId, prodId, e.target.value)}
        style={{
          font: "500 12px var(--font-sans)",
          padding: "4px 8px",
          borderRadius: 8,
          border: "1px solid var(--border)",
          background: "var(--background)",
          color: "inherit",
        }}
      >
        {STANDARD_ASPECTS.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
      {production.meta.aspect === undefined && <span className="fy-mono">default</span>}
    </div>
  );
}

/**
 * Day one (design turn 53b).
 *
 * A production that has nothing in it yet has one job: start writing. What stood here before was
 * frame 43b — the world's inventory read back, and a rail of canon seeds — which turn 53 cut and
 * turn 83 superseded in whole. The inventory announced what the rail already says, and the seeds
 * guessed at a way of working nobody had done; turn 83 leaves them a way back, but only once the
 * plain path has been used and found wanting.
 *
 * So: a heading, a box to type in, and two ways in. Typing changes nothing — the line beneath the
 * composer is the promise, and sending it opens the Production Chat thread rather than writing a word.
 */
function DayOne({
  worldId,
  prodId,
  onOpen,
  newScene,
}: {
  worldId: string;
  prodId: string;
  onOpen: (path: string, opening?: string) => void;
  newScene: ReturnType<typeof useNewScene>;
}) {
  const [message, setMessage] = useState("");
  // Nothing is being said to yet, so what is dropped here is filed as the production's own
  // artifact rather than attached to a conversation that does not exist.
  const attachTarget = { kind: "file-artifact", worldId, production: prodId } as const;
  const send = () => {
    const text = message.trim();
    if (!text) return;
    /*
     * The first thing said about a production is the opening line of its Production Chat thread,
     * not a note that lands nowhere. This screen used to create the conversation itself, which
     * named it and nothing more: creating does not take a turn, so the studio never answered the
     * first thing anybody said to it (turn 95). The line is handed to the chat, which opens the
     * thread and says it, through the one path that does both.
     */
    setMessage("");
    onOpen("/story", text);
  };
  return (
    <>
      <div style={{ font: "400 14px/1.6 var(--font-sans)", color: "var(--muted-foreground)", maxWidth: 560 }}>
        Nothing written yet. Say what happens, and the first scene takes shape here.
      </div>
      <div style={{ maxWidth: 640 }}>
        <Composer
          value={message}
          onChange={setMessage}
          onSubmit={send}
          placeholder="Someone finds the thing they were not meant to find…"
          agentLabel="story author"
          onAttach={() => uploadArtifacts(worldId)}
          onDictate={(text) => setMessage((prev) => (prev ? `${prev} ${text}` : text))}
          {...(hostCanAttach()
            ? {
                onAttachFiles: (files: readonly File[]) => attachHostFiles(attachTarget, files),
                onAttachText: (text: string) => attachHostText(attachTarget, text, "pasted-note.txt"),
              }
            : {})}
          autoFocus
        />
        <div className="fy-mono" style={{ marginTop: 8 }}>
          talking writes nothing · you accept what you keep
        </div>
      </div>
      <div style={{ display: "flex", gap: 12, maxWidth: 640 }}>
        <button type="button" className="fy-radio" style={{ flex: 1 }} disabled={newScene.pending} onClick={() => newScene.create()}>
          <div style={{ font: "600 13px var(--font-sans)" }}>Write the first scene</div>
          <div
            style={{
              font: "400 11.5px/1.5 var(--font-sans)",
              color: "var(--muted-foreground)",
              marginTop: 4,
            }}
          >
            Straight to a scene you can shoot.
          </div>
        </button>
        <button type="button" className="fy-radio" style={{ flex: 1 }} onClick={() => onOpen("/story")}>
          <div style={{ font: "600 13px var(--font-sans)" }}>Shape the whole thing first</div>
          <div
            style={{
              font: "400 11.5px/1.5 var(--font-sans)",
              color: "var(--muted-foreground)",
              marginTop: 4,
            }}
          >
            Decide what it is before writing any of it.
          </div>
        </button>
      </div>
    </>
  );
}

/**
 * Production Chat: World Chat with a production for a subject (design turns 88, 89).
 *
 * Turn 48 hung a conversation on each of four views, so one thread — R-20 says a production has
 * exactly one — wore four costumes, and every screen was half a place to make something and half
 * a place to read it. This screen is only the first half. What it sets up is read next door, on
 * Season or Overview, which is the other thing a person does and now has its own name on the rail.
 */
export function ProductionChatScreen() {
  const { worldId, prodId } = useParams();
  /** A line typed on day one, carried here by the navigation that opened this screen. */
  const opening = (useLocation().state as { opening?: string } | null)?.opening;
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const shape = production ? productionShape(production.meta) : null;
  const cast = pickableSheets(world?.sheets ?? [], prodId).filter((s) => s.type === "character").length;
  const details = shape?.isEpisodic ? "Season" : "Overview";
  const detailsPath = `/w/${worldId}/p/${prodId}/${shape?.isEpisodic ? "season" : "overview"}`;
  /*
   * What this conversation has already staged (turn 92). The season's own file for an episodic
   * production, the overview's for one without a season — a production has one of the two, never
   * both, so a single match is the whole answer.
   */
  const file = shape?.isEpisodic ? "season.json" : "story.json";
  const staged =
    (world?.proposals ?? []).find((sp) =>
      sp.proposal.targets.some((t) => t.path === `productions/${prodId}/${file}`),
    ) ?? null;
  return (
    <div className="fy-story" data-screen="production-chat">
      <ProductionConversation
        worldId={worldId}
        productionId={prodId}
        openingNote="Develop · opening…"
        eyebrow={`DEVELOP · ${shape ? shape.displayLabel.toLowerCase() : ""}`}
        heading={shape?.isEpisodic ? "What is this season?" : "Find the spine together."}
        placeholder="Say what this is — what happens, who it costs, how it ends…"
        emptyLine={
          shape?.isEpisodic
            ? "Nothing decided yet. Say what this season answers, how it ends, and what its episodes are — everything you settle here lands in Season."
            : "Nothing decided yet. Say what this is — the spine, the acts, what it costs — and what you settle here lands in Overview."
        }
        footer={
          <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span className="fy-mono">in context:</span>
            <span className="fy-pill">
              all {production?.scenes.length ?? 0} scene{(production?.scenes.length ?? 0) === 1 ? "" : "s"}
            </span>
            <span className="fy-pill">{cast} cast sheets</span>
            {world?.meta.tone && <span className="fy-pill">Tone · {world.meta.tone}</span>}
            <span style={{ flex: 1 }} />
            {/* Where what is being said ends up, named and reachable from where it is said. */}
            <NavLink
              to={`/w/${worldId}/p/${prodId}/${shape?.isEpisodic ? "season" : "overview"}`}
              className="fy-linkbtn"
            >
              {details} &rarr;
            </NavLink>
          </div>
        }
        pointsEmpty="Nothing understood yet. As you talk, what the studio takes from it appears here — the season question, each episode, each arc — so you can see it thinking rather than wait for the end."
        {...(opening ? { openWith: opening } : {})}
        {...(staged
          ? {
              side: (
                <StagedDecision
                  worldId={worldId}
                  subject={shape?.isEpisodic ? "the season" : "the overview"}
                  staged={staged}
                  writes={`the gate writes ${file} · nothing else moves`}
                  onAccepted={() => navigate(detailsPath)}
                />
              ),
            }
          : {})}
      />
    </div>
  );
}

// ---- Story (10b) -----------------------------------------------------------

export function StoryScreen() {
  const { worldId, prodId } = useParams();
  const { production } = useProduction(worldId, prodId);
  // An episodic production's details are the four-view workspace (turn 48; issue 397); a
  // non-episodic one keeps the single overview — no fake episode or season controls. The
  // branch is a component boundary, not an early return: returning before the overview's own
  // hooks broke the Rules of Hooks the moment a production's shape settled after first render.
  if (production && productionShape(production.meta).isEpisodic) return <DevelopmentWorkspace />;
  return <OverviewStoryScreen />;
}

function OverviewStoryScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const story = production?.story ?? null;
  /*
   * What is already waiting on a decision for this production's overview (turn 86).
   *
   * The rail marks each field the staged proposal would change, using the proposal's own
   * field-by-field review — computed from the captured base against the proposed file — so the
   * screen cannot claim a change the gate would not make.
   */
  const staged = (world?.proposals ?? []).find((sp) =>
    sp.proposal.targets.some((t) => t.path === `productions/${prodId}/story.json`),
  );
  /** Every field the staged proposal would change, flattened out of its per-target review. */
  const stagedFields = staged?.review?.targets.flatMap((t) => t.fields) ?? [];
  const spineLines = (story?.spine ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return (
    <div className="fy-story" data-screen="story-overview">
      {/* The details, not a conversation (turn 88): what the thread settled, read and worked
          with. Changing any of it is done next door, where it was decided. */}
      <div className="fy-story__chat">
        <div className="fy-story__chathead">
          <div className="fy-eyebrow-sm">
            OVERVIEW · {production ? productionShape(production.meta).displayLabel.toLowerCase() : ""}
          </div>
          <h1 className="fy-story__h1">{story ? "The story, as it stands" : "Nothing settled yet"}</h1>
        </div>
        <div className="fy-story__log">
          {story ? (
            <div style={{ display: "grid", gap: 14 }}>
              <div className="fy-draftcard">
                <div className="fy-eyebrow-sm">LOGLINE</div>
                <div className="fy-draftcard__logline">“{story.logline}”</div>
              </div>
              {spineLines.length > 0 && (
                <div className="fy-draftcard">
                  <div className="fy-eyebrow-sm">SPINE</div>
                  {spineLines.map((line) => (
                    <div key={line} style={{ font: "400 13px/1.7 var(--font-sans)", marginTop: 4 }}>
                      {line}
                    </div>
                  ))}
                </div>
              )}
              {(story.acts ?? []).length > 0 && (
                <div className="fy-draftcard">
                  <div className="fy-eyebrow-sm">ACTS</div>
                  {(story.acts ?? []).map((act, i) => (
                    <div key={act.title} style={{ font: "400 13px/1.7 var(--font-sans)", marginTop: 4 }}>
                      {i + 1}. {act.title}
                      {act.summary ? ` — ${act.summary}` : ""}
                    </div>
                  ))}
                </div>
              )}
              {production?.treatment && (
                <div className="fy-draftcard">
                  <div className="fy-eyebrow-sm">TREATMENT</div>
                  <div
                    style={{ font: "400 13px/1.7 var(--font-sans)", marginTop: 4, whiteSpace: "pre-wrap" }}
                  >
                    {production.treatment}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <EmptyState
              title="Nothing settled yet"
              hint="Production Chat is where this gets decided — say what the thing is, and what you settle lands here."
            />
          )}
        </div>
        <div
          style={{ flex: "none", padding: "14px 36px 22px", display: "flex", gap: 10, alignItems: "center" }}
        >
          <NavLink to={`/w/${worldId}/p/${prodId}/story`} className="fy-linkbtn">
            &larr; Production Chat
          </NavLink>
          <span className="fy-mono">
            the overview steers scene and chapter drafting · it never overwrites a scene you have locked
          </span>
        </div>
      </div>
      {/* The rail beside a details screen holds what is staged against it (turn 86/88) — the
          object itself is the screen, so repeating it here would be two copies of one thing. */}
      <div className="fy-story__side">
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <div style={{ font: "600 15px var(--font-sans)" }}>Waiting on you</div>
          <span className="fy-mono" style={{ color: staged ? "var(--warning)" : undefined }}>
            {staged
              ? `${stagedFields.length} change${stagedFields.length === 1 ? "" : "s"}`
              : "nothing staged"}
          </span>
        </div>
        {staged ? (
          <div style={{ display: "grid", gap: 12 }}>
            {stagedFields.map((field) => (
              <div key={field.field} className="fy-draftcard">
                <div className="fy-draftcard__head">
                  <span className="fy-eyebrow-sm">{field.field}</span>
                  <Badge tone="warning">would change</Badge>
                </div>
                <div style={{ font: "400 13px/1.7 var(--font-sans)", marginTop: 6 }}>
                  {field.proposed ?? "(removed)"}
                </div>
                {field.before !== null && <div className="fy-draftcard__was">Accepted: “{field.before}”</div>}
              </div>
            ))}
            <div className="fy-mono">the conversation staged it · the gate writes it, in Proposals</div>
          </div>
        ) : (
          <div className="fy-emptycard">
            <div style={{ font: "400 13px/1.7 var(--font-sans)" }}>
              Nothing waiting. What Production Chat settles arrives here to be accepted before it lands.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function ChapterTreeScreen() {
  const { prodId, worldId } = useParams();
  const { production } = useProduction(worldId, prodId);
  return (
    <div className="fy-prodmain" data-screen="chapter-tree">
      <div className="fy-h1row">
        <h1 className="fy-h1">Chapter tree</h1>
        <span className="fy-h1row__meta">{production?.chapters.length ?? 0} chapters</span>
      </div>
      {production && production.chapters.length > 0 ? (
        <div>
          {production.chapters.map((c) => (
            <div key={c.id} className="fy-listrow">
              <span className="fy-mono">{String(c.order).padStart(2, "0")}</span>
              <span className="fy-listrow__text" style={{ font: "600 13px var(--font-sans)" }}>
                {c.title}
              </span>
              <Badge tone="outline">v{c.version}</Badge>
              <span className="fy-mono">{c.words ? `${c.words} words` : c.status}</span>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          title={
            production && productionShape(production.meta).hasChapters
              ? "No chapters yet"
              : "Chapters belong to Story productions"
          }
          hint={
            production && productionShape(production.meta).hasChapters
              ? "Chapters hang beneath the overview and are drafted through the gate."
              : "This production's structure lives in Scenes."
          }
        />
      )}
    </div>
  );
}

// ---- Scenes ----------------------------------------------------------------

export function ScenesScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const newScene = useSharedNewScene(worldId, prodId);
  const totalSec =
    production?.scenes.reduce((s, sc) => s + orderedShots(sc).reduce((x, sh) => x + (sh.durationSec ?? 0), 0), 0) ??
    0;
  return (
    <div className="fy-prodmain" data-screen="scenes">
      <div className="fy-h1row">
        <h1 className="fy-h1">Scenes</h1>
        <span className="fy-h1row__meta">
          {production?.scenes.length ?? 0} scenes · {seconds(totalSec)}
        </span>
        <span className="fy-h1row__push" />
        <Button
          variant="primary"
          disabled={newScene.pending}
          onClick={() => newScene.create(defaultEpisodeFor(production))}
        >
          New scene
        </Button>
      </div>
      {production && production.scenes.length > 0 ? (
        <div className="fy-ledger">
          {production.scenes.map((scene) => {
            const sceneShots = orderedShots(scene);
            const covered = sceneShots.filter((s) => acceptedTakeId(production, s.id)).length;
            return (
              <button
                key={scene.id}
                type="button"
                className="fy-row"
                onClick={() => navigate(`/w/${worldId}/p/${prodId}/scenes/${scene.id}`)}
              >
                <div className="fy-row__thumb">
                  <Portrait
                    worldSlug={world?.meta.slug}
                    path={scene.board ? `productions/${production.meta.id}/${scene.board.image}` : ""}
                    label={String(scene.number)}
                    radius={6}
                  />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="fy-row__name">
                    {scene.number} · {scene.title}
                    <span
                      className={`fy-dot fy-dot--${covered === sceneShots.length && sceneShots.length > 0 ? "ok" : "warn"}`}
                    />
                  </div>
                  <div className="fy-row__sub">
                    {sceneShots.length} shots ·{" "}
                    {seconds(sceneShots.reduce((s, x) => s + (x.durationSec ?? 0), 0))}
                    {scene.inherits?.location ? ` · @${scene.inherits.location}` : ""}
                    {scene.inherits?.timeOfDay ? ` · ${scene.inherits.timeOfDay}` : ""}
                  </div>
                </div>
                <span className="fy-row__meta">
                  v{scene.version}
                  {scene.board ? ` · board v${scene.board.version}` : " · no board"}
                </span>
                <span className="fy-row__chev">
                  <ChevronRight size={15} />
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <EmptyState
          title="No scenes yet"
          hint="Draft a scene and its shots inherit location, time and tone."
        />
      )}
    </div>
  );
}

// ---- Scene detail (14a) ----------------------------------------------------

export function SceneDetailScreen() {
  const { worldId, prodId, sceneId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const record = production?.scenes.find((s) => s.id === sceneId);
  if (world && production && record) {
    return <SceneWorkspace key={`${world.meta.worldId}/${production.meta.id}/${record.id}`} world={world} production={production} scene={record} />;
  }
  return (
    <Screen id="scene-detail">
      <EmptyState title="Opening scene…" />
    </Screen>
  );
}

// ---- Generate workspace (11b) ----------------------------------------------

/**
 * The takes, watched (design turn 102, frame 102c).
 *
 * A thing you watch is shown, not described. One shot's takes sit side by side, the chosen one is
 * marked, every shot is a chip away, and accepting is one button at the foot. What used to be
 * here — the composer, the parameter rail, the model picker, the select of shots — is the bench,
 * behind Advanced: layer three, never deleted and never in front.
 *
 * Two ergonomics this fixes by construction. The shot picker was a select, which hides where you
 * are in a scene; and Accept take was disabled unless the take you were looking at happened to be
 * the pending one, which reads as broken. A marked tile and a row of chips have neither problem.
 */
function TakesView({
  worldId,
  prodId,
  askedFor,
  generating,
  onGenerate,
  onAdvanced,
  onContact,
}: {
  worldId: string | undefined;
  prodId: string | undefined;
  /** The shot the press was about, carried in the address (`?shot=`). */
  askedFor: string | null;
  generating: boolean;
  onGenerate: (shotId: string) => void;
  /* Both doors carry the shot with them (review 2026-08-22): pressing Advanced used to replace
     the whole query string, losing the shot one click after the address recovered it. */
  onAdvanced: (shotId: string | null) => void;
  onContact: (shotId: string | null) => void;
}) {
  const { world, production } = useProduction(worldId, prodId);
  const all = production?.scenes.flatMap((s) => orderedShots(s)) ?? [];
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  /*
   * The shot the storyboard sent, if it sent one (found by driving: `Generate frame` on shot 14
   * opened the workspace on shot 4, because the press asked for the workspace rather than for a
   * shot). A chip pressed here still wins — the address is where you arrived, not a lock.
   */
  const asked = askedFor !== null && all.some((s) => s.id === askedFor) ? askedFor : null;
  const shotId = selectedShotId ?? asked ?? all[0]?.id ?? null;
  const shot = all.find((s) => s.id === shotId) ?? null;
  const found = production?.scenes.find((s) => orderedShots(s).some((x) => x.id === shotId)) ?? null;
  const scene = found === null ? null : legacySceneView(found);
  /*
   * The chips are this scene's shots, not the production's (found by driving: a production with
   * two scenes drew three chips, two of them reading "Shot 1", because a shot's number is
   * scene-local and flattening the production makes it ambiguous). "Every shot" means every shot
   * of the thing you are looking at, which is what the frame draws.
   */
  const shots = found === null ? [] : orderedShots(found);
  /* Every scene, one chip away (review 2026-08-22): the first cut could only reach the first
     scene's shots from the rail, and a three-scene production had no way to its second. */
  const scenes = production?.scenes ?? [];
  /** Only takes with resolvable pixels, plus anything still in flight. */
  const takes = production && shotId
    ? takesForShot(production, shotId).filter(
        (take) => mediaTakeFor(production, take) !== null || take.completedAt === undefined,
      )
    : [];
  const acceptedId = production && shotId ? acceptedTakeId(production, shotId) : null;
  /*
   * The mark tells no lies (review 2026-08-22). The first cut of this view guessed: when the
   * acceptance sat on a filtered charge-split record it re-pointed ✓ at the newest take with
   * media — which marked takes that were never accepted, disabled Accept on them, and disagreed
   * with the cut, the chips and the exporter all at once. Now ✓ appears only on the take that
   * is literally accepted; when that record has no preview, the foot says so instead, and one
   * press of Accept on a visible take moves the selection somewhere honest.
   */
  const accepted = takes.find((t) => t.id === acceptedId)?.id ?? null;
  const acceptedHidden = acceptedId !== null && accepted === null;
  /* What is worth looking at: the one already accepted, or the newest that came back. */
  const [pickedId, setPickedId] = useState<string | null>(null);
  const picked =
    takes.find((t) => t.id === pickedId) ??
    takes.find((t) => t.id === accepted) ??
    takes[takes.length - 1] ??
    null;
  const acceptedCount = shots.filter(
    (s) => production && acceptedTakeId(production, s.id) !== null,
  ).length;
  /* One pass over the takes for the chip dots, not one filter per chip (review 2026-08-22). */
  const coveredShotIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of production?.takes ?? []) for (const sid of t.coversShots) ids.add(sid);
    return ids;
  }, [production?.takes]);
  if (!production || !scene || !shot) {
    return (
      <div className="fy-prodmain" data-screen="generate-workspace">
        <EmptyState title="Nothing to review yet" hint="Generate a scene and its takes arrive here." />
      </div>
    );
  }
  return (
    <div className="fy-arkewrap">
      <div className="fy-prodmain fy-takes" data-screen="generate-workspace">
        <div className="fy-h1row">
          <h1 className="fy-h1">Shot {shot.number}</h1>
          <span className="fy-h1row__meta">
            {shot.title} · {seconds(shot.durationSec)}
          </span>
          <span className="fy-h1row__push" />
          <span className="fy-mono">
            {acceptedCount} of {shots.length} accepted
          </span>
        </div>
        {takes.length === 0 ? (
          <EmptyState
            title="No takes yet"
            hint="Generate this shot and its takes arrive here, side by side."
          />
        ) : (
          <div className="fy-takegrid">
            {takes.map((t, i) => {
              const path = takeMediaPath(production, t);
              return (
                <button
                  key={t.id}
                  type="button"
                  className={cx("fy-take", picked?.id === t.id && "fy-take--on")}
                  onClick={() => setPickedId(t.id)}
                >
                  <span className="fy-take__frame">
                    {path ? (
                      <Portrait worldSlug={world?.meta.slug} path={path} label={`Take ${i + 1}`} radius={0} />
                    ) : (
                      <span className="fy-mono">running…</span>
                    )}
                    {path && (
                      <span className="fy-playbtn" aria-hidden style={{ pointerEvents: "none" }}>
                        <Play size={22} />
                      </span>
                    )}
                  </span>
                  <span className="fy-take__foot">
                    <span className="fy-take__name">Take {i + 1}</span>
                    <span style={{ flex: 1 }} />
                    <span className="fy-mono">
                      {t.id === accepted ? "✓ SELECTED" : seconds(shot.durationSec)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {scenes.length > 1 && (
          <>
            <div className="fy-mono" style={{ letterSpacing: ".08em", marginTop: 8 }}>
              SCENES
            </div>
            <div className="fy-takechips">
              {scenes.map((sc) => (
                <button
                  key={sc.id}
                  type="button"
                  disabled={generating}
                  className={cx("fy-takechip", sc.id === scene.id && "fy-takechip--on")}
                  onClick={() => {
                    setSelectedShotId(orderedShots(sc)[0]?.id ?? null);
                    setPickedId(null);
                  }}
                >
                  Scene {sc.number}
                </button>
              ))}
            </div>
          </>
        )}
        {/* Every shot, one chip away — where you are in the scene, said out loud (turn 102). */}
        <div className="fy-mono" style={{ letterSpacing: ".08em", marginTop: 8 }}>
          EVERY SHOT
        </div>
        <div className="fy-takechips">
          {shots.map((s) => {
            const done = acceptedTakeId(production, s.id) !== null;
            const has = coveredShotIds.has(s.id);
            return (
              <button
                key={s.id}
                type="button"
                disabled={generating}
                className={cx("fy-takechip", s.id === shotId && "fy-takechip--on")}
                onClick={() => {
                  setSelectedShotId(s.id);
                  setPickedId(null);
                }}
              >
                <span
                  className="fy-dot"
                  style={{
                    background: done ? "var(--foreground)" : has ? "var(--warning)" : "var(--neutral-300)",
                  }}
                />
                Shot {s.number}
              </button>
            );
          })}
        </div>
        <div className="fy-takes__foot">
          {/* The two verdicts and the one thing that spends (review 2026-08-22): the first cut
              of this view had no way to generate and no way to reject, so "Generate frame" from
              the storyboard landed on a screen that told you to generate and offered nothing to
              press, and a drifted take could only be ignored — never taught from. */}
          <Button
            variant="primary"
            disabled={generating || shotId === null}
            onClick={() => shotId !== null && onGenerate(shotId)}
          >
            {generating ? "Opening…" : "Open in generator"}
          </Button>
          <Button
            disabled={!picked || picked.id === accepted}
            onClick={() => {
              if (worldId && prodId && shotId && picked) acceptTake(worldId, prodId, picked.id, shotId);
            }}
          >
            {picked ? `Accept take ${takes.indexOf(picked) + 1}` : "Accept take"}
          </Button>
          <Button
            variant="ghost"
            disabled={!picked || Object.keys(picked.provenance.sheets).length === 0}
            title="A rejection cites the sheet the take drifted from"
            onClick={() => {
              const sheet = picked ? Object.keys(picked.provenance.sheets)[0] : undefined;
              if (worldId && prodId && picked && sheet)
                rejectTake(
                  worldId,
                  prodId,
                  picked.id,
                  { sheet, field: "appearance", note: "rejected in review" },
                  shotId ?? undefined,
                );
            }}
          >
            Reject
          </Button>
          <span className="fy-mono">
            {acceptedHidden
              ? "accepted take holds no preview — accepting a visible one replaces it"
              : "accepting locks it into the cut · rejections teach the shot"}
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" className="fy-linkbtn" onClick={() => onContact(shotId)}>
            Contact sheet
          </button>
          <button type="button" className="fy-linkbtn" disabled={generating} onClick={() => onAdvanced(shotId)}>
            Advanced
          </button>
        </div>
      </div>
      {/* Layer two, in the same column it holds everywhere else (turns 99, 100, 102). */}
      <ProductionConversation
        worldId={worldId}
        productionId={prodId}
        entry={{ kind: "scene", productionId: prodId ?? "", sceneId: scene.id }}
        dock={{
          title: `Arke · Shot ${shot.number}`,
          subject: `${shot.title} · ${takes.length} take${takes.length === 1 ? "" : "s"}`,
        }}
        openingNote="opening…"
        emptyLine={`${takes.length} take${takes.length === 1 ? "" : "s"} back on shot ${shot.number}. Say what to change and it runs again.`}
        placeholder="Say what to change · @ to reference"
        pointsEmpty="Nothing understood yet. As you talk, what the studio takes from it appears here."
      />
    </div>
  );
}

export function GenerateScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const { connection, state } = useStore();
  const navigate = useNavigate();
  const ownerKey = `${worldId ?? ""}/${prodId ?? ""}`;
  const currentOwnerKey = useRef(ownerKey);
  currentOwnerKey.current = ownerKey;
  const pendingGenerator = useRef<{ requestId: string; ownerKey: string } | null>(null);
  const [generatorPending, setGeneratorPending] = useState(false);
  const [generatorError, setGeneratorError] = useState<string | null>(null);
  // The workspace's second lens (design 55a): the same frame/still takes, seen as a set.
  // Deep-linkable — the retired /stills address redirects here with the lens on.
  const [searchParams, setSearchParams] = useSearchParams();
  const contactLens = searchParams.get("view") === "stills";
  const shots = production?.scenes.flatMap((s) => orderedShots(s)) ?? [];
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const [selectedTakeId, setSelectedTakeId] = useState<string | null>(null);
  /* The bench honours the address the same way the takes view does (review 2026-08-22). */
  const benchAsked = searchParams.get("shot");
  const shotId =
    selectedShotId ??
    (benchAsked !== null && shots.some((s) => s.id === benchAsked) ? benchAsked : null) ??
    shots[0]?.id ??
    null;
  const shot = shots.find((s) => s.id === shotId) ?? null;
  const found = production?.scenes.find((s) => orderedShots(s).some((x) => x.id === shotId)) ?? null;
  const scene = found === null ? null : legacySceneView(found);
  const takes = production && shotId ? takesForShot(production, shotId) : [];
  const decisions = production ? takeDecisions(production) : {};
  const accepted = production && shotId ? acceptedTakeId(production, shotId) : null;
  const take =
    takes.find((t) => t.id === selectedTakeId) ??
    (accepted ? takes.find((t) => t.id === accepted) : undefined) ??
    takes[takes.length - 1] ??
    null;
  const slug = world?.meta.slug;
  const model =
    (state?.app.manifest?.models ?? []).find(
      (m) => m.id === (productionModel(state, prodId, "video") ?? state?.app.routing.defaults["video"]),
    ) ??
    (state?.app.manifest?.models ?? []).find((m) => m.capability === "video") ??
    null;

  useEffect(
    () =>
      subscribeBenchSubjectOpened((event) => {
        const pending = pendingGenerator.current;
        if (
          pending === null ||
          pending.ownerKey !== currentOwnerKey.current ||
          event.requestId !== pending.requestId ||
          event.worldId !== worldId
        ) {
          return;
        }
        pendingGenerator.current = null;
        setGeneratorPending(false);
        if (event.sessionId === null) {
          setGeneratorError(event.reason ?? "The generator session could not be prepared.");
          return;
        }
        setGeneratorError(null);
        void navigate(`/w/${worldId}/artifacts/bench/${event.sessionId}`);
      }),
    [navigate, worldId],
  );
  useEffect(() => {
    if (connection === "open" || pendingGenerator.current === null) return;
    pendingGenerator.current = null;
    setGeneratorPending(false);
    setGeneratorError("Connection lost - try again.");
  }, [connection]);
  useEffect(() => {
    const pending = pendingGenerator.current;
    if (pending === null || pending.ownerKey === ownerKey) return;
    pendingGenerator.current = null;
    setGeneratorPending(false);
    setGeneratorError(null);
  }, [ownerKey]);
  const openGenerator = (targetShotId: string) => {
    if (!worldId || !prodId || pendingGenerator.current !== null) return;
    const targetScene = production?.scenes.find((candidate) => orderedShots(candidate).some((candidate) => candidate.id === targetShotId));
    if (targetScene === undefined) return;
    const requestId = sendBenchOpenSubject({
      worldId,
      productionId: prodId,
      sceneId: targetScene.id,
      subject: { kind: "shot", shotId: targetShotId },
    });
    if (requestId === null) {
      setGeneratorError("Not connected - try again.");
      return;
    }
    pendingGenerator.current = { requestId, ownerKey };
    setGeneratorPending(true);
    setGeneratorError(null);
  };

  /*
   * Which lens the workspace opens on (turn 102). Takes are the thing here: once something has
   * been generated you are assessing rather than writing, so the takes themselves are the front
   * and the three-column bench — composer, parameters, model picker — is layer three behind
   * Advanced. Deep-linkable, so somebody who wants the bench can live in it.
   */
  const benchLens = searchParams.get("view") === "bench";

  if (contactLens) {
    return (
      <ContactSheet
        production={production}
        worldSlug={world?.meta.slug}
        worldId={worldId}
        prodId={prodId}
        onShotLens={() => setSearchParams({}, { replace: true })}
      />
    );
  }
  if (!benchLens) {
    return (
      <TakesView
        worldId={worldId}
        prodId={prodId}
        askedFor={searchParams.get("shot")}
        generating={generatorPending}
        onGenerate={openGenerator}
        onAdvanced={(targetShotId) => targetShotId !== null && openGenerator(targetShotId)}
        onContact={(shotId) =>
          setSearchParams(shotId ? { view: "stills", shot: shotId } : { view: "stills" }, { replace: true })
        }
      />
    );
  }

  /*
   * Bench-only derivations live below the lens branch (review 2026-08-22): the previous frame,
   * the frame route, the boundary still and the cited sheets are the bench's furniture, and
   * computing them above the branch made every takes-view render pay for a bench nobody was
   * looking at. Plain consts, so they may sit under the returns; the hooks stay above.
   */
  const prevShot = (() => {
    if (!found || !shot) return null;
    const ordered = orderedShots(found);
    const i = ordered.findIndex((s) => s.id === shot.id);
    return i > 0 ? ordered[i - 1]! : null;
  })();
  const prevAccepted =
    prevShot && production
      ? production.takes.find((t) => t.id === acceptedTakeId(production, prevShot.id))
      : null;
  const prevFrame = prevAccepted && production ? takeMediaPath(production, prevAccepted) : null;
  // Strict frame behaviour is promised exactly where the route supports and receives it (issue
  // 154): the model's first-frame route, and the shot's durable boundary still. Anything less is
  // steering, and the copy says so instead of promising what the dispatch cannot send.
  const frameRoute = model ? frameDispatchFor(model, 1) : null;
  const boundaryFrame = (() => {
    if (!shot || !production || !world) return null;
    const id = production.selections[shot.id]?.startFrameArtifactId ?? null;
    return id !== null ? (world.artifacts.find((a) => a.id === id) ?? null) : null;
  })();

  const citedSheets = (() => {
    if (!shot || !world) return [];
    const mentions = [...shot.description.matchAll(/@([A-Za-z0-9-]+)/g)].map((m) => m[1]!.toLowerCase());
    return world.sheets
      .filter((s) => s.type === "character")
      .filter((s) => mentions.some((m) => s.id.includes(m) || s.name.toLowerCase().includes(m)))
      .slice(0, 2);
  })();

  return (
    <div className="fy-gen" data-screen="generate-workspace">
      <div className="fy-gen__left">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="fy-seg">
            <span className="fy-seg__item fy-seg__item--active">Shot</span>
            <button
              type="button"
              className="fy-seg__item"
              onClick={() => setSearchParams({ view: "stills" }, { replace: true })}
            >
              Contact sheet
            </button>
          </span>
          <select
            value={shotId ?? ""}
            disabled={generatorPending}
            onChange={(e) => {
              setSelectedShotId(e.target.value);
              setSelectedTakeId(null);
            }}
            style={{
              flex: 1,
              minWidth: 0,
              font: "500 12px var(--font-sans)",
              padding: "6px 8px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--background)",
              color: "inherit",
            }}
          >
            {shots.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id.replace("sh_", "shot ")} · {s.title}
              </option>
            ))}
          </select>
        </div>
        <div className="fy-gen__label">
          References <span className="fy-mono">sent with every take</span>
        </div>
        <div className="fy-refstrip">
          <div className="fy-refstrip__wide">
            <Portrait
              worldSlug={slug}
              path={scene?.board ? `productions/${production!.meta.id}/${scene.board.image}` : ""}
              label={shot ? `${shot.id.replace("sh_", "Shot ")} frame` : "frame"}
              radius={0}
            />
          </div>
          {citedSheets.map((s) => (
            <div key={s.id} className="fy-refstrip__tile">
              <Portrait worldSlug={slug} path={sheetPortraitPath(s.id)} label={s.name} radius={0} />
            </div>
          ))}
          <button
            type="button"
            className="fy-refstrip__add"
            title="References ride from the kits"
            onClick={() => navigate(`/w/${worldId}/cast`)}
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="fy-mono" style={{ marginTop: 6 }}>
          {shot
            ? `${shot.id.replace("sh_", "shot ")}${citedSheets.length > 0 ? ` · ${citedSheets.map((s) => `${s.name} model sheet v${s.version}`).join(" · ")}` : ""}`
            : ""}
        </div>
        <div className="fy-gen__label" style={{ marginTop: 16 }}>
          Frames{" "}
          <span className="fy-mono">
            {frameRoute !== null
              ? "start travels on the first-frame route"
              : "steering only · no frame route on this model"}
          </span>
        </div>
        {world && production && (
          <div className="fy-worldlook-line">
            <span>
              {shot?.promptOverride
                ? "Shot prompt override"
                : production.meta.styleOverride?.trim()
                ? "Production look"
                : `World look · v${world.artDirection.version}`}
            </span>
            <small>
              {shot?.promptOverride ? "edited by you" : production.meta.styleOverride?.trim() || "inherited"} · carries
              as text
            </small>
          </div>
        )}
        <div className="fy-framerow">
          {boundaryFrame ? (
            <div className="fy-frame">
              <Portrait
                worldSlug={slug}
                path={`artifacts/${boundaryFrame.file}`}
                label="Start frame"
                radius={0}
              />
              <span className="fy-frame__tag">
                START · BOUNDARY FRAME{frameRoute !== null ? "" : " (STEERS ONLY)"}
              </span>
            </div>
          ) : prevFrame ? (
            <div className="fy-frame">
              <Portrait worldSlug={slug} path={prevFrame} label="Start frame" radius={0} />
              <span className="fy-frame__tag">
                START · {prevShot!.id.replace("sh_", "SHOT ")}, LAST FRAME (PREVIEW)
              </span>
            </div>
          ) : (
            <div className="fy-frame fy-frame--empty">START · FROM THE BOARD</div>
          )}
          <div className="fy-frame fy-frame--empty">END · OPTIONAL</div>
        </div>
        <div className="fy-paramrow">
          {/* The production's delivery aspect (issue 389), never a hard-coded landscape. */}
          <span className="fy-param">{production ? productionAspect(production.meta) : "16:9"}</span>
          <span className="fy-param">720p</span>
          {shot && <span className="fy-param">{seconds(shot.durationSec)}</span>}
          {frameRoute !== null && boundaryFrame && (
            <span className="fy-param">opens on its boundary frame</span>
          )}
        </div>
        <div className="fy-gen__cta">
          {model && (
            <span className="fy-modelchip">
              {model.displayName}
              <span className="fy-mono">{modelCapabilityCopy(model)}</span>
            </span>
          )}
          <span className="fy-h1row__push" />
          <Button
            variant="primary"
            disabled={generatorPending || shotId === null}
            onClick={() => shotId !== null && openGenerator(shotId)}
          >
            {generatorPending ? "Opening…" : "Open generation session"}
          </Button>
          {generatorError === null ? null : <span role="alert" className="fy-mono">{generatorError}</span>}
        </div>
      </div>
      <div className="fy-gen__center">
        {take ? (
          <>
            <div className="fy-gen__meta">
              <span className="fy-mono">
                take {takes.indexOf(take) + 1} · {take.model} · {seconds(shot?.durationSec)}
                {take.completedAt ? ` · finished ${take.completedAt.slice(11, 16)}` : ""}
              </span>
              <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span className={`fy-dot fy-dot--${decisionTone(decisions[take.id])}`} />
                <span className="fy-mono">{decisions[take.id] ?? "pending"}</span>
              </span>
            </div>
            <div className="fy-viewer">
              <Portrait
                worldSlug={slug}
                path={takeMediaPath(production!, take) ?? ""}
                label={`Take: first frame`}
                radius={0}
              />
              <span className="fy-playbtn" aria-hidden style={{ pointerEvents: "none" }}>
                <Play size={22} />
              </span>
            </div>
            <div className="fy-scrub">
              <span className="fy-mono">0:00</span>
              <div className="fy-scrub__bar">
                <div className="fy-scrub__fill" style={{ width: "0%" }} />
              </div>
              <span className="fy-mono">{seconds(shot?.durationSec)}</span>
            </div>
            <div className="fy-gen__verdict">
              <Button
                variant="primary"
                disabled={!shotId || decisions[take.id] === "accepted"}
                onClick={() => worldId && prodId && shotId && acceptTake(worldId, prodId, take.id, shotId)}
              >
                Accept take
              </Button>
              <Button
                disabled={
                  Object.keys(take.provenance.sheets).length === 0 || decisions[take.id] === "rejected"
                }
                title="A rejection cites the sheet the take drifted from"
                onClick={() => {
                  const sheet = Object.keys(take.provenance.sheets)[0];
                  if (worldId && prodId && sheet)
                    rejectTake(
                      worldId,
                      prodId,
                      take.id,
                      { sheet, field: "appearance", note: "rejected in review" },
                      shotId ?? undefined,
                    );
                }}
              >
                Reject · cite the sheet
              </Button>
              <span className="fy-h1row__push" />
              <span className="fy-mono">rejections teach the shot · accepts lock the clip into the cut</span>
            </div>
          </>
        ) : (
          <EmptyState
            title="No takes for this shot yet"
            hint="Dispatch sends the shot out; takes land here for review."
          />
        )}
      </div>
      <div className="fy-gen__takes">
        <div className="fy-eyebrow-sm" style={{ textAlign: "center" }}>
          TAKES
        </div>
        {takes.map((t, i) => (
          <button
            key={t.id}
            type="button"
            className={cx("fy-taketile", take?.id === t.id && "fy-taketile--active")}
            onClick={() => setSelectedTakeId(t.id)}
          >
            <div className="fy-taketile__frame">
              <Portrait
                worldSlug={slug}
                path={takeMediaPath(production!, t) ?? ""}
                label={`take ${i + 1}`}
                radius={0}
              />
            </div>
            <div className="fy-taketile__meta">
              <span>{i + 1}</span>
              <span
                className={`fy-dot fy-dot--${decisionTone(decisions[t.id])}`}
                style={{ width: 5, height: 5 }}
              />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Who rides, and who rides in a look (design 67).
 *
 * `refs ×3` said how many images travel and nothing about what they are — so the one decision a
 * production makes about a character's appearance reached the model without ever appearing on the
 * screen that authorises the spend. A look attached on the character's page changed the request
 * silently, and the only way to find out was to read the take that came back.
 *
 * Subjects are named once each; the count beside it still says how many images that is, which is
 * the other fact, and a subject carrying two references is one subject either way.
 */
export function carriedSubjects(references: readonly CompiledReference[]): string {
  // Keyed by sheet, displayed by name. Two sheets can carry one name — creation uniquifies the
  // slug, never the name — and keying by the name merged them into one entry whose `(look)`
  // could then belong to the other person entirely. Naming who rides is the whole point here.
  const subjects = new Map<string, { subject: string; look: boolean }>();
  for (const reference of references) {
    const held = subjects.get(reference.sheetId);
    subjects.set(reference.sheetId, {
      subject: reference.subject,
      look: (held?.look ?? false) || reference.mode === "scoped-look",
    });
  }
  return [...subjects.values()]
    .map((entry) => (entry.look ? `${entry.subject} (look)` : entry.subject))
    .join(", ");
}

/**
 * One pass, said as the dispatch it is: route, what rides, length, price.
 *
 * Module-level and pure, so the line can be read back in a test rather than re-spelled there —
 * a second copy of this format would be a second answer to what the dispatch is.
 */
export function passRow(pass: CompiledPass): string {
  const route =
    pass.route.kind === "frame"
      ? "first-frame route"
      : pass.route.kind === "reference"
        ? `reference route · refs ×${pass.references.length} · ${carriedSubjects(pass.references)}`
        : "text route";
  const length = pass.askedSec !== undefined ? ` · ${seconds(pass.askedSec)}` : "";
  return `${route}${length} · ${usd(pass.estimatedMicroUsd)}`;
}

export function VoiceLineDialogScreen() {
  const { worldId, prodId } = useParams();
  const [params] = useSearchParams();
  const { world, production } = useProduction(worldId, prodId);
  const clientState = useStore().state;
  const navigate = useNavigate();
  const spoken =
    production?.scenes.flatMap((s) => orderedShots(s)).filter((s) => s.audio?.line && s.audio.speaker) ?? [];
  // The shot the row asked for. Without this the dialog showed whichever line came first, so
  // pressing Generate beside one character opened another character's line.
  const asked = params.get("shot");
  const shot = spoken.find((s) => s.id === asked) ?? spoken[0];
  const speaker = shot?.audio?.speaker ? world?.sheets.find((c) => c.id === shot.audio!.speaker) : undefined;
  const voiceModel = speaker?.voice
    ? clientState?.app.manifest?.models.find(
        (model) =>
          model.provider === speaker.voice!.provider &&
          model.capability === "voice-tts" &&
          model.id ===
            (speaker.voice!.model ??
              legacyVoiceModel(speaker.voice!.provider, speaker.voice!.voiceId, world?.clonedVoices ?? [])),
      )
    : undefined;
  const voiceDeliveries = supportedDeliveries(voiceModel);
  const voiceReadiness =
    speaker?.voice && voiceModel?.provider === "comfyui"
      ? clientState?.app.comfyui?.recipes.find((recipe) => recipe.recipeId === voiceModel.id)
      : null;
  const voiceUnavailableReason =
    voiceReadiness?.state === "disabled" ||
    (voiceReadiness?.state === "unknown" && clientState?.app.comfyui?.engine.locality === "local")
      ? (voiceReadiness.reason ?? "The assigned voice recipe is not ready.")
      : voiceModel === undefined && speaker?.voice
        ? "The assigned voice model is no longer available."
        : null;
  const [sending, setSending] = useState(false);
  const [delivery, setDelivery] = useState<Delivery | "">("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const [uploadConfirmation, setUploadConfirmation] = useState<{
    destinationLabel: string;
    confirmationToken: string;
  } | null>(null);
  useEffect(
    () =>
      subscribeQueueResults((result) => {
        if (result.requestId !== pending.current) return;
        pending.current = null;
        setSending(false);
        if (result.disposition === "accepted") navigate(`/w/${worldId}/p/${prodId}/audio`);
        else setRefusal(result.failures[0]?.reason ?? "The line could not be queued.");
      }),
    [navigate, worldId, prodId],
  );
  useEffect(
    () =>
      subscribeVoiceUploadConfirmations((confirmation) => {
        if (confirmation.requestId !== pending.current) return;
        setUploadConfirmation(confirmation);
      }),
    [],
  );
  const generateLine = (voiceUploadConfirmedFor?: string) => {
    if (!worldId || !prodId || !shot) return;
    setRefusal(null);
    setSending(true);
    pending.current = requestVoiceLine({
      worldId,
      productionId: prodId,
      shotId: shot.id,
      ...(delivery ? { delivery } : {}),
      ...(voiceUploadConfirmedFor !== undefined ? { voiceUploadConfirmedFor } : {}),
    });
  };
  return (
    <div className="fy-dialogwrap" data-screen="voice-line-dialog">
      <div className="fy-dialog" style={{ maxWidth: 560 }}>
        <div className="fy-h1row">
          <h1 className="fy-h1" style={{ fontSize: 22 }}>
            Voice line
          </h1>
          <span className="fy-h1row__push" />
          <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}>
            Close
          </Button>
        </div>
        <DegradedBanner component="voice" />
        {shot && speaker ? (
          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
            <div style={{ width: 56, height: 64, flex: "none" }}>
              <Portrait
                worldSlug={world?.meta.slug}
                path={sheetPortraitPath(speaker.id)}
                label={speaker.name}
                radius={8}
              />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ font: "600 14px var(--font-sans)" }}>{speaker.name}</div>
              <div
                style={{
                  font: "400 13px/1.5 var(--font-sans)",
                  color: "var(--muted-foreground)",
                  fontStyle: "italic",
                  marginTop: 2,
                }}
              >
                “{shot.audio!.line}”
              </div>
              <div className="fy-mono" style={{ marginTop: 4 }}>
                {`voice · ${speaker.voice ? `${speaker.voice.label ?? speaker.voice.voiceId} (${speaker.voice.provider})` : "none assigned"}`}
              </div>
            </div>
          </div>
        ) : (
          <EmptyState title="No spoken lines in this production yet" />
        )}
        {refusal !== null && <p className="fy-refusal">{refusal}</p>}
        {voiceUnavailableReason !== null && (
          <p className="fy-refusal">Assigned voice unavailable · {voiceUnavailableReason}</p>
        )}
        {speaker?.voice &&
          (voiceDeliveries.length > 0 ? (
            <select
              aria-label="Delivery"
              className="fy-bench__chip"
              value={delivery}
              onChange={(event) => setDelivery(event.target.value as Delivery | "")}
            >
              <option value="">delivery · default</option>
              {DELIVERIES.filter((item) => voiceDeliveries.includes(item)).map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          ) : (
            <span className="fy-mono">delivery · provider default only</span>
          ))}
        <div>
          <Button
            variant="primary"
            data-testid="voice-line-generate"
            disabled={
              shot === undefined ||
              speaker === undefined ||
              speaker.voice === undefined ||
              voiceUnavailableReason !== null ||
              sending
            }
            title={
              speaker !== undefined && speaker.voice === undefined
                ? `${speaker.name} has no assigned voice — choose one on their sheet`
                : (voiceUnavailableReason ?? undefined)
            }
            onClick={() => generateLine()}
          >
            {sending ? "Generating…" : "Generate line"}
          </Button>
        </div>
        {uploadConfirmation && (
          <RemoteVoiceUploadConfirmation
            destinationLabel={uploadConfirmation.destinationLabel}
            onCancel={() => {
              pending.current = null;
              setSending(false);
              setUploadConfirmation(null);
            }}
            onConfirm={() => {
              const token = uploadConfirmation.confirmationToken;
              setUploadConfirmation(null);
              generateLine(token);
            }}
          />
        )}
      </div>
    </div>
  );
}

// ---- Cut (24a) -------------------------------------------------------------

/** A tenth of a second: editorial rather than per-frame, and it lands on a frame at 10/20/30fps. */
const TRIM_STEP_SEC = 0.1;

/**
 * The cut, watchable (24a's "Watch from top", finally doing something).
 *
 * One `<video>` walked across the derived spans rather than a clip per element: the cut plays one
 * piece of picture at a time by construction, and a span that has nothing to show says so instead
 * of holding the previous frame.
 */
/** What a dropped artifact covers when nothing says otherwise: about a shot's worth. */
const CLIP_DEFAULT_SEC = 4;

/** One lane row plus the gap under it, which is what a drag has to cross to change lane. */
const LANE_PITCH_PX = 50;

/** The clip menu's own box, so a right-click near an edge opens somewhere it can be read. */
const CLIP_MENU_WIDTH_PX = 216;
const CLIP_MENU_HEIGHT_PX = 96;

function focusFirstControl(pane: HTMLElement | null): void {
  pane?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), [href], [tabindex='0']")?.focus();
}

function editorMediaMatches(query: string): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

/**
 * The world's artifacts, beside the cut (82a).
 *
 * Rows are drag sources and nothing else — the panel never places anything itself, because a
 * placement needs a time and only the lane knows one.
 */
function ArtifactPanel({
  worldId,
  artifacts,
  slug,
  production,
  timeline,
  playheadFrame,
  usedArtifactIds,
  usedShotIds,
  library,
  onOpenPicker,
  onAddLine,
  onAddArtifact,
  onAddShot,
  onLocate,
  initialFilter = "all",
  open,
  onClose,
  panelRef,
  foot,
}: {
  worldId: string | undefined;
  artifacts: readonly ArtifactSidecar[];
  slug: string | undefined;
  production: ProductionBundle | null | undefined;
  /** The base every use is looked up on (R-8, R-11); null while there is no editable record. */
  timeline: ProductionTimeline | null;
  playheadFrame: number;
  usedArtifactIds: ReadonlySet<string>;
  usedShotIds: ReadonlySet<string>;
  /** What the record's Library holds (R-8, amended 2026-09-02): the rows, not everything filed. */
  library: readonly TimelineLibraryItem[];
  onOpenPicker: (() => void) | null;
  /** A read line lands on Dialogue (the Audio screen's rows, kept here since it redirects; R-1). */
  onAddLine: ((take: Take, shot: Shot, sceneNumber: number) => void) | null;
  onAddArtifact: ((artifact: ArtifactSidecar) => void) | null;
  onAddShot: ((shotId: string) => void) | null;
  /** Select one use and bring the playhead to it (R-11, R-16). */
  onLocate: (clipId: TimelineClipId, startFrame: number) => void;
  initialFilter?: LibraryFilter;
  open: boolean;
  onClose: () => void;
  panelRef: RefObject<HTMLElement | null>;
  foot?: React.ReactNode;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LibraryFilter>(initialFilter);
  const [picked, setPicked] = useState<string | null>(null);
  /*
   * Which use Locate reached last, per item (R-11): the next press goes on from there, and the
   * last use wraps to the first. View state, never written — Locate selects and seeks only.
   */
  const located = useRef(new Map<string, { id: TimelineClipId; frame: number }>());
  const normalQuery = query.trim().toLocaleLowerCase();
  const takesById = new Map((production?.takes ?? []).map((take) => [take.id, take] as const));
  const inLibrary = new Set(library.map(libraryItemKey));
  const [sceneFilter, setSceneFilter] = useState<string>("all");
  // The panel can outlive a production change (the router keeps the screen); a scene of the last production is no filter here.
  const sceneScope = (production?.scenes ?? []).some((scene) => scene.id === sceneFilter) ? sceneFilter : "all";
  const shots = (production?.scenes ?? []).flatMap((scene) =>
    orderedShots(scene).filter((shot) => inLibrary.has(`shot:${shot.id}`)).map((shot) => {
      const takeId = production ? acceptedTakeId(production, shot.id) : null;
      const take = takeId === null ? null : (takesById.get(takeId) ?? null);
      return { scene, shot, take, path: take && production ? takeMediaPath(production, take) : null };
    }),
  );
  const usesOf = (matches: (clip: TimelineClip) => boolean): Array<{ id: TimelineClipId; startFrame: number }> =>
    (timeline?.tracks ?? [])
      .flatMap((track) => track.clips.filter(matches).map((clip) => ({ id: clip.id, startFrame: clip.startFrame })))
      .sort((a, b) => a.startFrame - b.startFrame);
  const laneOf = (artifact: ArtifactSidecar): string | null =>
    artifact.kind === "audio" ? "Music" : artifact.kind === "video" || artifact.kind === "image" || artifact.kind === "board" ? "Picture" : null;

  /*
   * One flat list, in the target's density (R-8a): accepted takes and shots waiting for one,
   * then filed artifacts. Every row states where it lands; a row that cannot be placed says why
   * and stays in the list (R-12).
   */
  interface LibraryItem {
    key: string;
    name: string;
    sub: string;
    subTone: "muted" | "destructive";
    thumb: React.ReactNode;
    lane: string | null;
    why: string | null;
    used: boolean;
    uses: Array<{ id: TimelineClipId; startFrame: number }>;
    add: (() => void) | null;
    drag: string | null;
    search: string;
    kind: "take" | "shot" | "artifact" | "line";
    /** The scenes this row belongs to: a shot's own, an artifact's links. */
    scenes: string[];
    /** A spoken line's shot, and what has been read of it. */
    line?: { shotId: string; status: "read" | "reading…" | "not generated" };
  }
  const shotItems: LibraryItem[] = shots.map(({ scene, shot, take, path }) => {
    const used = usedShotIds.has(shot.id);
    const line = shot.audio?.line ?? "";
    return {
      key: `shot:${shot.id}`,
      name: `Shot ${shot.number} · ${shot.title}`,
      sub: take === null ? "no accepted take" : `SC ${scene.number} · ${take.id}`,
      subTone: take === null ? "destructive" : "muted",
      thumb: take && path ? <Portrait worldSlug={slug} path={path} label="" radius={4} /> : <Film size={12} />,
      lane: "Picture",
      why: null,
      used,
      uses: usesOf((clip) => clip.source.kind === "shot" && clip.source.shotId === shot.id),
      add: onAddShot !== null && !used ? () => onAddShot(shot.id) : null,
      drag: take !== null && path !== null ? `shot:${shot.id}` : null,
      search: `${scene.number} ${scene.title} ${shot.number} ${shot.title} ${shot.id} ${take?.id ?? ""} ${line}`,
      kind: take === null ? "shot" : "take",
      scenes: [scene.id],
    };
  });
  const artifactItems: LibraryItem[] = artifacts.filter((artifact) => inLibrary.has(`artifact:${artifact.id}`)).map((artifact) => {
    const lane = laneOf(artifact);
    const name = artifact.file.split("/").pop() ?? artifact.file;
    return {
      key: `artifact:${artifact.id}`,
      name,
      sub: lane === null ? `${artifact.kind} · no picture or sound to place` : artifact.kind,
      subTone: "muted",
      thumb:
        artifact.kind === "image" || artifact.kind === "board" ? (
          <Portrait worldSlug={slug} path={artifact.file} label="" radius={4} />
        ) : artifact.kind === "audio" ? (
          <Wave seed={artifact.file} width={34} height={12} />
        ) : artifact.kind === "video" ? (
          <VideoMark size={12} />
        ) : (
          <Scroll size={12} />
        ),
      lane,
      why: lane === null ? `a ${artifact.kind} has no picture or sound to place` : null,
      used: usedArtifactIds.has(artifact.id),
      uses: usesOf((clip) => clip.source.kind === "artifact" && clip.source.artifactId === artifact.id),
      add: onAddArtifact !== null && lane !== null ? () => onAddArtifact(artifact) : null,
      drag: lane === null ? null : artifact.id,
      search: `${artifact.file} ${artifact.kind} ${artifact.links.join(" ")}`,
      kind: "artifact",
      scenes: [...artifact.links],
    };
  });
  // Every spoken line in the story (the Audio screen's dialogue rows): read or not, with the way
  // to read it, and a place on Dialogue once it is. Under `All` only the lines of shots in the
  // Library show; the audio filter shows them all, as the Audio address did.
  const lineItems: LibraryItem[] = (production?.scenes ?? []).flatMap((scene) =>
    orderedShots(scene)
      .filter((shot) => (shot.audio?.kind === "vo" || shot.audio?.kind === "dialogue") && (shot.audio.line?.trim() ?? "") !== "")
      .map((shot) => {
        // The newest read that can play: a fresh `Again` still running does not take the last good one away.
        const voice = production ? [...takesForShot(production, shot.id)].reverse().filter((take) => take.kind === "voice") : [];
        const read = voice.find((take) => take.completedAt !== undefined && take.media !== undefined) ?? null;
        const reading = voice.some((take) => take.completedAt === undefined);
        const status: "read" | "reading…" | "not generated" = read !== null ? "read" : reading ? "reading…" : "not generated";
        const uses = read === null ? [] : usesOf((clip) => clip.source.kind === "take" && clip.source.takeId === read.id);
        return {
          key: `line:${shot.id}`,
          name: `“${shot.audio!.line!.trim()}”`,
          sub: `SH ${shot.number} · ${shot.audio?.speaker ?? shot.audio?.kind ?? "line"}`,
          subTone: "muted" as const,
          thumb: <Mic size={12} />,
          lane: "Dialogue",
          why: read === null ? "read the line first" : null,
          used: uses.length > 0,
          uses,
          add: read !== null && read.completedAt !== undefined && onAddLine !== null ? () => onAddLine(read, shot, scene.number) : null,
          drag: null,
          search: `${scene.number} ${scene.title} ${shot.number} ${shot.title} ${shot.id} ${shot.audio?.speaker ?? ""} ${shot.audio?.line ?? ""} line`,
          kind: "line" as const,
          scenes: [scene.id],
          line: { shotId: shot.id, status },
        };
      }),
  );
  const passes = (item: LibraryItem): boolean => {
    if (sceneScope !== "all" && !item.scenes.includes(sceneScope)) return false;
    if (item.kind === "line" && filter !== "audio" && !inLibrary.has(`shot:${item.line!.shotId}`)) return false;
    if (filter === "needs-take" && item.kind !== "shot") return false;
    if (filter === "audio" && !((item.kind === "artifact" && item.lane === "Music") || item.kind === "line")) return false;
    if (filter === "unused" && (item.used || item.kind === "shot")) return false;
    if (filter === "all" && item.kind === "shot") return true;
    return normalQuery === "" || item.search.toLocaleLowerCase().includes(normalQuery);
  };
  const items = [...shotItems, ...lineItems, ...artifactItems].filter((item) => passes(item) && (normalQuery === "" || item.search.toLocaleLowerCase().includes(normalQuery)));
  const locate = (item: LibraryItem) => {
    if (item.uses.length === 0) return;
    const last = located.current.get(item.key);
    const index = last === undefined ? -1 : item.uses.findIndex((use) => use.id === last.id);
    // A repeat with the playhead still where Locate left it goes on to the next use, and the
    // last wraps to the first; a playhead that moved since starts over from where it is.
    const next =
      last !== undefined && index >= 0 && last.frame === playheadFrame
        ? item.uses[(index + 1) % item.uses.length]!
        : (item.uses.find((use) => use.startFrame >= playheadFrame) ?? item.uses[0]!);
    located.current.set(item.key, { id: next.id, frame: next.startFrame });
    onLocate(next.id, next.startFrame);
  };

  return (
    <aside ref={panelRef} className="fy-artpanel" id="cut-library" data-open={open} aria-label="Library">
      <div className="fy-artpanel__head">
        <span className="fy-artpanel__title">Library</span>
        <span className="fy-mono fy-artpanel__count">{items.length} item{items.length === 1 ? "" : "s"}</span>
        <span className="fy-h1row__push" />
        <button
          type="button"
          className="fy-tlbtn fy-tip"
          data-tip="Upload from this machine"
          aria-label="Upload from this machine"
          disabled={worldId === undefined}
          onClick={() => worldId && uploadArtifacts(worldId)}
        >
          <Upload size={12} />
        </button>
        <button type="button" className="fy-artpanel__add" disabled={onOpenPicker === null} onClick={() => onOpenPicker?.()}>
          <Plus size={11} />
          Add
        </button>
        <button type="button" className="fy-artpanel__close" aria-label="Close Library" onClick={onClose}>
          &times;
        </button>
      </div>
      <div className="fy-artpanel__find">
        <label className="fy-artpanel__search">
          <Search size={12} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a take, upload or line…"
            aria-label="Search Library"
          />
        </label>
        <div className="fy-artpanel__filters" role="group" aria-label="Library filters">
          {(
            [
              ["all", "All"],
              ["unused", "Not in the cut"],
              ["needs-take", "Needs a take"],
              ["audio", "Audio"],
            ] as const
          ).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>
              {label}
            </button>
          ))}
          {(production?.scenes.length ?? 0) > 1 && (
            <select className="fy-artpanel__scene" aria-label="Scene" value={sceneScope} onChange={(event) => setSceneFilter(event.target.value)}>
              <option value="all">All scenes</option>
              {(production?.scenes ?? []).map((scene) => (
                <option key={scene.id} value={scene.id}>
                  SC {scene.number} · {scene.title}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      <div className="fy-artpanel__list">
        {items.length === 0 ? (
          <div className="fy-artpanel__empty">
            <span className="fy-artpanel__emptymark">
              <Folder size={14} />
            </span>
            <span>
              {normalQuery !== "" || filter !== "all" || sceneScope !== "all"
                ? "Nothing here matches."
                : "Nothing in the library yet. Add takes, uploads or lines to cut with."}
            </span>
          </div>
        ) : (
          items.map((item) => {
            const selected = picked === item.key;
            return (
              <div
                key={item.key}
                className={cx("fy-artrow", selected && "fy-artrow--picked", item.subTone === "destructive" && "fy-artrow--missing")}
                data-library-item={item.key}
                draggable={item.drag !== null}
                onDragStart={(event) => {
                  if (item.drag === null) return;
                  event.dataTransfer.setData(ARTIFACT_DRAG_TYPE, item.drag);
                  if (item.drag.startsWith("shot:")) event.dataTransfer.setData(SHOT_DRAG_TYPE, "1");
                  event.dataTransfer.setData(item.lane === "Music" ? LANE_DRAG_SOUND : LANE_DRAG_PICTURE, "1");
                  event.dataTransfer.effectAllowed = "copy";
                }}
              >
                <button
                  type="button"
                  className="fy-artrow__pick"
                  aria-pressed={selected}
                  title={item.why ?? (item.lane !== null ? `Drag onto the timeline · lands on ${item.lane}` : undefined)}
                  onClick={() => setPicked(selected ? null : item.key)}
                >
                  <span className="fy-artrow__swatch">{item.thumb}</span>
                  <span className="fy-artrow__body">
                    <span className="fy-artrow__name">{item.name}</span>
                    <span className={cx("fy-artrow__meta", item.subTone === "destructive" && "fy-artrow__meta--destructive")}>{item.sub}</span>
                  </span>
                  {item.used && <span className="fy-artrow__dot" title="In the cut" aria-label="In the cut" />}
                  {item.line !== undefined && (
                    <span className={cx("fy-artrow__status", item.line.status === "not generated" && "fy-artrow__status--missing")}>{item.line.status}</span>
                  )}
                  <span className="fy-artrow__lane">{item.lane ?? "—"}</span>
                </button>
                {item.line !== undefined && production && (
                  <button
                    type="button"
                    className="fy-tlbtn fy-tlbtn--text fy-artrow__voice"
                    onClick={() => navigate(`/w/${worldId}/p/${production.meta.id}/generate/voice-line?shot=${encodeURIComponent(item.line!.shotId)}`)}
                  >
                    {item.line.status === "not generated" ? "Generate" : "Again"}
                  </button>
                )}
                {selected && (
                  <div className="fy-artrow__actions" role="group" aria-label={`${item.name} actions`}>
                    {item.add !== null && (
                      <button type="button" className="fy-tlbtn fy-tlbtn--text" onClick={item.add}>
                        <Plus size={11} />
                        Add to timeline
                      </button>
                    )}
                    {item.uses.length > 0 && (
                      <button type="button" className="fy-tlbtn fy-tlbtn--text" onClick={() => locate(item)}>
                        <Locate size={11} />
                        Locate in timeline
                        {item.uses.length > 1 && <span className="fy-mono">{item.uses.length}</span>}
                      </button>
                    )}
                    {item.why !== null && <span className="fy-artrow__why">{item.why}</span>}
                    {item.add === null && item.why === null && item.uses.length === 0 && (
                      <span className="fy-artrow__why">{item.kind === "shot" ? "generate a take to place this shot" : "already in the cut"}</span>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      <div className="fy-artpanel__foot">
        <span className="fy-dot" />
        <span className="fy-mono">drag onto a lane to place</span>
        {foot}
      </div>
    </aside>
  );
}

type LibraryFilter = "all" | "unused" | "needs-take" | "audio";

function ClipView({
  worldId,
  prodId,
  clip,
  artifact,
  slug,
  totalSec,
  maxLane,
  snapPoints,
  onMenu,
  selected,
  onSelect,
}: {
  worldId: string;
  prodId: string;
  clip: CutOverlay;
  artifact: ArtifactSidecar | undefined;
  slug: string | undefined;
  totalSec: number;
  maxLane: number;
  snapPoints: readonly number[];
  onMenu: (clip: CutOverlay, at: { x: number; y: number }) => void;
  selected: boolean;
  onSelect: (clipId: string) => void;
}) {
  const [draft, setDraft] = useState<ClipPlacement | null>(null);
  const shown = draft ?? { startSec: clip.startSec, endSec: clip.endSec, lane: clip.lane ?? 0 };

  const begin = (gesture: ClipGesture) => (e: React.PointerEvent) => {
    if (e.button !== 0 || totalSec <= 0) return;
    onSelect(clip.id);
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    /*
     * Seconds per pixel come from the lane the clip sits in, never from the column of lanes: the
     * column also carries the label gutter, so measuring that makes every drag fall behind the
     * pointer by exactly the gutter's share of the width.
     */
    const laneWidth = el.closest(".fy-track__lane")?.getBoundingClientRect().width ?? 0;
    if (laneWidth <= 0) return;
    const originX = e.clientX;
    const originY = e.clientY;
    const origin: ClipPlacement = { startSec: clip.startSec, endSec: clip.endSec, lane: clip.lane ?? 0 };
    let last = origin;
    const move = (ev: PointerEvent) => {
      // Lanes are drawn highest-first, so dragging upward is dragging to a nearer lane.
      const lanes = gesture === "move" ? -Math.round((ev.clientY - originY) / LANE_PITCH_PX) : 0;
      const seconds = ((ev.clientX - originX) / laneWidth) * totalSec;
      last = applyClipDrag(origin, gesture, seconds, lanes, { totalSec, maxLane, snapPoints });
      setDraft(last);
    };
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setDraft(null);
      // Nothing moved is nothing to file: a click that selects should not write history.
      if (last.startSec !== origin.startSec || last.endSec !== origin.endSec || last.lane !== origin.lane) {
        moveOverlay(worldId, prodId, clip.id, last.startSec, last.endSec, last.lane);
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const name = artifact?.file.split("/").pop() ?? "missing artifact";
  const mode = clip.audio ?? "keep";
  const sound = mode === "only";
  return (
    <div
      className={cx(
        "fy-ovclip",
        sound && "fy-ovclip--sound",
        selected && "fy-ovclip--selected",
        draft && "fy-ovclip--dragging",
      )}
      style={{
        left: `${(shown.startSec / totalSec) * 100}%`,
        width: `${Math.max(((shown.endSec - shown.startSec) / totalSec) * 100, 1.5)}%`,
        /*
         * The row a clip is drawn in is decided by its *committed* lane, so a cross-lane drag
         * would otherwise slide along its old row and only jump after the round-trip — no
         * confirmation the lane even registered until it was too late to change your mind.
         * Lanes are drawn highest-first, so a higher target lane is one row up.
         */
        ...(draft && draft.lane !== (clip.lane ?? 0)
          ? { transform: `translateY(${((clip.lane ?? 0) - draft.lane) * LANE_PITCH_PX}px)` }
          : {}),
      }}
      title={`${name} · ${shown.startSec.toFixed(1)}s → ${shown.endSec.toFixed(1)}s${mode === "keep" ? "" : ` · ${mode === "only" ? "sound only" : "muted"}`}`}
      onPointerDown={begin("move")}
      onClick={() => onSelect(clip.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onSelect(clip.id);
        onMenu(clip, { x: e.clientX, y: e.clientY });
      }}
    >
      <span
        className="fy-ovclip__grip fy-ovclip__grip--start"
        onPointerDown={begin("trim-start")}
        aria-label="trim the head"
      />
      {artifact?.kind === "image" || artifact?.kind === "board" ? (
        <span className="fy-ovclip__swatch">
          <Portrait worldSlug={slug} path={artifact.file} label="" radius={3} />
        </span>
      ) : sound || artifact?.kind === "audio" ? (
        <span className="fy-ovclip__swatch fy-ovclip__swatch--wave">
          <Wave seed={name} width={34} height={12} />
        </span>
      ) : null}
      <span className="fy-ovclip__name">{name}</span>
      {mode !== "keep" && <span className="fy-ovclip__badge">{sound ? "A" : "MUTE"}</span>}
      <button
        type="button"
        className="fy-ovclip__x"
        aria-label="Remove clip"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          removeOverlay(worldId, prodId, clip.id);
        }}
      >
        ×
      </button>
      <span
        className="fy-ovclip__grip fy-ovclip__grip--end"
        onPointerDown={begin("trim-end")}
        aria-label="trim the tail"
      />
    </div>
  );
}

/**
 * The lanes (82a, extended).
 *
 * A lane has no type. What a clip does is read from the artifact it cites, so the same row holds
 * a plate, an insert and a music bed — and splitting a video's sound puts two clips over one file
 * on two lanes rather than inventing an audio track that only audio may enter.
 *
 * Drawn highest-first, because a higher lane composites nearer the viewer and every editor this
 * cut can be handed to already draws it that way round. That is also what makes "split the sound
 * to the lane below" mean the row the eye expects.
 */
function ClipLanes({
  worldId,
  prodId,
  slug,
  totalSec,
  clips,
  artifacts,
  snapPoints,
  selectedClipId,
  onSelectClip,
}: {
  worldId: string;
  prodId: string;
  slug: string | undefined;
  totalSec: number;
  clips: readonly CutOverlay[];
  artifacts: readonly ArtifactSidecar[];
  snapPoints: readonly number[];
  selectedClipId: string | null;
  onSelectClip: (clipId: string) => void;
}) {
  const [over, setOver] = useState<number | null>(null);
  const [added, setAdded] = useState(0);
  const [menu, setMenu] = useState<{ clip: CutOverlay; x: number; y: number } | null>(null);

  /*
   * Dismissed from anywhere, not only from inside the lanes (review). A menu whose only escape
   * was a press on the column it came from stayed painted over whatever the person moved on to,
   * with its buttons still live against a clip they were no longer looking at.
   */
  useEffect(() => {
    if (menu === null) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        e.stopImmediatePropagation();
      }
    };
    // Capture, so a press that a clip's own handler stops still closes the menu above it — but
    // not a press inside the menu, which would unmount the item before its click could fire.
    const closeOutside = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest(".fy-clipmenu")) return;
      close();
    };
    window.addEventListener("pointerdown", closeOutside, { capture: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    // `position: fixed` is viewport-anchored, so a scroll detaches the menu from its clip.
    window.addEventListener("scroll", close, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", closeOutside, { capture: true });
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, { capture: true });
    };
  }, [menu]);

  // Two lanes at rest: one to drop a picture on and one under it for the sound, which is the
  // shape every split leaves behind and the one people arrive expecting.
  const used = clips.reduce((high, c) => Math.max(high, c.lane ?? 0), 0);
  const laneCount = Math.min(Math.max(2, used + 1, added), MAX_CLIP_LANE + 1);
  const maxLane = laneCount - 1;

  const drop = (lane: number) => (e: React.DragEvent) => {
    e.preventDefault();
    setOver(null);
    const artifactId = e.dataTransfer.getData(ARTIFACT_DRAG_TYPE);
    if (!artifactId || totalSec <= 0) return;
    const box = e.currentTarget.getBoundingClientRect();
    const at = Math.max(
      0,
      Math.min(((e.clientX - box.left) / box.width) * totalSec, Math.max(0, totalSec - MIN_CLIP_SEC)),
    );
    const end = Math.min(at + CLIP_DEFAULT_SEC, totalSec);
    // A drop at the very end would ask for a window with no length; give it what is left.
    placeOverlay(
      worldId,
      prodId,
      artifactId,
      Math.round(at * 1000) / 1000,
      Math.round(Math.max(end, at + MIN_CLIP_SEC) * 1000) / 1000,
      lane,
    );
  };

  /*
   * Why a split is or is not on offer, in the same words the coordinator refuses in — the menu
   * used to offer it for any video and let the write fail into the app log, which is a refusal
   * nobody reading the screen ever sees.
   */
  const splitState = ((): { ok: boolean; why: string } => {
    if (menu === null) return { ok: false, why: "" };
    const mode = menu.clip.audio ?? "keep";
    if (mode === "only") return { ok: false, why: "this is already the sound half" };
    if (mode === "mute") return { ok: false, why: "already split" };
    const artifact = artifacts.find((a) => a.id === menu.clip.artifactId);
    if (artifact === undefined) return { ok: false, why: "this clip cites nothing this world has" };
    if (artifact.kind !== "video") return { ok: false, why: `a ${artifact.kind} has no sound to split` };
    if (artifact.mediaInfo === undefined) return { ok: false, why: "not measured yet — try again shortly" };
    if (!artifact.mediaInfo.hasAudio)
      return { ok: false, why: "measured as silent, so there is nothing to split" };
    return { ok: true, why: "" };
  })();
  const rejoinable = menu !== null && (menu.clip.audio ?? "keep") === "mute";

  return (
    <div className="fy-clanes" onPointerDown={() => setMenu(null)}>
      {Array.from({ length: laneCount }, (_, i) => maxLane - i).map((lane) => (
        <div className="fy-track" key={lane}>
          <span className="fy-track__label">Overlay L{lane}</span>
          <div
            className={cx("fy-track__lane", "fy-ovlane", over === lane && "fy-ovlane--over")}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              setOver(lane);
            }}
            onDragLeave={() => setOver((l) => (l === lane ? null : l))}
            onDrop={drop(lane)}
          >
            {clips.every((c) => (c.lane ?? 0) !== lane) && (
              <span className="fy-ovlane__empty">
                {lane === 0
                  ? "drop a bed here, or split a clip's sound down to it"
                  : "drop an artifact to place it"}
              </span>
            )}
            {clips
              .filter((c) => (c.lane ?? 0) === lane)
              .map((c) => (
                <ClipView
                  key={c.id}
                  worldId={worldId}
                  prodId={prodId}
                  clip={c}
                  artifact={artifacts.find((a) => a.id === c.artifactId)}
                  slug={slug}
                  totalSec={totalSec}
                  maxLane={maxLane}
                  snapPoints={snapPoints}
                  onMenu={(clip, at) => setMenu({ clip, x: at.x, y: at.y })}
                  selected={selectedClipId === c.id}
                  onSelect={onSelectClip}
                />
              ))}
          </div>
        </div>
      ))}
      <div className="fy-clanes__foot">
        <Button
          variant="ghost"
          size="sm"
          disabled={laneCount > MAX_CLIP_LANE}
          onClick={() => setAdded(laneCount + 1)}
        >
          Add lane
        </Button>
        <span className="fy-mono">
          a higher lane sits nearer the viewer · right-click a clip to split its sound
        </span>
      </div>
      {menu && (
        <div
          className="fy-clipmenu"
          /* Kept inside the viewport: a right-click near an edge would otherwise open the menu
             off the side of the window, where it can be neither read nor reached. */
          style={{
            left: Math.min(menu.x, Math.max(0, window.innerWidth - CLIP_MENU_WIDTH_PX - 8)),
            top: Math.min(menu.y, Math.max(0, window.innerHeight - CLIP_MENU_HEIGHT_PX - 8)),
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {rejoinable ? (
            <button
              type="button"
              className="fy-clipmenu__item"
              onClick={() => {
                rejoinOverlayAudio(worldId, prodId, menu.clip.id);
                setMenu(null);
              }}
            >
              Rejoin its sound
            </button>
          ) : (
            <button
              type="button"
              className="fy-clipmenu__item"
              disabled={!splitState.ok}
              onClick={() => {
                splitOverlayAudio(worldId, prodId, menu.clip.id);
                setMenu(null);
              }}
            >
              Split audio to the lane below
            </button>
          )}
          <button
            type="button"
            className="fy-clipmenu__item"
            onClick={() => {
              removeOverlay(worldId, prodId, menu.clip.id);
              setMenu(null);
            }}
          >
            Remove clip
          </button>
          {!rejoinable && !splitState.ok && <span className="fy-clipmenu__note">{splitState.why}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * Seek by dragging the ruler (24a's "1:26 / 2:40" made reachable).
 *
 * Proportional rather than pixels-per-second: the ruler spans the whole cut whatever the window
 * is doing, so the fraction of its width is the fraction of the film — the same arithmetic the
 * player dock already scrubs by.
 */
function CutScrubber({ totalSec, frameRate, transport }: { totalSec: number; frameRate: FrameRate; transport: Transport }) {
  const { time, seek, setPlaying } = transport;
  const seekToEvent = (e: React.PointerEvent | PointerEvent, el: HTMLElement) => {
    const box = el.getBoundingClientRect();
    const laneWidth = box.width - 88;
    if (laneWidth <= 0 || totalSec <= 0) return;
    const laneX = Math.max(0, Math.min(e.clientX - box.left - 88, laneWidth));
    seek((laneX / laneWidth) * totalSec);
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    // Scrubbing while it runs fights the transport for the same value; stop, then seek.
    setPlaying(false);
    seekToEvent(e, el);
    const move = (ev: PointerEvent) => seekToEvent(ev, el);
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") seek(time + 1);
    else if (e.key === "ArrowLeft") seek(time - 1);
    else if (e.key === "Home") seek(0);
    else if (e.key === "End") seek(totalSec);
    else return;
    e.preventDefault();
  };
  return (
    <div
      className="fy-timeline__ruler fy-scrub"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(totalSec)}
      aria-valuenow={Math.round(time)}
      aria-valuetext={formatTimecode(time, frameRate)}
    >
      <span className="fy-mono">{formatTimecode(0, frameRate)}</span>
      <span className="fy-h1row__push" />
      <span className="fy-mono">{formatTimecode(totalSec / 2, frameRate)}</span>
      <span className="fy-h1row__push" />
      <span className="fy-mono">{formatTimecode(totalSec, frameRate)}</span>
    </div>
  );
}

interface Transport {
  playing: boolean;
  time: number;
  timeRef: React.MutableRefObject<number>;
  setPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  seek: (seconds: number) => void;
}

/**
 * One clock for the screen (24a): the preview shows it and the timeline draws it, so it cannot
 * live inside either. `timeRef` is the hot value the frame loops read; `time` is what renders.
 */
function useCutTransport(totalSec: number): Transport {
  const timeRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  /*
   * A film can get shorter underneath the playhead (issue 453).
   *
   * On the story and song clocks the duration is authored and changes only when somebody edits
   * the story, but a media-only film is measured from its clips — trim the one that reaches
   * furthest, drag it earlier or delete it and the end moves back. `seek` clamps, and nothing was
   * calling `seek`: the viewer sat at `0:14 / 0:05` over no span at all, blank and stuck, until
   * the person happened to scrub or press play.
   */
  useEffect(() => {
    if (timeRef.current <= totalSec) return;
    timeRef.current = totalSec;
    setTime(totalSec);
  }, [totalSec]);
  const setPosition = useTransport({
    playing,
    durationSec: totalSec,
    timeRef,
    onTime: setTime,
    onEnded: () => setPlaying(false),
  });
  const seek = useCallback(
    (seconds: number) => {
      const at = Math.min(Math.max(0, seconds), totalSec);
      setPosition(at);
      setTime(at);
    },
    [totalSec, setPosition],
  );
  return { playing, time, timeRef, setPlaying, seek };
}

function CutPreview({
  slug,
  spans,
  totalSec,
  soundSec = 0,
  restartToken,
  transport,
  cueStyle = null,
  cueAt = null,
}: {
  slug: string | undefined;
  spans: PlaybackSpan[];
  totalSec: number;
  /** How far placed sound reaches, so a film with no picture is not reported as nothing. */
  soundSec?: number;
  restartToken: number;
  transport: Transport;
  /** The saved subtitle style, worn in full so the preview and the burn-in agree (SPEC-038 R-26). */
  cueStyle?: SubtitleStyle | null;
  /** The cue at a film second, read on the frame clock like the picture (round three). */
  cueAt?: ((sec: number) => ReturnType<typeof cueAtSec>) | null;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const { playing, time, timeRef, setPlaying, seek } = transport;
  /*
   * Subtitles change on the same frame loop as the picture: `time` reaches React four times a
   * second, which would open and close every cue up to a quarter second late against the sound
   * it captions. The lookup travels through a ref so the loops never restart for it, and the
   * state only moves when the cue does.
   */
  const cueAtRef = useRef(cueAt);
  cueAtRef.current = cueAt;
  const [liveCue, setLiveCue] = useState<ReturnType<typeof cueAtSec>>(() => cueAt?.(timeRef.current) ?? null);
  const syncCue = useCallback((at: number) => {
    const next = cueAtRef.current?.(at) ?? null;
    setLiveCue((previous) => (previous?.id === next?.id && previous?.text === next?.text ? previous : next));
  }, []);
  useEffect(() => {
    syncCue(timeRef.current);
  }, [cueAt, syncCue, timeRef]);

  // "Watch from top" (24a): rewind and run, without remounting the element and refetching media.
  useEffect(() => {
    if (restartToken === 0) return;
    seek(0);
    setPlaying(true);
  }, [restartToken]);

  const srcFor = (span: PlaybackSpan | null) => (span?.path && slug ? mediaUrl(slug, span.path) : null);
  /*
   * A still needs an element that decodes images (issue 453).
   *
   * Everything the story and the song clocks produce is footage, so one `<video>` was always
   * enough. A placed clip can be a plate or a board, and a browser does not decode a PNG as
   * video — handing one to the video element shows nothing while the export holds that frame for
   * the whole placement. So the two are separated at the source: the video never receives a
   * still, and the still is drawn over it by an `<img>` wearing the same class.
   */
  // An overlay with a base under it keeps the base video playing beneath it (rounds eight and
  // nine): the base element plays the base, a still is drawn by the image, and a video overlay
  // plays in its own element on top — the composition the export makes.
  const videoSrcFor = (span: PlaybackSpan | null) =>
    span?.under !== undefined && slug ? mediaUrl(slug, span.under.path) : span?.still ? null : srcFor(span);
  const stillSrcFor = (span: PlaybackSpan | null) => (span?.still ? srcFor(span) : null);
  const overlayVideoSrcFor = (span: PlaybackSpan | null) => (span !== null && !span.still && span.under !== undefined ? srcFor(span) : null);
  const overlayVideo = useRef<HTMLVideoElement>(null);
  const syncOverlayVideo = useCallback(
    (span: PlaybackSpan | null, at: number, playingNow: boolean, nowMs: number) => {
      const el = overlayVideo.current;
      if (el === null) return;
      const src = overlayVideoSrcFor(span);
      syncMediaElement(el, { src, targetSec: span ? mediaTimeFor(span, at) : 0, playing: playingNow, nowMs });
      el.style.opacity = src === null ? "0" : "1";
    },
    [slug],
  );

  /*
   * The still is painted off the frame clock too, for the reason the video already is.
   *
   * `time` reaches React four times a second; the video source is switched every frame from
   * `timeRef`. Selecting the still from the throttled value would leave the old plate covering a
   * video that had already started, or the old video showing under a plate that had already
   * begun — a quarter second of the wrong picture at every boundary between the two, which is
   * exactly the mistake the video loop exists to avoid.
   */
  const stillEl = useRef<HTMLImageElement>(null);
  const paintStill = useCallback((span: PlaybackSpan | null) => {
    const img = stillEl.current;
    const el = video.current;
    const src = span?.still && slug && span.path ? mediaUrl(slug, span.path) : null;
    if (img !== null) {
      // Assigning an identical src would restart the decode every frame.
      if (src !== null && img.getAttribute("src") !== src) img.setAttribute("src", src);
      img.style.opacity = src === null ? "0" : "1";
    }
    if (el !== null) el.style.opacity = videoSrcFor(span) === null ? "0" : "1";
  }, [slug]);

  /*
   * The sync runs on its own frame loop off `timeRef`, not off `time`.
   *
   * The transport reports to React four times a second, which is right for the clock and wrong
   * for the picture: a shot boundary could be up to 250ms late, which is a quarter second of the
   * previous shot playing under the next one's label. The ref is current every frame.
   */
  useEffect(() => {
    const el = video.current;
    if (el === null || !playing) return;
    let frame = 0;
    onMediaReady(el, () => {});
    const loop = (ts: number) => {
      const at = timeRef.current;
      const span = spanAt(spans, at);
      syncMediaElement(el, {
        src: videoSrcFor(span),
        targetSec: span ? videoTimeFor(span, at) : 0,
        playing: true,
        nowMs: ts,
      });
      paintStill(span);
      syncOverlayVideo(span, at, true, ts);
      syncCue(at);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [playing, spans, slug, paintStill, syncCue, syncOverlayVideo]);

  // Paused: one sync, so a seek lands on the right frame without a loop running. A source that
  // was not ready when it was asked calls back through onMediaReady, since nothing else will.
  useEffect(() => {
    const el = video.current;
    if (el === null || playing) return;
    const push = () => {
      const at = timeRef.current;
      const span = spanAt(spans, at);
      syncMediaElement(el, {
        src: videoSrcFor(span),
        targetSec: span ? videoTimeFor(span, at) : 0,
        playing: false,
        nowMs: 0,
      });
      paintStill(span);
      syncOverlayVideo(span, at, false, 0);
      syncCue(at);
    };
    onMediaReady(el, push);
    if (overlayVideo.current !== null) onMediaReady(overlayVideo.current, push);
    push();
  }, [playing, time, spans, slug, timeRef, paintStill, syncCue, syncOverlayVideo]);

  const current = spanAt(spans, time);
  /*
   * A film can run on sound alone (issue 453). Its length counts placed sound, so an audio-only
   * production has a real runtime and no picture at any second of it — and "nothing here yet" is
   * then simply false, said to somebody who has placed something and can see it on a lane.
   */
  const soundOnly = soundSec > 0 && spans.length === 0;
  const showingVideo = videoSrcFor(current);
  const showingStill = stillSrcFor(current);
  const showing = showingVideo ?? showingStill;

  return (
    <div className="fy-cutviewer">
      <video
        ref={video}
        className="fy-cutviewer__video"
        playsInline
        muted
        style={{ opacity: showingVideo === null ? 0 : 1 }}
      />
      {/* A video overlay over the base: its own element, synced on the same frame clock (round nine). */}
      <video
        ref={overlayVideo}
        className="fy-cutviewer__video"
        playsInline
        muted
        style={{ opacity: overlayVideoSrcFor(current) === null ? 0 : 1 }}
      />
      {/*
        * Always mounted, never conditional: `paintStill` reaches it through the ref on the frame
        * clock, and an element that came and went with a throttled render could not be painted at
        * the moment the picture actually changes.
        */}
      <img
        ref={stillEl}
        className="fy-cutviewer__video"
        alt=""
        style={{ opacity: showingStill === null ? 0 : 1 }}
        {...(showingStill !== null ? { src: showingStill } : {})}
      />
      {showing === null && (
        <span className="fy-cutviewer__empty">
          {current ? current.label : soundOnly ? "sound only" : "nothing here yet"}
        </span>
      )}
      {liveCue !== null && (
        <span
          className={cx("fy-cutviewer__cue", cueStyle?.background === "box" && "fy-cutviewer__cue--box")}
          data-cue={liveCue.id}
          aria-live="off"
          // The saved style, every field of it, so the preview and the burn-in agree (round
          // three): colour, a size and margin relative to the picture, and the decoration.
          style={
            cueStyle === null
              ? undefined
              : {
                  color: cueStyle.color,
                  fontSize: `${(cueStyle.relativeSize * 100).toFixed(2)}cqh`,
                  bottom: `${(cueStyle.bottomMargin * 100).toFixed(2)}%`,
                  textShadow: cueStyle.background === "outline" ? "0 0 3px var(--neutral-950), 0 0 6px var(--neutral-950)" : "none",
                }
          }
        >
          {liveCue.text}
        </span>
      )}
      <button
        type="button"
        className="fy-playbtn"
        aria-label={playing ? "Pause" : "Play"}
        onClick={() => {
          if (!playing && timeRef.current >= totalSec) seek(0);
          setPlaying((p) => !p);
        }}
      >
        {playing ? <PauseSolid size={22} /> : <Play size={22} />}
      </button>
      <span className="fy-viewer__tag">
        {clock(time)} / {clock(totalSec)}
        {current ? ` · ${current.label}` : ""}
      </span>
    </div>
  );
}

/**
 * The one authored edit, shared by both clocks (80a, 81a).
 *
 * What differs between them is the figures — the song fixes a window and the story authors a
 * slot — so those arrive as text and everything else is identical, which is what "switching
 * between a short film and a music video must not move a single row" means in practice.
 */
function TrimStrip({
  worldId,
  prodId,
  shotId,
  heading,
  title,
  figures,
  trim,
  ceiling,
}: {
  worldId: string;
  prodId: string;
  shotId: string;
  heading: string;
  title: string;
  figures: string;
  trim: number;
  ceiling: ReturnType<typeof trimCeilingSec> | null;
}) {
  // Something must survive the trim, so the last whole step before the ceiling is the ceiling here.
  const maxTrim =
    ceiling?.ok && ceiling.ceilingSec !== undefined
      ? Math.max(0, ceiling.ceilingSec - TRIM_STEP_SEC)
      : undefined;
  const trimmable = ceiling?.ok === true;
  const commit = (next: number) => {
    if (next !== trim) setShotTrim(worldId, prodId, shotId, next);
  };
  const stepTrim = (delta: number) => {
    const wanted = Math.round((trim + delta) * 1000) / 1000;
    commit(Math.max(0, maxTrim === undefined ? wanted : Math.min(wanted, maxTrim)));
  };
  /*
   * Dragging the figure is the gesture; the steppers stay for precision and for a keyboard.
   * `pixelsPerSecond` is deliberately coarse -- the strip is not a timeline, so a drag across it
   * is worth a few seconds rather than the whole cut.
   */
  const drag = useScrubDrag({
    value: trim,
    pixelsPerSecond: 40,
    min: 0,
    ...(maxTrim !== undefined ? { max: maxTrim } : {}),
    onCommit: commit,
  });
  return (
    <div className="fy-cutsel">
      <span className="fy-mono">{heading}</span>
      <span className="fy-cutsel__label">{title}</span>
      <span className="fy-h1row__push" />
      <span className="fy-mono">{figures}</span>
      <span className="fy-trim">
        <span className="fy-trim__label">TRIM IN</span>
        <button
          type="button"
          className="fy-trim__step"
          disabled={!trimmable || trim <= 0}
          aria-label="less trim"
          onClick={() => stepTrim(-TRIM_STEP_SEC)}
        >
          −
        </button>
        <span
          className={cx(
            "fy-trim__value",
            trimmable && "fy-trim__value--drag",
            drag.dragging && "fy-trim__value--dragging",
          )}
          onPointerDown={trimmable ? drag.onPointerDown : undefined}
          role={trimmable ? "slider" : undefined}
          aria-label={trimmable ? "trim in" : undefined}
          aria-valuenow={drag.display}
          aria-valuemin={0}
          {...(maxTrim !== undefined ? { "aria-valuemax": maxTrim } : {})}
        >
          {drag.display.toFixed(1)}s
        </span>
        <button
          type="button"
          className="fy-trim__step"
          disabled={!trimmable || (maxTrim !== undefined && trim >= maxTrim)}
          aria-label="more trim"
          onClick={() => stepTrim(TRIM_STEP_SEC)}
        >
          +
        </button>
      </span>
    </div>
  );
}

/**
 * The Cut on the song clock (80a): the track is the ruler, so the lane is the derived spine cut
 * laid out by position rather than the scene order — clips where an anchor is covered, slates
 * where a shot is anchored but has nothing to show, and black for the time no anchor claims.
 *
 * The one authored edit lives here: trim, on the selected clip, writing the selection (R-8).
 */
function SpineCutTrack({
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

type CutSelection = { kind: "picture"; id: string } | { kind: "overlay"; id: string } | { kind: "cue"; id: string };

/**
 * A lane that is not on the record yet (SPEC-039 R-13): the target keeps all five in view, and a
 * drop on one adds the track and places in one batch. Sound lanes take sound, picture takes
 * picture; the refusal shows while the drag is over the lane.
 */
function EmptyEditorTrack({
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

/** The target's strip under the last lane: a drop here makes a new lane of the item's own kind. */
function NewLaneStrip({ onDrop }: { onDrop: ((artifactId: string, laneWidth: number, x: number) => void) | null }) {
  const [over, setOver] = useState(false);
  return (
    <div className={cx("fy-track fy-track--new", over && "fy-track--over")} data-track="new">
      <span className="fy-track__label">
        <span className="fy-track__name">+ lane</span>
      </span>
      <div
        className="fy-track__lane"
        onDragOver={(event) => {
          if (onDrop === null || !Array.from(event.dataTransfer.types).includes(ARTIFACT_DRAG_TYPE)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          if (onDrop === null) return;
          event.preventDefault();
          setOver(false);
          const artifactId = event.dataTransfer.getData(ARTIFACT_DRAG_TYPE);
          if (!artifactId) return;
          const box = event.currentTarget.getBoundingClientRect();
          onDrop(artifactId, box.width, event.clientX - box.left);
        }}
      >
        <span className="fy-track__empty">{onDrop === null ? "" : "drop here for a new lane"}</span>
      </div>
    </div>
  );
}

function InspectorRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fy-cutinspect__row">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

/** Scene bands over the Picture track: one band per run of clips from the same scene. */
function SceneBands({ views, totalFrames }: { views: readonly PictureClipView[]; totalFrames: number }) {
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

function CutInspector({
  worldId,
  prodId,
  production,
  cut,
  spineCut,
  artifacts,
  selection,
  selectedClip,
  selectedTrack,
  filmSec,
  clipCount,
  savedPictureOrder,
  frameRate,
  commandsDisabled,
  onCommands,
  timeline,
  subtitleView,
  onViewSubtitles,
  onTranscribe,
  onOpenExport,
  onFill,
  mintClipId,
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
  filmSec: number;
  clipCount: number;
  savedPictureOrder: boolean;
  frameRate: FrameRate;
  commandsDisabled: boolean;
  onCommands: (commands: TimelineCommand[], label?: string) => void;
  timeline: ProductionTimeline | null;
  subtitleView: TimelineTrackId | null;
  onViewSubtitles: (trackId: TimelineTrackId | null) => void;
  onTranscribe: ((trackId: TimelineTrackId, language: string) => void) | null;
  /** The export sheet (R-24): the cut view's preset row opens it. */
  onOpenExport: () => void;
  /** A gap in the `Needs a decision` list selects its clip, where the takes are chosen (R-22). */
  onFill: (clipId: TimelineClipId) => void;
  mintClipId: () => TimelineClipId;
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
        <h2>{label}</h2>
        <div className="fy-cutinspect__rows">
          <InspectorRow label="Track">{selectedTrack.name}</InspectorRow>
          <InspectorRow label="Source">{artifact?.file ?? (selectedClip.source.kind === "take" ? selectedClip.source.takeId : label)}</InspectorRow>
          {selectedClip.source.kind === "take" && selectedClip.source.sheetId !== undefined && (
            <InspectorRow label="Voice">{selectedClip.source.sheetId}{selectedClip.source.voiceAssignedAtVersion !== undefined ? ` · sheet v${selectedClip.source.voiceAssignedAtVersion}` : ""}</InspectorRow>
          )}
        </div>
        <PictureClipTiming clip={selectedClip} frameRate={frameRate} disabled={commandsDisabled} onCommands={onCommands} />
        {AUDIO_TRACK_KINDS.has(selectedTrack.kind) && <ClipGain clip={selectedClip} disabled={commandsDisabled} onCommands={onCommands} />}
        {AUDIO_TRACK_KINDS.has(selectedTrack.kind) && timeline !== null && (
          <MoveToLane clip={selectedClip} track={selectedTrack} timeline={timeline} disabled={commandsDisabled} onCommands={onCommands} mintClipId={mintClipId} />
        )}
        <p className="fy-cutinspect__note">
          {selectedTrack.kind === "dialogue"
            ? "Dialogue is foreground: Music and Ambience lower under it while speech-first mixing is on."
            : "Background sound lowers under Dialogue while speech-first mixing is on. Mute and Solo live on the track row."}
        </p>
      </div>
    );
  }

  if (selectedClip && selectedTrack && selectedTrack.kind === "picture" && selectedClip.source.kind === "artifact" && production) {
    const artifact = artifacts.find((candidate) => candidate.id === (selectedClip.source.kind === "artifact" ? selectedClip.source.artifactId : "")) ?? null;
    return (
      <div className="fy-cutinspect">
        <div className="fy-cutinspect__eyebrow">PLACED PICTURE</div>
        <h2>{selectedClip.source.label}</h2>
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
        <PictureClipTiming clip={selectedClip} frameRate={frameRate} disabled={commandsDisabled} onCommands={onCommands} />
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
        : (selectedStory?.durationSec ?? 0);
    return (
      <div className="fy-cutinspect">
        <div className="fy-cutinspect__eyebrow">PICTURE CLIP</div>
        <h2>{title}</h2>
        <div className="fy-cutinspect__rows">
          {sceneNumber > 0 && <InspectorRow label="Scene">SC {sceneNumber}</InspectorRow>}
          {selectedShotId && <InspectorRow label="Shot">{selectedShotId.replace("sh_", "shot ")}</InspectorRow>}
          <InspectorRow label="Take">{selectedTakeId ?? "no accepted take"}</InspectorRow>
          <InspectorRow label={selectedSpine ? "Window" : "Shot length"}>{duration.toFixed(1)}s</InspectorRow>
          {takeSec !== undefined && <InspectorRow label="Take length">{takeSec.toFixed(1)}s</InspectorRow>}
        </div>
        {selectedClip && (
          <PictureClipTiming clip={selectedClip} frameRate={frameRate} disabled={commandsDisabled} onCommands={onCommands} />
        )}
        {selectedShotId && !savedPictureOrder && (
          <TrimStrip
            worldId={worldId}
            prodId={prodId}
            shotId={selectedShotId}
            heading={`SC ${sceneNumber} · ${selectedShotId.replace("sh_", "shot ")}`}
            title={title}
            figures={`${selectedTakeId ?? "no take"} · ${selectedSpine ? "budget" : "shot"} ${duration.toFixed(1)}s${takeSec !== undefined && !selectedSpine ? ` · take ${takeSec.toFixed(1)}s` : ""}`}
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
      <div className="fy-cutinspect__rows">
        <InspectorRow label="Duration">{runtimeSeconds(filmSec)}</InspectorRow>
        <InspectorRow label="Clips">{clipCount}</InspectorRow>
        <InspectorRow label="Lanes">{timeline === null ? "—" : `${timeline.tracks.length}`}</InspectorRow>
        <InspectorRow label="Aspect">{production ? `${productionAspect(production.meta)} · ${productionFrameRate(production.meta)} fps` : "not loaded"}</InspectorRow>
        <InspectorRow label="Source">
          {spineCut ? "accepted takes · master track" : cut && isMediaOnly(cut) && (production?.scenes.length ?? 0) === 0 ? "placed clips" : "accepted takes"}
        </InspectorRow>
        <InspectorRow label="Coverage">{cut ? `${cut.covered} of ${cut.entries.filter((entry) => (entry as ResolvedPictureEntry).hole !== true).length} shots` : "not loaded"}</InspectorRow>
      </div>
      {cut !== null && spineCut === null && (() => {
        // The target's `Needs a decision`: every shot on the timeline that still plays as a gap.
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
      <div className="fy-cutinspect__rows">
        <div className="fy-cutinspect__row">
          <span>Export preset</span>
          <strong>
            Review cut{" "}
            <button type="button" className="fy-takepick__use" onClick={onOpenExport}>
              Change
            </button>
          </strong>
        </div>
      </div>
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

/** True when a key press belongs to a text field rather than the editor (SPEC-039 R-17). */
/** A focused button or link owns Space (round five): its native activation, not the transport. */
function interactiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest("button, a[href], [role='button'], summary") !== null;
}

function typingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

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
function ExportSheet({
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
  const [preset, setPreset] = useState<keyof typeof PRESETS>("review-cut");
  const [subtitleTrack, setSubtitleTrack] = useState<string>("");
  const [subtitleMode, setSubtitleMode] = useState<"none" | "burn-in" | "sidecar" | "burn-in+sidecar">("none");
  const [sidecarFormat, setSidecarFormat] = useState<"srt" | "vtt">("srt");
  if (!open) return null;
  const ready = timelineState.status === "ready";
  let cut: ReturnType<typeof resolvePictureTimeline> | null = null;
  let blockedBy: string | null = null;
  const nothingOnTimeline = "Nothing on the timeline yet. Add to the Library and place, or ask Arke.";
  if (production === null) blockedBy = "No production here.";
  else if (timelineState.status === "invalid") blockedBy = `Timeline unavailable · ${timelineState.message}`;
  else if (!ready) blockedBy = production.spine !== null ? "Open the song on the timeline first." : nothingOnTimeline;
  else {
    try {
      cut = resolvePictureTimeline(production, timelineState);
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
  if (nothingPlaced && blockedBy === null) blockedBy = nothingOnTimeline;
  const runtimeSec = plan?.ok === true ? plan.plan.totalSec : null;
  const gaps = cut?.gaps ?? 0;
  const covered = cut === null ? 0 : cut.covered;
  const shotCount = cut === null ? 0 : cut.entries.length;
  const subtitleTracks = ready ? subtitleTracksOf(timelineState.timeline) : [];
  const chosenSubtitleTrack = subtitleTracks.find((track) => track.id === subtitleTrack) ?? subtitleTracks[0] ?? null;
  const subtitleChoice =
    chosenSubtitleTrack !== null && subtitleMode !== "none" ? { trackId: chosenSubtitleTrack.id, mode: subtitleMode, sidecar: sidecarFormat } : undefined;
  const speechFirst = ready ? timelineState.timeline.mix.speechFirst : true;
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
    ["social-excerpt", `${PRESETS["social-excerpt"].width} × ${PRESETS["social-excerpt"].height} · vertical`],
  ];
  const meta =
    cut === null || nothingPlaced
      ? blockedBy ?? ""
      : `${seconds(runtimeSec ?? cut.totalSec)} · ${covered} of ${shotCount} shot${shotCount === 1 ? "" : "s"}${gaps > 0 ? ` · ${gaps} gap${gaps === 1 ? "" : "s"}` : ""}`;
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
            {chip(speechFirst, "Stereo · ducked", () => onMix(true), !ready || commandsDisabled)}
            {chip(!speechFirst, "Stereo · flat", () => onMix(false), !ready || commandsDisabled)}
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
              const refused = range === null ? null : range.ok ? null : range.reason;
              return (
                <div key={episode.id} className="fy-exsheet__episode">
                  <span className="fy-mono">{String(episode.order).padStart(2, "0")}</span>
                  <span className="fy-exsheet__eptitle">{episode.release?.title ?? episode.title}</span>
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

/** The newest Undo entry that is one of Arke's assemblies (R-46): its label names the scene, its notes say what it did. */
function assemblyEntry(timeline: ProductionTimeline): { entry: TimelineChangeHistoryEntry; index: number } | null {
  // The newest assembly still on the undo stack, however many edits followed it: the banner
  // stays until it is hidden or the assembly itself is undone.
  for (let index = timeline.history.undo.length - 1; index >= 0; index -= 1) {
    const entry = timeline.history.undo[index]!;
    if (entry.kind === "change" && entry.label.startsWith("Arke assembled ") && entry.notes !== undefined) return { entry, index };
  }
  return null;
}

function AddToLibraryDialog({
  open,
  production,
  artifacts,
  library,
  onClose,
  onAdd,
}: {
  open: boolean;
  production: ProductionBundle | null;
  artifacts: ArtifactSidecar[];
  library: readonly TimelineLibraryItem[];
  onClose: () => void;
  onAdd: (added: TimelineLibraryItem[], removed: TimelineLibraryItem[]) => void;
}) {
  const [sceneId, setSceneId] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  /** Items already in the Library that were unchecked: the picker removes as well as adds. */
  const [dropped, setDropped] = useState<Set<string>>(() => new Set());
  const present = new Set(library.map(libraryItemKey));
  const dismiss = () => {
    setChosen(new Set());
    setDropped(new Set());
    onClose();
  };
  const scenes = production?.scenes ?? [];
  const scene = scenes.find((candidate) => candidate.id === sceneId) ?? scenes[0] ?? null;
  const shots = scene ? orderedShots(scene) : [];
  const placeable = pickableArtifacts(artifacts).filter((artifact) => artifact.kind === "audio" || artifact.kind === "video" || artifact.kind === "image" || artifact.kind === "board");
  const toggle = (key: string) =>
    (present.has(key) ? setDropped : setChosen)((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleScene = (target: ProductionBundle["scenes"][number]) => {
    const keys = orderedShots(target).map((shot) => `shot:${shot.id}`).filter((key) => !present.has(key));
    setChosen((current) => {
      const next = new Set(current);
      const all = keys.every((key) => next.has(key));
      for (const key of keys) {
        if (all) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  };
  const asItem = (key: string): TimelineLibraryItem =>
    key.startsWith("shot:") ? { kind: "shot", shotId: key.slice(5) } : { kind: "artifact", artifactId: key.slice(9) };
  const confirm = () => {
    if (chosen.size === 0 && dropped.size === 0) return;
    onAdd([...chosen].map(asItem), [...dropped].map(asItem));
    setChosen(new Set());
    setDropped(new Set());
  };
  const row = (key: string, name: string, meta: string, tone: "muted" | "destructive" = "muted") => {
    const already = present.has(key);
    const checked = already ? !dropped.has(key) : chosen.has(key);
    return (
      <label key={key} className={cx("fy-libpick__row", already && "fy-libpick__row--in")}>
        <input type="checkbox" checked={checked} onChange={() => toggle(key)} />
        <span className="fy-libpick__name">{name}</span>
        <span className={cx("fy-mono fy-libpick__meta", tone === "destructive" && "fy-libpick__meta--destructive")}>
          {already ? (dropped.has(key) ? "leaves the library" : "in the library") : meta}
        </span>
      </label>
    );
  };
  return (
    <EditorDialog open={open} title="Add to the library" subtitle="Takes, uploads and lines to cut with" onClose={dismiss} width={880} labelledBy="add-to-library-title">
      <div className="fy-libpick">
        <div className="fy-libpick__col">
          <div className="fy-libpick__colhead">Scenes</div>
          <div className="fy-libpick__list" role="list">
            {scenes.length === 0 ? (
              <div className="fy-libpick__empty">No scenes yet.</div>
            ) : (
              scenes.map((candidate) => {
                const keys = orderedShots(candidate).map((shot) => `shot:${shot.id}`);
                const count = keys.filter((key) => chosen.has(key) || present.has(key)).length;
                return (
                  <div key={candidate.id} className={cx("fy-libpick__scene", candidate.id === scene?.id && "fy-libpick__scene--current")} role="listitem">
                    <button type="button" className="fy-libpick__scenepick" aria-pressed={candidate.id === scene?.id} onClick={() => setSceneId(candidate.id)}>
                      <span className="fy-libpick__name">SC {candidate.number} · {candidate.title}</span>
                      <span className="fy-mono fy-libpick__meta">{count}/{keys.length}</span>
                    </button>
                    <button type="button" className="fy-libpick__all" onClick={() => toggleScene(candidate)} aria-label={`Every shot of scene ${candidate.number}`}>
                      all
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
        <div className="fy-libpick__col">
          <div className="fy-libpick__colhead">{scene ? `Shots · SC ${scene.number}` : "Shots"}</div>
          <div className="fy-libpick__list">
            {shots.length === 0 ? (
              <div className="fy-libpick__empty">This scene has no shots.</div>
            ) : (
              shots.map((shot) => {
                const takeId = production ? acceptedTakeId(production, shot.id) : null;
                return row(`shot:${shot.id}`, `SH ${shot.number} · ${shot.title}`, takeId === null ? "no accepted take" : takeId, takeId === null ? "destructive" : "muted");
              })
            )}
          </div>
        </div>
        <div className="fy-libpick__col">
          <div className="fy-libpick__colhead">Artifacts</div>
          <div className="fy-libpick__list">
            {placeable.length === 0 ? (
              <div className="fy-libpick__empty">Nothing filed that can be placed. Upload from the Library.</div>
            ) : (
              placeable.map((artifact) => row(`artifact:${artifact.id}`, artifact.file.split("/").pop() ?? artifact.file, artifact.kind))
            )}
          </div>
        </div>
      </div>
      <div className="fy-libpick__foot">
        <span className="fy-mono">
          {chosen.size} selected{dropped.size > 0 ? ` · ${dropped.size} leaving` : ""}
        </span>
        <span className="fy-h1row__push" />
        <button type="button" className="fy-libpick__cancel" onClick={dismiss}>
          Cancel
        </button>
        <button type="button" className="fy-libpick__confirm" data-primary="true" disabled={chosen.size === 0 && dropped.size === 0} onClick={confirm}>
          {chosen.size === 0 && dropped.size > 0 ? "Update the library" : "Add to the library"}
        </button>
      </div>
    </EditorDialog>
  );
}

export function CutScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const timelineState = production?.timeline ?? { status: "absent" as const };
  const frameRate: FrameRate = production ? productionFrameRate(production.meta) : 24;
  let cut: ResolvedPictureCut | null = null;
  let timelineError: string | null = null;
  if (production) {
    try {
      // The song clock derives its picture until its timeline is saved (SPEC-037 §2.3); from then
      // on it reads the saved order like every other production, with the master as a Music clip.
      if (timelineState.status === "invalid") throw new Error(timelineState.message);
      cut =
        production.spine && timelineState.status !== "ready"
          ? deriveCut(production)
          : timelineState.status === "absent"
            ? resolvePictureTimeline(production, { status: "ready", timeline: seedFirstPictureTimeline(production) })
            : resolvePictureTimeline(production, timelineState);
    } catch (error) {
      timelineError = error instanceof Error ? error.message : String(error);
    }
  }
  // One Cut, two clocks (80a): the story orders the picture until a spine exists, and then the
  // song does — until the saved timeline owns both. Exports already chose this way; a Cut tab
  // that did not would state a different film from the screen next to it.
  const view = exportViewFor(world, production);
  const spineCut = timelineError === null && view.kind === "spine" && timelineState.status !== "ready" ? view.cut : null;
  /** The measured master, which is what a music-timed first assembly is cut against. */
  const masterDurationSec = view.kind === "spine" ? view.cut.trackDurationSec : view.kind === "silent" ? view.durationSec : null;
  const slug = world?.meta.slug;
  const [watchToken, setWatchToken] = useState(0);
  const [selected, setSelected] = useState<CutSelection | null>(null);
  const [rightTab, setRightTab] = useState<"inspector" | "arke">("inspector");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [tool, setTool] = useState<EditorTool>("select");
  const [snap, setSnap] = useState(true);
  /** Timeline zoom (R-19c): a view scale on the canvas, 1× to 4× in halves; never written. */
  const [zoom, setZoom] = useState(1);
  const [keysOpen, setKeysOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  /** The scene the workspace's Generate handed off (R-44): assembled once as the editor opens. */
  const assembleSceneId = searchParams.get("assemble");
  const assembled = useRef<string | null>(null);
  /** A clip just placed: selected once the snapshot carries it, forgotten if the write is refused. */
  const pendingSelect = useRef<TimelineClipId | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** The Exports route lands here with the sheet up (R-1, T-5); the query is spent on arrival. */
  const [exportOpen, setExportOpen] = useState(() => searchParams.get("export") !== null);
  const [noticeHidden, setNoticeHidden] = useState<string | null>(null);
  const [didOpen, setDidOpen] = useState(false);  /** The Audio route lands here with the Library on its audio (R-1); nothing else reads the query. */
  const libraryFilter: LibraryFilter = searchParams.get("library") === "audio" ? "audio" : "all";
  // The Audio address lands with the Library up (R-1): below 1200px it is a drawer that would otherwise stay shut.
  useEffect(() => {
    if (libraryFilter === "audio") setLibraryOpen(true);
    // Once, on arrival: the drawer is the person's to close afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [draft, setDraft] = useState<ProductionTimeline | null>(null);
  /** Which of Arke's pending requests is drawn as a ghost (SPEC-039 R-33); local view state. */
  const [ghostRequestId, setGhostRequestId] = useState<string | null>(null);
  /**
   * Which language is viewed (SPEC-038 R-26): local view state. Unchosen shows the first track;
   * null is a choice too — none — and stays none rather than falling back to the first track
   * (round three).
   */
  const [subtitleChoice, setSubtitleChoice] = useState<TimelineTrackId | null | undefined>(undefined);
  const subtitleTracks = timelineState.status === "ready" ? subtitleTracksOf(timelineState.timeline) : [];
  const subtitleView: TimelineTrackId | null =
    subtitleChoice === null
      ? null
      : subtitleChoice !== undefined && subtitleTracks.some((track) => track.id === subtitleChoice)
        ? subtitleChoice
        : (subtitleTracks[0]?.id ?? null);
  const libraryToggleRef = useRef<HTMLButtonElement>(null);
  const libraryPanelRef = useRef<HTMLElement>(null);
  const rightToggleRef = useRef<HTMLButtonElement>(null);
  const rightPanelRef = useRef<HTMLElement>(null);
  const [timelineCommandError, setTimelineCommandError] = useState<string | null>(null);
  /*
   * One command in flight at a time (SPEC-037 R-18). Every command carries the revision it was
   * rendered against, so two quick presses would both name the same revision and the second
   * would be refused as stale: the edit a person made twice would land once, silently. The gate
   * lifts when the snapshot's revision moves, when a refusal arrives, or after a bounded wait in
   * case neither ever does.
   */
  const [inFlight, setInFlight] = useState<{ revision: number | null; since: number; patient?: boolean } | null>(null);
  useEffect(
    () => {
      setTimelineCommandError(null);
      setInFlight(null);
      return subscribeTimelineRefusals((event) => {
        if (event.worldId === worldId && event.productionId === prodId) {
          setTimelineCommandError(event.reason);
          setInFlight(null);
        }
      });
    },
    [worldId, prodId],
  );
  useEffect(() => {
    if (!libraryOpen && !rightOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector(".fy-clipmenu")) return;
      if (libraryOpen && editorMediaMatches("(max-width: 1199px)")) {
        setLibraryOpen(false);
        queueMicrotask(() => libraryToggleRef.current?.focus());
      } else if (rightOpen && editorMediaMatches("(max-width: 899px)")) {
        setRightOpen(false);
        queueMicrotask(() => rightToggleRef.current?.focus());
      } else {
        return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [libraryOpen, rightOpen]);
  const overlays = production?.cut.overlays ?? [];
  /*
   * A production with no story is the clips (issue 453), so they are the clock.
   *
   * Gated on the same `scene-order` the Exports screen uses, not merely on `spineCut` being null.
   * A spine whose track is missing, unmeasured or silent yields no spine cut either, and calling
   * that media-only would tell one screen the clips are the film while Exports still treats the
   * song as authoritative — and a track that later measured would yank the canvas out from under
   * somebody mid-edit. A production with a spine is never this, however unresolved that spine is.
   */
  const mediaOnly =
    cut !== null && view.kind === "scene-order" && isMediaOnly(cut) && (production?.scenes ?? []).every((scene) => orderedShots(scene).length === 0);
  /*
   * Resolved exactly as the coordinator resolves them, because the screen must not advertise a
   * film the export will not produce: `exportOverlays` drops a document or a missing artifact and
   * `exportAudioClips` drops a video not known to carry sound, so measuring raw lane records
   * would let a document stretched to 60s claim a film that encodes as five seconds.
   */
  // The production's own view of the world's files (SPEC-020 R-13): another production's scoped media stays out of this Library and picker.
  const artifacts = artifactsFor(world?.artifacts ?? [], prodId);
  const placedPicture = mediaOnly ? exportOverlays(overlays, artifacts) : [];
  const placedSound = mediaOnly ? exportAudioClips(overlays, artifacts) : [];
  /*
   * Two lengths. The CANVAS is how much timeline to draw and must extend past the last clip or
   * there is nowhere to drop the next one; the FILM is how long the thing actually is. Trailing
   * editing headroom is not part of the film, so it is the film that plays and the film the
   * header states — presenting the canvas as the runtime would let "Watch from top" run on into
   * blank editor space the export never emits.
   */
  /*
   * The canvas is measured from the RAW placements, not the resolved ones.
   *
   * What the export can use decides how long the film is; what somebody dropped decides how much
   * timeline they need to reach it. A clip the export drops — a document, or a video not known to
   * carry sound — is still drawn on a lane, and sizing the canvas without it puts that clip past
   * 100% where it cannot be selected, moved or deleted. The case is not hypothetical: a cut
   * becomes media-only the moment its last shot is removed, and any placement inherited from the
   * old story timeline can sit well beyond the minimum canvas.
   */
  /*
   * One render plan for the preview and the export (SPEC-038 R-1, issue 680). The viewer asks
   * the plan what is visible; the coordinator hands the same plan to FFmpeg. A production the
   * plan refuses is a production the export refuses, so the refusal blocks the editor by name.
   */
  /*
   * The preview draws the record the editor edits (decided 2026-09-02): an unsaved story
   * production previews its empty first state, not the film the story would derive. A production
   * with no story and legacy placements keeps its legacy preview until the first write folds them.
   */
  const previewState: typeof timelineState =
    production && timelineState.status === "absent" && production.spine === null && !mediaOnly
      ? { status: "ready", timeline: seedFirstPictureTimeline(production) }
      : timelineState;
  const renderPlan =
    production && (!production.spine || timelineState.status === "ready") && timelineError === null
      ? buildRenderPlan({
          production,
          artifacts,
          timeline: previewState,
          scope: { kind: "production" },
          preset: "review-cut",
          // A hidden (muted) track is not asked for: the plan would refuse it and take the whole
          // preview with it (round nine). Hiding captions leaves the film.
          ...(subtitleView !== null && subtitleTracks.some((track) => track.id === subtitleView && !track.muted)
            ? { subtitles: { trackId: subtitleView, mode: "none" } }
            : {}),
        })
      : null;
  /*
   * A plan the projection refuses — a placed artifact the world no longer has, say — blocks the
   * preview and the export by name, and nothing else (SPEC-039 R-39, R-40): the editor stays
   * editable so the clip can be removed, and Undo still works. Only an invalid or unresolvable
   * timeline record blocks editing.
   */
  const renderError = renderPlan !== null && !renderPlan.ok ? renderPlan.reason : null;
  const planTotalSec = renderPlan?.ok ? renderPlan.plan.totalSec : null;
  const timelineOwnsFilm = previewState.status === "ready";
  const canvasSec = spineCut
    ? spineCut.trackDurationSec
    : mediaOnly && !timelineOwnsFilm
      ? mediaCanvasSec(overlays)
      : Math.max(cut?.totalSec ?? 0, planTotalSec ?? 0, mediaOnly ? (planTotalSec ?? 0) + MEDIA_CANVAS_HEADROOM_SEC : 0);
  // Once the timeline owns the film, the plan's length is the film's; the legacy lanes no
  // longer say anything about a placement that lives on a typed track.
  const filmSec = timelineOwnsFilm && planTotalSec !== null ? planTotalSec : mediaOnly ? placedExtentSec([...placedPicture, ...placedSound]) : (planTotalSec ?? canvasSec);
  /** Lane layout and scrubbing get the canvas; playback and the readout get the film. */
  const totalSec = canvasSec;
  const transport = useCutTransport(filmSec);
  // Where the cuts are, so a dragged clip lands on a boundary rather than near one — the snap the
  // LTX port has always offered and nothing had yet asked for.
  /*
   * What the preview shows: the plan's answer at every edge, on either clock. The song clock keeps
   * its own spans until its timeline is materialised (SPEC-037 §2.3).
   */
  const spans = spineCut ? spineSpans(spineCut) : renderPlan?.ok ? planSpans(renderPlan.plan) : [];
  /*
   * What a person placed, which a split does not add to: splitting files a second record over the
   * same file, and counting both would report two clips for one piece of media still drawn as one
   * run on the timeline. The sound half is the half that is not counted, because the picture is
   * the one they dropped.
   */
  const legacyClipCount = (production?.cut.overlays ?? []).filter((o) => (o.audio ?? "keep") !== "only").length;
  const snapPoints = snap
    ? snapPointsFor(
        spans.map((s) => s.startSec),
        totalSec,
      )
    : [];
  /*
   * The song clock keeps its own screen until it is opened on the timeline (SPEC-037 A-12):
   * a seeded assembly under controls that draw a different track would edit clips nobody can
   * see. Opening it is one explicit action below; from then on the saved record is the editor.
   */
  let editableTimeline: ProductionTimeline | null = null;
  if (production && timelineState.status !== "invalid") {
    try {
      editableTimeline =
        timelineState.status === "ready" ? timelineState.timeline : production.spine !== null ? null : seedFirstPictureTimeline(production);
    } catch (error) {
      timelineError = error instanceof Error ? error.message : String(error);
    }
  }
  /** The fence for the first materialising command; null while the song is unmeasured. */
  const sourceFingerprint = production ? timelineSourceFingerprint(production, masterDurationSec) : null;
  /*
   * A saved record is fenced by its revision alone; the fingerprint fences only the first
   * assembly (SPEC-037 R-24). A song whose master lost its measurement must still be editable
   * once it is on the timeline, so the fence falls back to the story's for a ready record —
   * the coordinator does not read it there (round six).
   */
  const fence = sourceFingerprint ?? (production && timelineState.status === "ready" ? storyTimelineFingerprint(production) : null);
  /** What the timeline holds when it is the editor, the legacy placements until then (round ten). */
  const clipCount = editableTimeline
    ? editableTimeline.tracks.reduce((count, track) => count + track.clips.length, 0) + (timelineState.status === "ready" && timelineState.timeline.migratedCut === true ? 0 : legacyClipCount)
    : legacyClipCount;
  const libraryItems: readonly TimelineLibraryItem[] = editableTimeline?.library ?? [];
  /*
   * A ghost (SPEC-039 R-33): a pending request's commands applied to the live base in memory
   * and drawn in its place while the card is previewed. Never saved, and gone the moment the
   * request is decided or the base moves under it.
   */
  const ghostRequest =
    ghostRequestId === null
      ? null
      : (production?.editorRequests.find((request) => request.id === ghostRequestId && request.status === "pending") ?? null);
  let ghostTimeline: ProductionTimeline | null = null;
  if (ghostRequest !== null && editableTimeline !== null && editorRequestStaleness(ghostRequest, timelineState, sourceFingerprint) === null) {
    const ghost = previewEditorRequest(editableTimeline, ghostRequest.commands);
    ghostTimeline = ghost.ok ? ghost.timeline : null;
  }
  const decideRequest = (requestId: string, decision: "accept" | "reject") => {
    if (!worldId || !prodId) return;
    setGhostRequestId(null);
    setTimelineCommandError(null);
    if (decision === "accept") setInFlight({ revision: timelineRevision, since: Date.now() });
    decideEditorRequest(worldId, prodId, requestId, decision);
  };
  const shownTimeline = draft ?? ghostTimeline ?? editableTimeline;
  const views = shownTimeline ? pictureClipViews(shownTimeline, cut) : [];
  const usedShotIds = new Set(
    editableTimeline
      ? editableTimeline.tracks.flatMap((track) => track.clips.flatMap((clip) => (clip.source.kind === "shot" ? [clip.source.shotId] : [])))
      : cut?.entries.map((entry) => entry.shot.id) ?? [],
  );
  const pictureTrack = editableTimeline ? basePictureTrack(editableTimeline) : null;
  const orderedPictureClips = pictureTrack ? orderedTrackClips(pictureTrack) : [];
  /** Once the timeline owns every placement, the legacy lanes have no writer and are not drawn. */
  const placementsOnTimeline = timelineState.status === "ready" && timelineState.timeline.migratedCut === true;
  const allClips = editableTimeline
    ? editableTimeline.tracks.flatMap((track) => track.clips.map((clip) => ({ clip, track })))
    : [];
  const drift = production && editableTimeline && timelineState.status === "ready" ? storyOrderDrift(production, editableTimeline) : null;
  const allCues = editableTimeline ? editableTimeline.tracks.flatMap((track) => (track.cues ?? []).map((cue) => ({ cue, track }))) : [];
  const selectedExists =
    selected?.kind === "picture"
      ? spineCut
        ? spineCut.segments.some((segment) => segment.kind === "clip" && segment.shotId === selected.id)
        : allClips.some(({ clip }) => clip.id === selected.id)
      : selected?.kind === "overlay"
        ? overlays.some((clip) => clip.id === selected.id)
        : selected?.kind === "cue"
          ? allCues.some(({ cue }) => cue.id === selected.id)
          : false;
  // Nothing is selected until someone selects (R-25a): the Inspector opens on the cut, and
  // Escape has something to clear only after a click. A selection that no longer exists reads as none.
  const activeSelection: CutSelection | null = selectedExists ? selected : null;
  const revealDetails = () => {
    setRightTab("inspector");
    setLibraryOpen(false);
    setRightOpen(true);
    if (
      editorMediaMatches("(max-width: 899px)") ||
      (libraryOpen && editorMediaMatches("(max-width: 1199px)"))
    ) {
      queueMicrotask(() => focusFirstControl(rightPanelRef.current));
    }
  };
  const selectPicture = (id: string) => {
    setSelected({ kind: "picture", id });
    revealDetails();
  };
  const selectCue = (id: string) => {
    setSelected({ kind: "cue", id });
    revealDetails();
  };
  const selectedCueId = activeSelection?.kind === "cue" ? activeSelection.id : null;
  const selectOverlay = (id: string) => {
    setSelected({ kind: "overlay", id });
    setRightTab("inspector");
    setLibraryOpen(false);
    setRightOpen(true);
    if (editorMediaMatches("(max-width: 899px)")) {
      queueMicrotask(() => focusFirstControl(rightPanelRef.current));
    }
  };
  // What the cut uses is what the timeline holds once it owns placements (round four): a clip
  // placed on a typed track is in the cut, whatever the legacy lanes say.
  const usedArtifactIds = new Set([
    ...(placementsOnTimeline ? [] : overlays.map((clip) => clip.artifactId)),
    ...(editableTimeline?.tracks.flatMap((track) => track.clips.flatMap((clip) => (clip.source.kind === "artifact" ? [clip.source.artifactId] : []))) ?? []),
  ]);
  const cutMeta = spineCut
    ? `${seconds(spineCut.trackDurationSec)} · ${seconds(spineCut.trackDurationSec - spineCut.blackSec)} of ${seconds(spineCut.trackDurationSec)} covered · cut to the track`
    : mediaOnly
      ? `${runtimeSeconds(filmSec)} · no story · what you place is the film`
      : cut
        ? `${seconds(cut.totalSec)} · ${cut.covered} of ${views.length || cut.entries.length} shots covered · ${production?.spine ? "cut to the track" : timelineState.status === "ready" ? "saved timeline" : "nothing saved yet"}`
        : "";
  const selectedPictureClip =
    activeSelection?.kind === "picture"
      ? (orderedPictureClips.find((clip) => clip.id === activeSelection.id) ?? null)
      : null;
  const selectedAny = activeSelection?.kind === "picture" ? (allClips.find(({ clip }) => clip.id === activeSelection.id) ?? null) : null;
  const selectedPictureIndex = selectedPictureClip
    ? orderedPictureClips.findIndex((clip) => clip.id === selectedPictureClip.id)
    : -1;
  const timelineRevision = timelineState.status === "ready" ? timelineState.timeline.revision : null;
  const timelineUndo = timelineState.status === "ready" ? timelineState.timeline.history.undo.length : 0;
  const timelineRedo = timelineState.status === "ready" ? timelineState.timeline.history.redo.length : 0;
  const commandPending = inFlight !== null && inFlight.revision === timelineRevision;
  useEffect(() => {
    if (inFlight === null) return;
    if (inFlight.revision !== timelineRevision) {
      setInFlight(null);
      return;
    }
    // A command answers in well under eight seconds or something is wrong. Speech drafting
    // transcribes every Dialogue clip in turn and is not wrong at a minute; releasing its gate
    // early let a second edit land under it and discard the whole draft (round eight).
    const timer = window.setTimeout(() => setInFlight((pending) => (pending === inFlight ? null : pending)), inFlight.patient ? 600_000 : 8000);
    return () => window.clearTimeout(timer);
  }, [inFlight, timelineRevision]);
  const commandsDisabled =
    timelineError !== null ||
    !worldId ||
    !prodId ||
    !production ||
    editableTimeline === null ||
    commandPending ||
    fence === null ||
    // A ghost is the request's timeline, not the live one; a gesture drawn against it would
    // land against the record and mean something else (round eight). Decide the card first.
    ghostTimeline !== null;
  const sourceLength = useMemo(
    () => (production ? sourceLengthFramesFor(production, artifacts) : () => undefined),
    [production, artifacts],
  );
  const sendPictureMove = (direction: "earlier" | "later") => {
    if (!worldId || !prodId || !production || !selectedPictureClip || commandPending || fence === null || ghostTimeline !== null) return;
    setTimelineCommandError(null);
    setInFlight({ revision: timelineRevision, since: Date.now() });
    moveTimelinePictureClip(worldId, prodId, selectedPictureClip.id, direction, timelineRevision, fence);
  };
  /** Every editor action reaches the coordinator through here: one batch, one revision, one Undo step. */
  const sendCommands = (commands: TimelineCommand[], label?: string) => {
    if (commandsDisabled || !worldId || !prodId || !production || fence === null) return;
    setTimelineCommandError(null);
    setInFlight({ revision: timelineRevision, since: Date.now() });
    sendTimelineCommands(worldId, prodId, commands, timelineRevision, fence, label);
  };
  const changeLibrary = (added: TimelineLibraryItem[], removed: TimelineLibraryItem[]) => {
    // One command holds at most 200 items (the schema's cap); a bigger choice is several in one batch.
    const chunks = <Kind extends "add-to-library" | "remove-from-library">(kind: Kind, items: TimelineLibraryItem[]) =>
      Array.from({ length: Math.ceil(items.length / 200) }, (_, index) => ({ kind, items: items.slice(index * 200, index * 200 + 200) }));
    sendCommands([...chunks("add-to-library", added), ...chunks("remove-from-library", removed)], added.length > 0 ? "Add to the library" : "Remove from the library");
  };
  useEffect(() => {
    if (searchParams.get("export") === null) return;
    setSearchParams(
      (params) => {
        params.delete("export");
        return params;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams]);
  useEffect(() => {
    if (assembleSceneId === null || !worldId || !prodId || !production || fence === null || timelineState.status === "invalid") return;
    const key = `${worldId}:${prodId}:${assembleSceneId}`;
    if (assembled.current === key) return;
    assembled.current = key;
    setTimelineCommandError(null);
    setInFlight({ revision: timelineRevision, since: Date.now() });
    sendTimelineAssemble(worldId, prodId, assembleSceneId, timelineState.status === "ready" ? timelineState.timeline.revision : null, fence);
    setSearchParams(
      (params) => {
        params.delete("assemble");
        return params;
      },
      { replace: true },
    );
  }, [assembleSceneId, worldId, prodId, production, fence, timelineState, timelineRevision, setSearchParams]);
  useEffect(() => {
    const id = pendingSelect.current;
    if (id === null) return;
    if (allClips.some(({ clip }) => clip.id === id)) {
      pendingSelect.current = null;
      selectPicture(id);
    } else if (!commandPending) {
      // The write was refused or answered without the clip: the old selection stands.
      pendingSelect.current = null;
    }
  });
  /** Materialise the song's anchors as the first assembly (SPEC-037 R-13): an empty batch, fenced by the spine. */
  const openOnTimeline = () => {
    if (!worldId || !prodId || spineCut === null || sourceFingerprint === null || commandPending || timelineState.status !== "absent") return;
    setTimelineCommandError(null);
    setInFlight({ revision: timelineRevision, since: Date.now() });
    sendTimelineCommands(worldId, prodId, [], null, sourceFingerprint, "Open the song on the timeline");
  };
  const sendHistory = (action: "undo" | "redo") => {
    if (commandPending) return;
    setTimelineCommandError(null);
    if (worldId && prodId && timelineRevision !== null) {
      setInFlight({ revision: timelineRevision, since: Date.now() });
      moveTimelineHistory(worldId, prodId, action, timelineRevision);
    }
  };
  const mintClipId = (): TimelineClipId => `cl_${ulid()}`;
  const playheadFrame = secondsToFrames(Math.max(0, Math.min(transport.time, totalSec)), frameRate);
  const canUndo = !commandsDisabled && timelineRevision !== null && timelineUndo > 0;
  const canRedo = !commandsDisabled && timelineRevision !== null && timelineRedo > 0;
  void inFlight?.since;
  // The monitor mix reads the same plan the export does (SPEC-038 R-13, R-17).
  const urlFor = useCallback((path: string) => (slug ? mediaUrl(slug, path) : null), [slug]);
  usePlanAudio({ plan: renderPlan?.ok ? renderPlan.plan : null, playing: transport.playing, timeRef: transport.timeRef, urlFor });
  const cuePlan = renderPlan?.ok ? renderPlan.plan : null;
  const cueAt = useMemo(() => (cuePlan === null ? null : (sec: number) => cueAtSec(cuePlan, sec)), [cuePlan]);
  const playheadInsideSelected =
    selectedAny !== null &&
    playheadFrame > selectedAny.clip.startFrame &&
    playheadFrame < selectedAny.clip.startFrame + selectedAny.clip.durationFrames;
  /** Placement from the Library (SPEC-039 R-9, R-10): one `place` command, never a host path. */
  const placeArtifact = (
    artifact: ArtifactSidecar,
    trackId: TimelineTrackId | null,
    frameWanted: number,
    options: { kind?: "picture" | "dialogue" | "ambience" | "music"; newTrack?: boolean } = {},
  ) => {
    if (!editableTimeline) return;
    let frame = frameWanted;
    const still = artifact.kind === "image" || artifact.kind === "board";
    // Refused here, in the words the coordinator would use, rather than written and then refused
    // by every render: a document has no picture and no sound, an image has no sound, and a
    // video is only sound when it is known to carry some (SPEC-037 R-22).
    const targetTrack = trackId === null ? null : (editableTimeline.tracks.find((candidate) => candidate.id === trackId) ?? null);
    const laneKind: "picture" | "dialogue" | "ambience" | "music" =
      targetTrack !== null && targetTrack.kind !== "subtitle" ? targetTrack.kind : (options.kind ?? (artifact.kind === "audio" ? "music" : "picture"));
    const audioTarget = targetTrack !== null ? AUDIO_TRACK_KINDS.has(targetTrack.kind) : AUDIO_TRACK_KINDS.has(laneKind);
    const carriesSound = artifact.kind === "audio" || (artifact.kind === "video" && artifact.mediaInfo?.hasAudio === true);
    const carriesPicture = still || artifact.kind === "video";
    if (targetTrack !== null && targetTrack.kind === "subtitle") {
      setTimelineCommandError(`${targetTrack.name} holds subtitles, not media`);
      return;
    }
    if (audioTarget && !carriesSound) {
      setTimelineCommandError(`${artifact.file.split("/").pop()} is not known to carry sound; it cannot go on ${targetTrack?.name ?? "an audio track"}`);
      return;
    }
    if (!audioTarget && !carriesPicture) {
      setTimelineCommandError(`${artifact.file.split("/").pop()} is ${artifact.kind} and has no picture to place`);
      return;
    }
    const measured = artifact.mediaInfo?.durationSec;
    const durationFrames = Math.max(1, secondsToFrames(still ? CLIP_DEFAULT_SEC : (measured ?? CLIP_DEFAULT_SEC), frameRate));
    const label = artifact.file.split("/").pop() ?? artifact.file;
    const wantsAudio = AUDIO_TRACK_KINDS.has(laneKind);
    /*
     * A non-drag placement lands on a same-kind track with room at the playhead, or on a new
     * one. The first matching track alone was refused for overlap while another sat empty
     * (round six). An explicit drop keeps its target, and the coordinator's overlap refusal.
     */
    const sameKind = (candidate: TimelineTrack) => candidate.kind === laneKind && candidate.id !== PICTURE_TRACK_ID;
    const roomAt = (candidate: TimelineTrack) =>
      !candidate.clips.some((clip) => clip.startFrame < frame + durationFrames && clip.startFrame + clip.durationFrames > frame);
    const track = options.newTrack
      ? null
      : trackId !== null
        ? (editableTimeline.tracks.find((candidate) => candidate.id === trackId) ?? null)
        : (editableTimeline.tracks.find((candidate) => sameKind(candidate) && roomAt(candidate)) ?? editableTimeline.tracks.find(sameKind) ?? null);
    const commands: TimelineCommand[] = [];
    const laneName = laneKind === "picture" ? "Inserts" : laneKind === "dialogue" ? "Dialogue" : laneKind === "ambience" ? "Ambience" : "Music";
    const stem: TimelineTrackId = `tr_${laneName.toLowerCase()}`;
    const taken = new Set(editableTimeline.tracks.map((candidate) => candidate.id));
    let fresh: TimelineTrackId = stem;
    for (let n = 2; taken.has(fresh); n += 1) fresh = `${stem}-${n}`;
    const target: TimelineTrackId = track?.id ?? fresh;
    if (track === null) {
      const alike = editableTimeline.tracks.filter(sameKind).length;
      commands.push({
        kind: "add-track",
        trackId: target,
        trackKind: laneKind,
        name: `${laneName}${alike > 0 ? ` ${alike + 1}` : ""}`,
      });
    } else {
      // The target's drop: snap to a neighbouring edge when close, then slide to the first span
      // that is actually free rather than refusing the overlap.
      const edges = track.clips.flatMap((clip) => [clip.startFrame, clip.startFrame + clip.durationFrames]);
      const snapWithin = Math.round(1.2 * frameRate);
      const nearest = edges.reduce<number | null>((best, edge) => (Math.abs(edge - frame) < snapWithin && (best === null || Math.abs(edge - frame) < Math.abs(best - frame)) ? edge : best), null);
      if (snap && nearest !== null) frame = nearest;
      for (const clip of orderedTrackClips(track)) {
        if (clip.startFrame < frame + durationFrames && clip.startFrame + clip.durationFrames > frame) frame = clip.startFrame + clip.durationFrames;
      }
    }
    const placedId = mintClipId();
    commands.push({
      kind: "place",
      trackId: target,
      clip: {
        id: placedId,
        startFrame: frame,
        durationFrames,
        sourceInFrames: 0,
        source: { kind: "artifact", artifactId: artifact.id, label },
        ...(wantsAudio || (track !== null && AUDIO_TRACK_KINDS.has(track.kind)) ? { gainDb: 0 } : {}),
        ...(artifact.kind === "video" && !(track !== null && AUDIO_TRACK_KINDS.has(track.kind)) ? { audio: "keep" as const } : {}),
      },
    });
    sendCommands(commands, `Place ${label}`);
    // The placed clip becomes the selection and the Inspector's subject once it exists (round four).
    pendingSelect.current = placedId;
  };
  const placeVoiceTake = (take: Take, shot: Shot, sceneNumber: number) => {
    if (!editableTimeline || !production) return;
    const dialogue = [...editableTimeline.tracks].sort((a, b) => a.order - b.order).find((track) => track.kind === "dialogue") ?? null;
    const commands: TimelineCommand[] = [];
    const taken = new Set(editableTimeline.tracks.map((track) => track.id));
    let fresh: TimelineTrackId = "tr_dialogue";
    for (let n = 2; taken.has(fresh); n += 1) fresh = `tr_dialogue-${n}`;
    if (dialogue === null) commands.push({ kind: "add-track", trackId: fresh, trackKind: "dialogue", name: "Dialogue" });
    const measured = production.takeMediaInfo?.[take.id]?.mediaInfo.durationSec;
    const durationFrames = Math.max(1, secondsToFrames(measured ?? CLIP_DEFAULT_SEC, frameRate));
    let startFrame = playheadFrame;
    for (const other of orderedTrackClips(dialogue ?? { clips: [] })) {
      if (other.startFrame < startFrame + durationFrames && other.startFrame + other.durationFrames > startFrame) startFrame = other.startFrame + other.durationFrames;
    }
    const id = mintClipId();
    commands.push({
      kind: "place",
      trackId: dialogue?.id ?? fresh,
      clip: {
        id,
        startFrame,
        durationFrames,
        sourceInFrames: 0,
        source: {
          kind: "take",
          takeId: take.id,
          label: `SC ${sceneNumber} · SH ${shot.number} · ${(shot.audio?.line ?? "").slice(0, 40)}`,
          ...(shot.audio?.speaker !== undefined ? { sheetId: shot.audio.speaker } : {}),
        },
        gainDb: 0,
      },
    });
    sendCommands(commands, `Place line SH ${shot.number}`);
    pendingSelect.current = id;
  };
  const laneKindFor = (artifact: ArtifactSidecar): "picture" | "music" => (artifact.kind === "audio" ? "music" : "picture");
  const dropOnEmptyLane = (kind: "picture" | "dialogue" | "ambience" | "music") => (artifactId: string, _frame: number, laneWidth: number, x: number) => {
    const artifact = artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) return;
    placeArtifact(artifact, null, Math.max(0, Math.round((x / Math.max(laneWidth, 1)) * Math.max(totalFrames, 1))), { kind, newTrack: true });
  };
  const dropOnNewLane = (artifactId: string, laneWidth: number, x: number) => {
    const artifact = artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) return;
    placeArtifact(artifact, null, Math.max(0, Math.round((x / Math.max(laneWidth, 1)) * Math.max(totalFrames, 1))), { kind: laneKindFor(artifact), newTrack: true });
  };
  /** The non-drag path for a shot the cut dropped (R-10): its clip lands on the base track at the playhead. */
  const placeShot = (shotId: string, frameWanted: number = playheadFrame) => {
    if (!editableTimeline || !production) return;
    const found = production.scenes.flatMap((scene) => orderedShots(scene).map((shot) => ({ scene, shot }))).find(({ shot }) => shot.id === shotId);
    if (found === undefined) return;
    const durationFrames = Math.max(1, secondsToFrames(found.shot.durationSec ?? CLIP_DEFAULT_SEC, frameRate));
    // The playhead usually sits inside a clip; the shot slides to the first free span after it
    // rather than being refused for the overlap (round eleven).
    const base = editableTimeline.tracks.find((track) => track.id === PICTURE_TRACK_ID);
    let startFrame = frameWanted;
    for (const clip of orderedTrackClips(base ?? { clips: [] })) {
      if (clip.startFrame < startFrame + durationFrames && clip.startFrame + clip.durationFrames > startFrame) startFrame = clip.startFrame + clip.durationFrames;
    }
    sendCommands(
      [
        {
          kind: "place",
          trackId: PICTURE_TRACK_ID,
          clip: {
            id: mintClipId(),
            startFrame,
            durationFrames,
            sourceInFrames: 0,
            source: { kind: "shot", shotId, sceneNumber: found.scene.number, shotNumber: found.shot.number, label: found.shot.title },
          },
        },
      ],
      `Place ${found.shot.title}`,
    );
  };
  /** Locate (R-11, R-16): select the use and bring the playhead to it. Nothing is written. */
  const locateClip = (clipId: TimelineClipId, startFrame: number) => {
    selectPicture(clipId);
    transport.seek(startFrame / frameRate);
    // Zoomed in, the use can sit past the canvas edge; a locate that leaves it there is a no-op to the eye.
    queueMicrotask(() => document.querySelector<HTMLElement>(`[data-clip="${clipId}"]`)?.scrollIntoView?.({ block: "nearest", inline: "center" }));
  };
  const onTrackDrop = (drop: TrackDrop) => {
    const artifact = artifacts.find((candidate) => candidate.id === drop.artifactId);
    if (artifact) placeArtifact(artifact, drop.trackId, drop.frame);
  };
  /** An explicit draft from speech (SPEC-038 R-25): fenced like every other write. */
  const transcribe = (trackId: TimelineTrackId, language: string) => {
    if (!worldId || !prodId || timelineRevision === null || commandPending) return;
    setTimelineCommandError(null);
    setInFlight({ revision: timelineRevision, since: Date.now(), patient: true });
    sendTimelineTranscribe(worldId, prodId, timelineRevision, trackId, language);
  };
  const selectedAction = (action: "split" | "duplicate" | "delete" | "ripple") => {
    if (action === "delete" && selectedCueId !== null) {
      sendCommands([{ kind: "delete-cue", cueId: selectedCueId as `cu_${string}` }], "Delete subtitle");
      return;
    }
    const target = selectedAny?.clip ?? selectedPictureClip;
    if (!target) return;
    const clipId = target.id;
    if (action === "split") sendCommands([{ kind: "split", clipId, atFrame: playheadFrame, newClipId: mintClipId() }], "Split at the playhead");
    else if (action === "duplicate") sendCommands([{ kind: "duplicate", clipId, newClipId: mintClipId() }], "Duplicate clip");
    else if (action === "delete") sendCommands([{ kind: "delete", clipId }], "Delete clip");
    else sendCommands([{ kind: "ripple-delete", clipId }], "Ripple delete clip");
  };

  /*
   * Editor shortcuts (SPEC-039 R-17): Space plays outside text fields, Undo and Redo follow the
   * platform, and Delete removes the selection when focus is not already on a clip that handles
   * its own keys. Every one of them has a labelled control in the toolbar.
   */
  /*
   * The banner (R-46): the last assembly Arke made, with its notes behind `what it did`, until
   * it is hidden; the empty start until something is placed; the song's anchors for a spine.
   * Nothing is said about a cut a person built — the timeline is its own account.
   */
  const found = timelineState.status === "ready" ? assemblyEntry(timelineState.timeline) : null;
  const assembly = found?.entry ?? null;
  const noticeKey = found === null ? null : `${found.index}:${found.entry.label}`;
  let notice: React.ReactNode = null;
  if (assembly !== null && noticeKey !== noticeHidden) {
    const shots = assembly.clips.filter((change) => change.before === null && change.after !== null && change.after.source.kind === "shot");
    // A gap is what the cut resolver draws as one — a take without media is a gap however the selection reads.
    const unplayable = new Set((cut?.entries ?? []).filter((entry) => entry.media === null).map((entry) => entry.shot.id));
    const gaps = shots.filter((change) => change.after!.source.kind === "shot" && unplayable.has(change.after!.source.shotId)).length;
    const beds = assembly.clips.some((change) => change.before === null && change.after?.source.kind === "artifact");
    const cues = assembly.cues.some((change) => change.before === null && change.after !== null);
    const parts = [`${assembly.label}: ${shots.length - gaps} of ${shots.length} shot${shots.length === 1 ? "" : "s"}`];
    if (beds) parts.push("laid the bed");
    if (cues) parts.push("conformed the subtitles");
    notice = (
      <div className="fy-cutnotice" data-testid="assembly-notice">
        <span className="fy-cutnotice__mark" aria-hidden="true"><Sparkle size={12} /></span>
        <strong>{parts.length === 1 ? `${parts[0]}.` : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}.`}</strong>
        <span className="fy-h1row__push" />
        <button type="button" aria-expanded={didOpen} aria-controls="assembly-did" onClick={() => setDidOpen((open) => !open)}>
          what it did
        </button>
        <button type="button" className="fy-cutnotice__hide" aria-label="Hide" onClick={() => setNoticeHidden(noticeKey)}>
          &times;
        </button>
        {didOpen && (
          <ul className="fy-cutnotice__did" id="assembly-did">
            {(assembly.notes ?? []).map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
      </div>
    );
  } else if (spineCut) {
    notice = (
      <div className="fy-cutnotice">
        <span className="fy-cutnotice__mark" aria-hidden="true"><Sparkle size={12} /></span>
        <strong>{`Arke assembled ${spineCut.segments.filter((segment) => segment.kind === "clip").length} picture anchors on the track.`}</strong>
      </div>
    );
  } else if (editableTimeline !== null && allClips.length === 0 && !commandPending) {
    notice = (
      <div className="fy-cutnotice" data-testid="empty-notice">
        <span className="fy-cutnotice__mark" aria-hidden="true"><Sparkle size={12} /></span>
        <strong>This cut starts empty.</strong>
        <span className="fy-cutnotice__hint">Add to the Library and place, or ask Arke.</span>
        <span className="fy-h1row__push" />
        <button type="button" disabled={commandsDisabled} onClick={() => setPickerOpen(true)}>
          Add to the library
        </button>
      </div>
    );
  }
  const shortcuts = useRef({ canUndo, canRedo, selectedPictureClip: selectedAny?.clip ?? selectedPictureClip, selectedCueId, commandsDisabled, keysOpen });
  shortcuts.current = { canUndo, canRedo, selectedPictureClip: selectedAny?.clip ?? selectedPictureClip, selectedCueId, commandsDisabled, keysOpen };
  const zoomBy = (delta: number) => setZoom((current) => Math.min(4, Math.max(1, Math.round((current + delta) * 2) / 2)));
  const deselect = (): boolean => {
    // Panes and dialogs own Escape first; the selection is only cleared when nothing else is open.
    if (keysOpen || document.querySelector(".fy-clipmenu, .fy-editordialog")) return false;
    if (libraryOpen && editorMediaMatches("(max-width: 1199px)")) return false;
    if (rightOpen && editorMediaMatches("(max-width: 899px)")) return false;
    if (activeSelection === null) return false;
    setSelected(null);
    return true;
  };
  const shortcutActions = useRef({ sendHistory, selectedAction, toggle: () => transport.setPlaying((playing) => !playing), zoom: zoomBy, keys: () => setKeysOpen((open) => !open), deselect, setTool });
  shortcutActions.current = { sendHistory, selectedAction, toggle: () => transport.setPlaying((playing) => !playing), zoom: zoomBy, keys: () => setKeysOpen((open) => !open), deselect, setTool };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (typingTarget(event.target)) return;
      const meta = event.ctrlKey || event.metaKey;
      const key = event.key;
      const state = shortcuts.current;
      const actions = shortcutActions.current;
      // The key that opened the keys sheet closes it; every other sheet owns the keyboard while
      // it is up (R-5), so Delete behind the export sheet deletes nothing.
      if (state.keysOpen && key === "?" && !meta) {
        actions.keys();
        event.preventDefault();
        return;
      }
      if (document.querySelector(".fy-editordialog") !== null) return;
      if (event.key === " " && interactiveTarget(event.target)) return;
      if (meta && (key === "z" || key === "Z")) {
        if (event.shiftKey ? state.canRedo : state.canUndo) actions.sendHistory(event.shiftKey ? "redo" : "undo");
      } else if (meta && (key === "y" || key === "Y")) {
        if (state.canRedo) actions.sendHistory("redo");
      } else if (key === " " && !meta) {
        actions.toggle();
      } else if ((key === "+" || key === "=") && !meta) {
        actions.zoom(0.5);
      } else if ((key === "-" || key === "_") && !meta) {
        actions.zoom(-0.5);
      } else if (key === "?" && !meta) {
        actions.keys();
      } else if ((key === "v" || key === "b" || key === "h" || key === "V" || key === "B" || key === "H") && !meta && !event.altKey) {
        const lower = key.toLowerCase();
        actions.setTool(lower === "v" ? "select" : lower === "b" ? "blade" : "hand");
      } else if (key === "Escape" && !meta) {
        if (!actions.deselect()) return;
      } else if ((key === "Delete" || key === "Backspace") && !meta) {
        if (event.target instanceof HTMLElement && event.target.closest("[data-clip], [data-cue]")) return;
        if ((state.selectedPictureClip || state.selectedCueId !== null) && !state.commandsDisabled) actions.selectedAction(event.shiftKey ? "ripple" : "delete");
        else return;
      } else {
        return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const laneCount = shownTimeline ? shownTimeline.tracks.length : spineCut ? 2 : 1;
  const totalFrames = Math.max(
    secondsToFrames(totalSec, frameRate),
    views.reduce((end, view) => Math.max(end, view.clip.startFrame + view.clip.durationFrames), 0),
    ...(shownTimeline?.tracks.flatMap((track) => track.clips.map((clip) => clip.startFrame + clip.durationFrames)) ?? []),
  );

  return (
    <div className="fy-cutcols" data-screen="cut">
      <ArtifactPanel
        worldId={worldId}
        artifacts={artifacts}
        slug={slug}
        production={production}
        timeline={editableTimeline}
        playheadFrame={playheadFrame}
        usedArtifactIds={usedArtifactIds}
        usedShotIds={usedShotIds}
        library={libraryItems}
        onOpenPicker={editableTimeline !== null && !commandsDisabled ? () => setPickerOpen(true) : null}
        onAddLine={editableTimeline !== null && !commandsDisabled ? placeVoiceTake : null}
        onAddArtifact={editableTimeline !== null && !commandsDisabled ? (artifact) => placeArtifact(artifact, null, playheadFrame) : null}
        onAddShot={editableTimeline !== null && !commandsDisabled ? placeShot : null}
        onLocate={locateClip}
        initialFilter={libraryFilter}
        open={libraryOpen}
        onClose={() => {
          setLibraryOpen(false);
          if (editorMediaMatches("(max-width: 1199px)")) queueMicrotask(() => libraryToggleRef.current?.focus());
        }}
        panelRef={libraryPanelRef}
      />
      <main className="fy-cutmain">
        <header className="fy-cuthead">
          <button
            ref={libraryToggleRef}
            type="button"
            className="fy-editorpane-toggle fy-editorpane-toggle--library"
            aria-controls="cut-library"
            aria-expanded={libraryOpen}
            onClick={() => {
              const opening = !libraryOpen;
              setRightOpen(false);
              setLibraryOpen(opening);
              if (opening) queueMicrotask(() => focusFirstControl(libraryPanelRef.current));
            }}
          >
            Library
          </button>
          <div className="fy-cuthead__title">
            <h1>The cut</h1>
            <span className="fy-cuthead__meta">
              {cutMeta}
              {clipCount > 0 && ` · ${clipCount} clip${clipCount === 1 ? "" : "s"}`}
            </span>
          </div>
          <span className="fy-h1row__push" />
          <Button size="sm" onClick={() => setWatchToken((n) => n + 1)}>Watch from top</Button>
          <Button
            size="sm"
            variant="primary"
            disabled={timelineError !== null || renderError !== null}
            onClick={() => setExportOpen(true)}
          >
            Export film
          </Button>
          <button
            ref={rightToggleRef}
            type="button"
            className="fy-editorpane-toggle fy-editorpane-toggle--right"
            aria-controls="cut-right-pane"
            aria-expanded={rightOpen}
            onClick={() => {
              const opening = !rightOpen;
              setLibraryOpen(false);
              setRightOpen(opening);
              if (opening) queueMicrotask(() => focusFirstControl(rightPanelRef.current));
            }}
          >
            {rightTab === "arke" ? "Arke" : "Inspector"}
          </button>
        </header>
        {notice}
        <div className="fy-cutpreview-wrap">
          {timelineError && <div className="fy-cuttimeline-error">Timeline unavailable · {timelineError}</div>}
          {timelineError === null && renderError !== null && (
            <div className="fy-cuttimeline-error" role="status">Preview and export unavailable · {renderError}</div>
          )}
          <CutPreview
            slug={slug}
            spans={spans}
            totalSec={filmSec}
            soundSec={mediaOnly ? placedExtentSec(placedSound) : 0}
            restartToken={watchToken}
            transport={transport}
            cueAt={cueAt}
            cueStyle={renderPlan?.ok ? (renderPlan.plan.subtitles?.style ?? null) : null}
          />
        </div>
        <section className="fy-timeline" aria-label="Timeline" data-ghost={ghostTimeline !== null ? "true" : undefined}>
          <div className="fy-timeline__toolbar">
            <strong>TIMELINE</strong>
            <span className="fy-timeline__meta">
              {laneCount} lane{laneCount === 1 ? "" : "s"} · {clipCount} clip{clipCount === 1 ? "" : "s"}
            </span>
            {editableTimeline !== null && (
              <span className="fy-timeline__tools" role="group" aria-label="Tools">
                {(
                  [
                    ["select", "Select", "V", Pointer],
                    ["blade", "Blade", "B", Scissors],
                    ["hand", "Hand", "H", Hand],
                  ] as const
                ).map(([value, label, key, Mark]) => (
                  <button
                    key={value}
                    type="button"
                    className="fy-tlbtn fy-tip"
                    data-tip={`${label} · ${key}`}
                    aria-label={label}
                    aria-pressed={tool === value}
                    onClick={() => setTool(value)}
                  >
                    <Mark size={12} />
                  </button>
                ))}
              </span>
            )}
            <span className="fy-h1row__push" />
            <span className="fy-timeline__group" role="group" aria-label="History">
              <button type="button" className="fy-tlbtn fy-tip" data-tip="Undo · Ctrl+Z" aria-label="Undo" disabled={!canUndo} onClick={() => sendHistory("undo")}>
                <RotateCcw size={12} />
              </button>
              <button type="button" className="fy-tlbtn fy-tip" data-tip="Redo · Ctrl+Shift+Z" aria-label="Redo" disabled={!canRedo} onClick={() => sendHistory("redo")}>
                <RotateCw size={12} />
              </button>
            </span>
            <span className="fy-timeline__group" role="group" aria-label="Order">
              <button
                type="button"
                className="fy-tlbtn fy-tip"
                data-tip="Move earlier · ["
                aria-label="Move earlier"
                disabled={timelineError !== null || commandPending || selectedPictureIndex <= 0}
                onClick={() => sendPictureMove("earlier")}
              >
                <ChevronLeft size={12} />
              </button>
              <button
                type="button"
                className="fy-tlbtn fy-tip"
                data-tip="Move later · ]"
                aria-label="Move later"
                disabled={
                  timelineError !== null ||
                  commandPending ||
                  selectedPictureIndex < 0 ||
                  selectedPictureIndex >= orderedPictureClips.length - 1
                }
                onClick={() => sendPictureMove("later")}
              >
                <ChevronRight size={12} />
              </button>
            </span>
            {/* The song clock has no editable record yet (SPEC-037 §2.3): its controls stay
                the ones it can honour rather than buttons that refuse on every press. */}
            {spineCut !== null && timelineState.status === "absent" && (
              <button
                type="button"
                disabled={commandPending || sourceFingerprint === null || !worldId || !prodId}
                onClick={openOnTimeline}
                title={sourceFingerprint === null ? "Measure the master track first" : "Edit the song's picture on the timeline"}
              >
                Open on the timeline
              </button>
            )}
            {editableTimeline !== null && (
              <span className="fy-timeline__group" role="group" aria-label="Edit">
                <button
                  type="button"
                  className="fy-tlbtn fy-tlbtn--text fy-tip"
                  data-tip={playheadInsideSelected ? "Split at the playhead · S" : "Move the playhead over the selected clip to split it"}
                  aria-label="Split"
                  disabled={commandsDisabled || !playheadInsideSelected}
                  onClick={() => selectedAction("split")}
                >
                  <Scissors size={12} />
                  Split
                </button>
                <button type="button" className="fy-tlbtn fy-tip" data-tip="Duplicate · D" aria-label="Duplicate" disabled={commandsDisabled || !selectedAny} onClick={() => selectedAction("duplicate")}>
                  <Copy size={12} />
                </button>
                <button type="button" className="fy-tlbtn fy-tip" data-tip="Delete · ⌫" aria-label="Delete" disabled={commandsDisabled || !selectedAny} onClick={() => selectedAction("delete")}>
                  <Trash size={12} />
                </button>
                <button type="button" className="fy-tlbtn fy-tip" data-tip="Ripple delete · ⇧⌫" aria-label="Ripple delete" disabled={commandsDisabled || !selectedAny} onClick={() => selectedAction("ripple")}>
                  <Collapse size={12} />
                </button>
              </span>
            )}
            <button type="button" className="fy-tlbtn fy-tlbtn--text fy-tlbtn--toggle fy-tip" data-tip="Clips land on shot boundaries" aria-label="Snap" aria-pressed={snap} onClick={() => setSnap((on) => !on)}>
              <Snap size={10} />
              snap
            </button>
            {editableTimeline !== null && (
              <button
                type="button"
                className="fy-tlbtn fy-tlbtn--text fy-tlbtn--toggle fy-tip"
                data-tip="Music drops under dialogue automatically"
                aria-label="Duck"
                aria-pressed={editableTimeline.mix.speechFirst}
                disabled={commandsDisabled}
                onClick={() => sendCommands([{ kind: "set-mix", mix: { speechFirst: !editableTimeline.mix.speechFirst } }], editableTimeline.mix.speechFirst ? "Duck off" : "Duck on")}
              >
                <Duck size={10} />
                duck
              </button>
            )}
            <button type="button" className="fy-tlbtn fy-tlbtn--help fy-tip" data-tip="Keyboard shortcuts · ?" aria-label="Keyboard shortcuts" aria-pressed={keysOpen} onClick={() => setKeysOpen((open) => !open)}>
              ?
            </button>
            <span className="fy-timeline__zoom" role="group" aria-label="Zoom">
              <button type="button" className="fy-tlbtn fy-tip" data-tip="Zoom out · −" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => zoomBy(-0.5)}>
                <Minus size={11} />
              </button>
              <span className="fy-mono">{zoom.toFixed(1)}×</span>
              <button type="button" className="fy-tlbtn fy-tip" data-tip="Zoom in · +" aria-label="Zoom in" disabled={zoom >= 4} onClick={() => zoomBy(0.5)}>
                <Plus size={11} />
              </button>
            </span>
          </div>
          <ExportSheet
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        worldId={worldId}
        prodId={prodId}
        world={world ?? null}
        production={production ?? null}
        timelineState={timelineState}
        onMix={(speechFirst) => sendCommands([{ kind: "set-mix", mix: { speechFirst } }], speechFirst ? "Duck under speech" : "Flat mix")}
        commandsDisabled={commandsDisabled}
      />
      <AddToLibraryDialog
        open={pickerOpen}
        production={production ?? null}
        artifacts={artifacts}
        library={libraryItems}
        onClose={() => setPickerOpen(false)}
        onAdd={(added, removed) => {
          changeLibrary(added, removed);
          setPickerOpen(false);
        }}
      />
      <EditorDialog open={keysOpen} title="Keyboard" subtitle="press ? to close" onClose={() => setKeysOpen(false)} width={372}>
            <div className="fy-keys">
              {EDITOR_KEYS.map(([key, what]) => (
                <span key={key} className="fy-keys__row">
                  <span className="fy-keys__key">{key}</span>
                  <span className="fy-keys__what">{what}</span>
                </span>
              ))}
            </div>
          </EditorDialog>
          {timelineCommandError && (
            <div className="fy-timeline__refusal" role="alert">Edit refused · {timelineCommandError}</div>
          )}
          <div
            className="fy-timeline__canvas"
            onClick={(event) => {
              const target = event.target as HTMLElement;
              if (target.closest(".fy-cutseg, .fy-ovclip, .fy-typedclip, .fy-clipmenu, .fy-trackbtns")) return;
              setSelected(null);
            }}
          >
            <div className="fy-timeline__zoomwrap" style={{ width: `${zoom * 100}%` }}>
            <CutScrubber
              totalSec={totalSec}
              frameRate={frameRate}
              transport={transport}
            />
            <div className="fy-tracks">
              {totalSec > 0 && (
                <div
                  className="fy-playhead"
                  style={{ left: `calc(88px + (100% - 88px) * ${Math.min(1, transport.time / totalSec)})` }}
                  aria-hidden
                />
              )}
              {editableTimeline && production && subtitleTracksOf(editableTimeline).length > 0 ? (
                subtitleTracksOf(editableTimeline).map((track) => (
                  <SubtitleTrackRow
                    key={track.id}
                    track={track}
                    totalFrames={totalFrames}
                    frameRate={frameRate}
                    production={production}
                    selectedCueId={selectedCueId}
                    onSelectCue={selectCue}
                    onCommands={sendCommands}
                    disabled={commandsDisabled}
                    playheadFrame={playheadFrame}
                  />
                ))
              ) : (
                <EmptyEditorTrack label="Subtitles" detail={editableTimeline ? "Add a subtitle track in the Inspector" : "No subtitle track yet"} kind="subtitles" />
              )}
              {production && cut ? (
                spineCut ? (
                  <SpineCutTrack
                    slug={slug}
                    cut={spineCut}
                    selectedShotId={activeSelection?.kind === "picture" ? activeSelection.id : null}
                    onSelectShot={selectPicture}
                  />
                ) : shownTimeline ? (
                  <>
                    <SceneBands views={views} totalFrames={totalFrames} />
                    <PictureTrack
                      timeline={shownTimeline}
                      views={views}
                      slug={slug}
                      totalFrames={totalFrames}
                      frameRate={frameRate}
                      selectedClipId={activeSelection?.kind === "picture" ? activeSelection.id : null}
                      onSelect={selectPicture}
                      onCommands={sendCommands}
                      onPreview={setDraft}
                      tool={tool}
                      playheadFrame={playheadFrame}
                      disabled={commandsDisabled}
                      mintClipId={mintClipId}
                      sourceLength={sourceLength}
                      {...(commandsDisabled
                        ? {}
                        : {
                            onDrop: (drop: { artifactId: string; frame: number }) => {
                              // A Library shot carries `shot:<id>` in the same slot an artifact id would (R-10).
                              if (drop.artifactId.startsWith("shot:")) {
                                placeShot(drop.artifactId.slice(5), drop.frame);
                                return;
                              }
                              const artifact = artifacts.find((candidate) => candidate.id === drop.artifactId);
                              if (artifact) placeArtifact(artifact, PICTURE_TRACK_ID, drop.frame);
                            },
                          })}
                    />
                    <TypedTrackRows
                      timeline={shownTimeline}
                      totalFrames={totalFrames}
                      frameRate={frameRate}
                      selectedClipId={activeSelection?.kind === "picture" ? activeSelection.id : null}
                      onSelect={selectPicture}
                      onCommands={sendCommands}
                      onPreview={setDraft}
                      disabled={commandsDisabled}
                      sourceLength={sourceLength}
                      onDrop={onTrackDrop}
                      playheadFrame={playheadFrame}
                      mintClipId={mintClipId}
                      tool={tool}
                    />
                  </>
                ) : (
                  <EmptyEditorTrack label="Picture" detail="No picture in this cut" kind="picture" />
                )
              ) : (
                <EmptyEditorTrack label="Picture" detail="Opening accepted takes…" kind="picture" />
              )}
              {(["dialogue", "ambience", "music"] as const)
                .filter((kind) => !(shownTimeline?.tracks.some((track) => track.kind === kind) ?? false))
                .map((kind) => (
                  <EmptyEditorTrack
                    key={kind}
                    label={kind === "dialogue" ? "Dialogue" : kind === "ambience" ? "Ambience" : "Music"}
                    detail={editableTimeline ? "drop sound here" : `Typed ${kind} track not available`}
                    kind={kind}
                    {...(editableTimeline && !commandsDisabled ? { onDrop: dropOnEmptyLane(kind) } : {})}
                  />
                ))}
              {editableTimeline && <NewLaneStrip onDrop={commandsDisabled ? null : dropOnNewLane} />}
              {worldId && prodId && timelineError === null && !placementsOnTimeline && overlays.length > 0 && (
                <ClipLanes
                  worldId={worldId}
                  prodId={prodId}
                  slug={slug}
                  totalSec={totalSec}
                  clips={overlays}
                  artifacts={artifacts}
                  snapPoints={snapPoints}
                  selectedClipId={activeSelection?.kind === "overlay" ? activeSelection.id : null}
                  onSelectClip={selectOverlay}
                />
              )}
            </div>
            </div>
          </div>
          <div className="fy-cutfoot">
            <span className="fy-mono fy-cutfoot__note">
              {production && timelineState.status === "ready"
                ? `saved timeline · revision ${timelineState.timeline.revision} · ${productionFrameRate(production.meta)} fps`
                : mediaOnly
                  ? "the cut is what you placed — nothing recomputes it; the clips themselves are the record"
                  : "the cut starts empty — the first placement saves it as the timeline"}
            </span>
            <span className="fy-mono">
              {spineCut
                ? `${spineCut.segments.filter((seg) => seg.kind === "clip").length} of ${spineCut.segments.filter((seg) => seg.kind !== "black").length} anchors covered`
                : mediaOnly
                  ? ""
                  : cut
                    ? `${cut.covered} of ${views.length || cut.entries.length} shots placed · ${cut.gaps} gap${cut.gaps === 1 ? "" : "s"}`
                    : ""}
            </span>
            <span className="fy-h1row__push" />
            {drift && (drift.reordered || drift.missing.length > 0 || drift.repeated.length > 0) && (
              <span className="fy-driftchip" role="status">
                <span className="fy-dot fy-dot--warn" />
                {[
                  drift.reordered ? "order differs from the story" : null,
                  drift.missing.length > 0 ? `${drift.missing.length} story shot${drift.missing.length === 1 ? "" : "s"} not in the cut` : null,
                  drift.repeated.length > 0 ? `${drift.repeated.length} repeated` : null,
                ]
                  .filter((part) => part !== null)
                  .join(" · ")}
              </span>
            )}
            {spineCut
              ? spineCut.blackSec > 0 && (
                  <span className="fy-warnchip">
                    <span className="fy-dot fy-dot--warn" />
                    {spineCut.segments.filter((seg) => seg.kind === "black").length} black · {seconds(spineCut.blackSec)} uncovered
                  </span>
                )
              : cut && cut.gaps > 0 && (
                  <span className="fy-warnchip">
                    <span className="fy-dot fy-dot--warn" />
                    {cut.gaps} gap{cut.gaps === 1 ? "" : "s"} · {seconds(cut.uncoveredSec)} uncovered
                  </span>
                )}
          </div>
        </section>
      </main>
      <aside ref={rightPanelRef} className="fy-cutside" id="cut-right-pane" data-open={rightOpen} aria-label="Editor details">
        <div className="fy-cutside__tabs" role="tablist" aria-label="Editor details">
          <button
            type="button"
            id="cut-inspector-tab"
            role="tab"
            aria-selected={rightTab === "inspector"}
            aria-controls="cut-inspector-panel"
            onClick={() => setRightTab("inspector")}
          >
            Inspector
          </button>
          <button
            type="button"
            id="cut-arke-tab"
            role="tab"
            aria-selected={rightTab === "arke"}
            aria-controls="cut-arke-panel"
            onClick={() => setRightTab("arke")}
          >
            Arke
          </button>
          <button
            type="button"
            className="fy-cutside__close"
            aria-label="Close editor details"
            onClick={() => {
              setRightOpen(false);
              if (editorMediaMatches("(max-width: 899px)")) queueMicrotask(() => rightToggleRef.current?.focus());
            }}
          >
            &times;
          </button>
        </div>
        {rightTab === "inspector" ? (
          <div
            className="fy-cutside__panel"
            id="cut-inspector-panel"
            role="tabpanel"
            aria-labelledby="cut-inspector-tab"
          >
            <CutInspector
              worldId={worldId}
              prodId={prodId}
              production={production}
              cut={cut}
              spineCut={spineCut}
              artifacts={artifacts}
              selection={activeSelection}
              selectedClip={selectedAny?.clip ?? null}
              selectedTrack={selectedAny?.track ?? null}
              timeline={editableTimeline}
              subtitleView={subtitleView}
              onViewSubtitles={setSubtitleChoice}
              onTranscribe={timelineRevision !== null && !commandsDisabled ? transcribe : null}
              filmSec={filmSec}
              clipCount={clipCount}
              savedPictureOrder={timelineState.status === "ready"}
              frameRate={frameRate}
              commandsDisabled={commandsDisabled}
              onCommands={sendCommands}
              onOpenExport={() => setExportOpen(true)}
              onFill={(clipId) => {
                selectPicture(clipId);
                const clip = allClips.find((candidate) => candidate.clip.id === clipId);
                if (clip) transport.seek(clip.clip.startFrame / frameRate);
              }}
              mintClipId={mintClipId}
            />
          </div>
        ) : (
          <div
            className="fy-cutside__panel fy-cutside__panel--arke"
            id="cut-arke-panel"
            role="tabpanel"
            aria-labelledby="cut-arke-tab"
          >
            {assembly !== null && (
              <div className="fy-arkenotes" data-testid="arke-notes">
                <div className="fy-cutinspect__eyebrow">{assembly.label.toUpperCase()}</div>
                <ul className="fy-cutnotice__did fy-arkenotes__list">
                  {(assembly.notes ?? []).map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </div>
            )}
            <ProductionConversation
              worldId={worldId}
              productionId={prodId}
              dock={{ title: "Arke", subject: `${production?.meta.title ?? "production"} · production conversation` }}
              openingNote="opening production conversation…"
              emptyLine="No production conversation yet. This tab uses the same real thread as Develop. Ask for a change to the cut and Arke stages it as a request you accept or reject."
              placeholder="Ask Arke about this production…"
              pointsEmpty="Nothing understood yet."
              subject={selectedAny ? { kind: "timeline-clip", clipId: selectedAny.clip.id } : undefined}
              side={
                production && production.editorRequests.length > 0 ? (
                  <EditorRequestCards
                    requests={production.editorRequests}
                    base={editableTimeline}
                    timelineState={timelineState}
                    currentFingerprint={sourceFingerprint}
                    frameRate={frameRate}
                    ghostId={ghostRequestId}
                    onGhost={setGhostRequestId}
                    onDecide={decideRequest}
                    disabled={timelineError !== null || commandPending || !worldId || !prodId}
                  />
                ) : undefined
              }
            />
          </div>
        )}
      </aside>
    </div>
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
  | { kind: "no-track" }
  | { kind: "unmeasured" }
  | { kind: "silent"; durationSec: number }
  | { kind: "spine"; cut: ReturnType<typeof deriveSpineCut> };

function exportViewFor(
  world:
    | { artifacts: readonly { id: string; mediaInfo?: { durationSec: number; hasAudio: boolean } }[] }
    | null
    | undefined,
  production: Parameters<typeof deriveSpineCut>[0] | null | undefined,
): ExportView {
  const spine = production?.spine;
  if (!production || !spine || !world) return { kind: "scene-order" };
  const track = world.artifacts.find((a) => a.id === spine.trackArtifactId);
  // A spine naming an artifact this world does not have is not the same as one nobody measured:
  // the coordinator has no path to probe, so no export can succeed and none should be offered.
  if (track === undefined) return { kind: "no-track" };
  if (track.mediaInfo === undefined) return { kind: "unmeasured" };
  // Measured is not usable. A track with no audio stream refuses every preset in the coordinator.
  if (!track.mediaInfo.hasAudio) return { kind: "silent", durationSec: track.mediaInfo.durationSec };
  return { kind: "spine", cut: deriveSpineCut(production, spine, track.mediaInfo.durationSec) };
}

// ---- Stills contact sheet --------------------------------------------------

/**
 * Generate's second lens (design 55a): the frame/still takes as a set, decided one at a time.
 * This was a rail destination of its own; a take is decided where it was made, so the contact
 * sheet now lives inside the workspace and the seg is the way between the lenses.
 */
function ContactSheet({
  production,
  worldSlug,
  worldId,
  prodId,
  onShotLens,
}: {
  production: ReturnType<typeof useProduction>["production"];
  worldSlug: string | undefined;
  worldId: string | undefined;
  prodId: string | undefined;
  onShotLens: () => void;
}) {
  const stills = useMemo(
    () => production?.takes.filter((t) => t.kind === "frame" || t.kind === "still") ?? [],
    [production],
  );
  const decisions = production ? takeDecisions(production) : {};
  return (
    <div className="fy-prodmain" data-screen="stills-contact-sheet">
      <div className="fy-h1row">
        <span className="fy-seg">
          <button type="button" className="fy-seg__item" onClick={onShotLens}>
            Shot
          </button>
          <span className="fy-seg__item fy-seg__item--active">Contact sheet</span>
        </span>
        <span className="fy-h1row__meta">
          {stills.length} frame{stills.length === 1 ? "" : "s"} — judged as a set, accepted one at a time
        </span>
      </div>
      {stills.length === 0 ? (
        <EmptyState title="No stills yet" hint="Frames and stills land here as they are generated." />
      ) : (
        <div
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14 }}
        >
          {stills.map((take) => {
            const decision = decisions[take.id];
            const shotId = take.coversShots[0];
            return (
              <div key={take.id} className="fy-shotcard">
                <div className="fy-shotcard__frame">
                  <Portrait
                    worldSlug={worldSlug}
                    path={takeMediaPath(production!, take) ?? ""}
                    label={shotId?.replace("sh_", "shot ") ?? take.id}
                    radius={0}
                  />
                </div>
                <div className="fy-shotcard__body">
                  <div className="fy-shotcard__head">
                    <span className="fy-shotcard__num">{shotId?.replace("sh_", "") ?? "—"}</span>
                    <span className="fy-shotcard__title">{take.media ?? take.id}</span>
                    <span className={`fy-dot fy-dot--${decisionTone(decision)}`} />
                  </div>
                  <span className="fy-mono">
                    {take.model}
                    {decision && decision !== "pending" ? ` · ${decision}` : " · unreviewed"}
                  </span>
                  <div className="fy-shotcard__spacer" />
                  <div className="fy-shotcard__actions">
                    <Button
                      variant={decision === "accepted" ? "primary" : "ghost"}
                      disabled={!shotId}
                      onClick={() => {
                        // Accept = decision + selection in one commit (SPEC-013 R-9).
                        if (worldId && prodId && shotId) acceptTake(worldId, prodId, take.id, shotId);
                      }}
                    >
                      Accept
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={Object.keys(take.provenance.sheets).length === 0}
                      title="A rejection cites the sheet the take drifted from (R-10)"
                      onClick={() => {
                        const sheet = Object.keys(take.provenance.sheets)[0];
                        if (worldId && prodId && sheet)
                          rejectTake(
                            worldId,
                            prodId,
                            take.id,
                            { sheet, field: "appearance", note: "rejected from the contact sheet" },
                            shotId,
                          );
                      }}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
