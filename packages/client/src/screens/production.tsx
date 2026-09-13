import {
  artifactPicturePath,
  resolvedAuthoredDuration,
} from "@arke-studio/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import {
  deriveCut,
  deriveSpineCut,
  exportAudioClips,
  exportOverlays,
  mediaCanvasSec,
  MEDIA_CANVAS_HEADROOM_SEC,
  placedExtentSec,
  type BorrowableArtifact,
  type MediaDestination,
  trimCeilingSec,
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
  PRESETS,
  productionShape,
  type FrameRate,
  type ProductionBundle,
  type ProductionTimeline,
  type ResolvedPictureCut,
  type RenderPlan,
  type TimelineClip,
  type TimelineChangeHistoryEntry,
  type Shot,
  type Take,
  type TimelineClipId,
  type TimelineLibraryItem,
  type TimelineCommand,
  type TimelineClipCommand,
  type TimelineTrackId,
  basePictureTrack,
  mediaPlacementCommands,
  newAudioTrack,
  migrateLegacyCut,
  buildRenderPlan,
  legacyArtifactScopeRefusal,
  resolveProductionArtifact,
  orderedTrackClips,
  secondsToFrames,
  sourceLengthFramesFor,
  type SourceLengthFrames,
  storyOrderDrift,
  ulid,
  AUDIO_TRACK_KINDS,
  cueAtSec,
  type SubtitleStyle,
  type TimelineTrack,
  type WorldBundle,
  type ArtifactSidecar,
  MAX_CLIP_LANE,
  type CutOverlay,
  orderedShots,
} from "@arke-studio/contracts";
import { Button, cx } from "../components/ui.js";
import {
  AudioPlus,
  ChevronLeft,
  ChevronRight,
  Collapse,
  Copy,
  Download,
  Duck,
  Film,
  Folder,
  Hand,
  Help,
  Locate,
  Mic,
  Minus,
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
  SplitMark,
  Tag,
  Trash,
  Upload,
  VideoMark,
} from "../components/icons.js";
import { EDITOR_KEYS, EditorDialog } from "../components/editor-dialog.js";
import { ProductionConversation } from "../components/conversation.js";
import { Portrait } from "../components/portrait.js";
import { clock } from "../components/player.js";
import { mediaUrl } from "../lib/media.js";
import { runtimeSeconds, seconds } from "../lib/format.js";
import { artifactDisplayName, artifactsForProduction, linkNameResolver, type LinkName } from "../lib/artifact-view.js";
import {
  acceptedTakeId,
  mediaTakeFor,
  takesForShot,
  useProduction,
} from "../lib/selectors.js";
import { posterize } from "../lib/poster.js";
import { formatTimecode, useScrubDrag } from "../lib/timeline-drag.js";
import { onMediaReady, syncMediaElement, useTransport } from "../lib/playback-engine.js";
import { mediaTimeFor, videoTimeFor, spanAt, spineSpans, type PlaybackSpan } from "../lib/cut-playback.js";
import { planSpans } from "../lib/plan-playback.js";
import {
  MIN_CLIP_SEC,
  applyClipDrag,
  snapPointsFor,
  type ClipGesture,
  type ClipPlacement,
} from "../lib/clip-drag.js";
import {
  PictureClipTiming,
  DetachAudio,
  PictureTrack,
  TakePicker,
  pictureClipViews,
  useMeasuredWidth,
  type EditorTool,
  type PictureClipView,
} from "./editor-timeline.js";
import { ARTIFACT_DRAG_TYPE, ClipGain, LANE_DRAG_PICTURE, LANE_DRAG_SOUND, MixPanel, AudioClipSettings, SHOT_DRAG_TYPE, TypedTrackRows, dragAccepts, laneIcon, setLibraryDrag, type TrackDrop } from "./editor-audio.js";
import { fileKindsFromTransfer, snapCandidates, type DroppedKind } from "../lib/clip-gesture.js";
import { CueInspector, SubtitleSources, SubtitleTrackRow, subtitleTracksOf } from "./editor-subtitles.js";
import { EditorRequestCards } from "./editor-requests.js";
import { usePlanAudio } from "../lib/plan-audio.js";
import {
  cancelExport,
  exportCut,
  placeOverlay,
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
  importEditorMedia,
  setShotTrim,
  useExports,
  useStore,
  subscribeQueueResults,
  subscribeWorldArtifacts,
  browseWorldArtifacts,
  borrowArtifacts,
  subscribeTimelineRefusals,
} from "../lib/store.js";
import { Wave } from "../components/wave.js";
import { takeMediaPath } from "./production-generate.js";
import { storyShotCount } from "./production-story.js";

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
 * How a clip's source is named in the Library's use index: the kind, and the thing it points at.
 *
 * A performance carries a shot id too, and keying it by that shot would file it under the shot's
 * row — where the row's `Locate` would then walk onto a clip the row does not stand for. It keeps
 * its own key and no row asks for it, which is the row that was there before this was an index.
 */
function clipSourceKey(source: TimelineClip["source"]): string {
  switch (source.kind) {
    case "shot":
      return `shot:${source.shotId}`;
    case "take":
      return `take:${source.takeId}`;
    case "artifact":
      return `artifact:${source.artifactId}`;
    case "performance":
      return `performance:${source.performanceId}`;
  }
}

/** A file being imported, as the Library lists it until its row is real (issue 1035). */
export interface PendingImport {
  requestId: string;
  files: Array<{ name: string; sizeBytes: number }>;
  /** Set once the import answered: what failed, by position, with the reason; empty when all landed. */
  failures: Array<{ index: number; reason: string }> | null;
  /** Where the drop was aimed, so the lane draws its slot until the clip is real. */
  destination: MediaDestination;
}

/** Bytes as a person reads them on a row. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** A row's picture: the file's own, its poster, or the kind's mark when neither arrives (issue 1037). */
function MediaThumb({ slug, path, fallback }: { slug: string | undefined; path: string | null; fallback: React.ReactNode }) {
  const [failed, setFailed] = useState<string | null>(null);
  const pictureKey = `${slug ?? ""}|${path ?? ""}`;
  if (path === null || slug === undefined || failed === pictureKey) return <>{fallback}</>;
  return <img className="fy-artrow__img" src={mediaUrl(slug, path)} alt="" draggable={false} onError={() => setFailed(pictureKey)} />;
}

type LibraryFilter = "all" | "unused" | "needs-take" | "audio";
/** The kind filter (issue 1033): what a row is, beside where it stands. */
type LibraryKind = "all" | "shots" | "video" | "image" | "audio";

/**
 * The world's artifacts, beside the cut (82a; issue 1033).
 *
 * Every placeable artifact of the production's view of the world is listed directly — image,
 * board, video, audio — the way the design draws uploads and takes as one kind of thing. The
 * record's Library set still curates shots (brought in by scene through the picker) and is
 * kept in step as artifacts are placed, but it no longer stands between a person and a file.
 * Rows are drag sources and offer the click paths to the same placements; the panel never
 * places anything itself, because a placement needs a time and only the lane knows one.
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
  linkName,
  fileKinds,
  pendingImports,
  onDismissImport,
  onOpenPicker,
  onAddLine,
  onAddArtifact,
  onPlaceAtPlayhead,
  onOverlayArtifact,
  onRemoveFromLibrary,
  onImport,
  onAddShot,
  onLocate,
  worlds = [],
  onBorrow = null,
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
  /** What the record's Library holds: the shots, and the artifacts placed so far. */
  library: readonly TimelineLibraryItem[];
  /** How a link is spelled to a person, the Artifacts page's rule (issue 1005). */
  linkName: LinkName;
  /** Desktop files over the window right now: the whole panel becomes the target (issue 1035). */
  fileKinds: readonly DroppedKind[] | null;
  pendingImports: readonly PendingImport[];
  /** Takes one row off — the file at `index` of that request — never the whole batch. */
  onDismissImport: (requestId: string, index: number) => void;
  /** The shot picker, offered only when the production has shots to bring in. */
  onOpenPicker: (() => void) | null;
  /** A read line lands on Dialogue (the Audio screen's rows, kept here since it redirects; R-1). */
  onAddLine: ((take: Take, shot: Shot, sceneNumber: number) => void) | null;
  onAddArtifact: ((artifact: ArtifactSidecar) => void) | null;
  onPlaceAtPlayhead: ((artifact: ArtifactSidecar) => void) | null;
  onOverlayArtifact: ((artifact: ArtifactSidecar) => void) | null;
  /** Take a record entry off the Library: for media the world no longer has, or cannot use here. */
  onRemoveFromLibrary: ((item: TimelineLibraryItem) => void) | null;
  onImport: ((files?: File[]) => void) | null;
  onAddShot: ((shotId: string) => void) | null;
  /** Select one use and bring the playhead to it (R-11, R-16). */
  onLocate: (clipId: TimelineClipId, startFrame: number) => void;
  /** The worlds this studio holds, so the Library can browse another one's shelf (issue 1033). */
  worlds?: readonly { worldId: string; slug: string; name: string }[];
  /** Copy a file from another world into this one, as the reference picker borrows an image (issue 972). */
  onBorrow?: ((slug: string, file: string) => void) | null;
  initialFilter?: LibraryFilter;
  open: boolean;
  onClose: () => void;
  panelRef: RefObject<HTMLElement | null>;
  foot?: React.ReactNode;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LibraryFilter>(initialFilter);
  const [kindFilter, setKindFilter] = useState<LibraryKind>("all");
  const [picked, setPicked] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  /*
   * Another world's shelf, read-only, while it is chosen (issue 1033). The rows arrive by event
   * under a request id, like the reference picker's images; choosing this world again drops them.
   */
  const [browseSlug, setBrowseSlug] = useState<string | null>(null);
  const [foreign, setForeign] = useState<{ slug: string; rows: BorrowableArtifact[] | null; error: string | null } | null>(null);
  useEffect(() => {
    if (browseSlug === null) {
      setForeign(null);
      return;
    }
    setSceneFilter("all");
    const requestId = ulid();
    setForeign({ slug: browseSlug, rows: null, error: null });
    const unsubscribe = subscribeWorldArtifacts((result) => {
      if (result.requestId !== requestId) return;
      setForeign({ slug: browseSlug, rows: result.artifacts, error: result.error ?? null });
    });
    browseWorldArtifacts(browseSlug, requestId);
    return unsubscribe;
  }, [browseSlug]);
  const worldName = (slug: string): string => worlds.find((world) => world.slug === slug)?.name ?? slug;
  // A shelf browsed from another world is that world's only while this one is open; the screen
  // can outlive a world change, and the shelf it was browsing may be the world it is now in.
  useEffect(() => {
    setBrowseSlug(null);
  }, [worldId]);
  /*
   * Which use Locate reached last, per item (R-11): the next press goes on from there, and the
   * last use wraps to the first. View state, never written — Locate selects and seeks only.
   */
  const located = useRef(new Map<string, { id: TimelineClipId; frame: number }>());
  const normalQuery = query.trim().toLocaleLowerCase();
  const takesById = new Map((production?.takes ?? []).map((take) => [take.id, take] as const));
  const inLibrary = new Set(library.map(libraryItemKey));
  const [sceneFilter, setSceneFilter] = useState<string>("all");
  // Scene controls exist only where there are shots to frame by (issue 1033): an artifact-only
  // cut has no scene to select and no scene to add.
  const hasShots = (production?.scenes ?? []).some((scene) => orderedShots(scene).length > 0);
  // The panel outlives a production change. A shot-only filter chosen for the last production
  // has no control left on one without shots, and would empty the list with nothing pressed to
  // say why; it falls back to everything.
  useEffect(() => {
    if (hasShots) return;
    if (filter === "needs-take") setFilter("all");
    if (kindFilter === "shots") setKindFilter("all");
  }, [hasShots, production?.meta.id, filter, kindFilter]);
  // The panel can outlive a production change (the router keeps the screen); a scene of the last
  // production is no filter here. Nor is any scene while another world's shelf is shown: its
  // files belong to no scene of this production, so the control goes and the scope is every row.
  const sceneScope = hasShots && browseSlug === null && (production?.scenes ?? []).some((scene) => scene.id === sceneFilter) ? sceneFilter : "all";
  const shots = (production?.scenes ?? []).flatMap((scene) =>
    orderedShots(scene).filter((shot) => inLibrary.has(`shot:${shot.id}`)).map((shot) => {
      const takeId = production ? acceptedTakeId(production, shot.id) : null;
      const take = takeId === null ? null : (takesById.get(takeId) ?? null);
      return { scene, shot, take, path: take && production ? takeMediaPath(production, take) : null };
    }),
  );
  /*
   * Where each source is used, indexed once rather than searched once per row.
   *
   * Every row asks the record the same question — where does this appear — and each answer used
   * to walk every clip on every track and sort what it found. A world with a few hundred files
   * over a timeline of a few hundred clips made that tens of thousands of clip visits for one
   * render, on a panel that renders whether or not it is open and re-renders four times a second
   * while the film plays. One pass builds the answer for every row at once.
   */
  const usesIndex = new Map<string, Array<{ id: TimelineClipId; startFrame: number }>>();
  for (const track of timeline?.tracks ?? []) {
    for (const clip of track.clips) {
      const key = clipSourceKey(clip.source);
      const found = usesIndex.get(key);
      if (found === undefined) usesIndex.set(key, [{ id: clip.id, startFrame: clip.startFrame }]);
      else found.push({ id: clip.id, startFrame: clip.startFrame });
    }
  }
  for (const uses of usesIndex.values()) uses.sort((a, b) => a.startFrame - b.startFrame);
  const usesOf = (key: string): Array<{ id: TimelineClipId; startFrame: number }> => usesIndex.get(key) ?? [];
  const laneOf = (artifact: ArtifactSidecar): string | null =>
    artifact.kind === "audio" ? "Audio" : artifact.kind === "video" || artifact.kind === "image" || artifact.kind === "board" ? "Picture" : null;

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
    placeAt?: (() => void) | null;
    remove?: (() => void) | null;
    drag: string | null;
    /** The clip's length once placed, for the landing rectangle a lane draws under the drag. */
    durationFrames: number | null;
    search: string;
    kind: "take" | "shot" | "artifact" | "line";
    artifactKind?: ArtifactSidecar["kind"];
    overlay?: (() => void) | null;
    /** The scenes this row belongs to: a shot's own, an artifact's links. */
    scenes: string[];
    /** A spoken line's shot, and what has been read of it. */
    line?: { shotId: string; status: "read" | "reading…" | "not generated" };
    /** The file, when the name shown is a known name rather than the file's. */
    file?: string;
  }
  const frameRate = production ? productionFrameRate(production.meta) : 24;
  const shotItems: LibraryItem[] = shots.map(({ scene, shot, take, path }) => {
    const used = usedShotIds.has(shot.id);
    const line = shot.audio?.line ?? "";
    const takeNumber = take && production ? takesForShot(production, shot.id)
      .filter((candidate) => mediaTakeFor(production, candidate) !== null || candidate.completedAt === undefined)
      .findIndex((candidate) => candidate.id === take.id) + 1 : 0;
    return {
      key: `shot:${shot.id}`,
      name: `Shot ${shot.number} · ${shot.title}`,
      sub: take === null ? "no accepted take" : `Scene ${scene.number}${takeNumber > 0 ? ` · Take ${takeNumber}` : " · accepted take"}`,
      subTone: take === null ? "destructive" : "muted",
      thumb: take && path ? <Portrait worldSlug={slug} path={path} label="" radius={4} /> : <Film size={12} />,
      lane: "Picture",
      why: null,
      used,
      uses: usesOf(`shot:${shot.id}`),
      add: onAddShot !== null && !used ? () => onAddShot(shot.id) : null,
      drag: take !== null && path !== null ? `shot:${shot.id}` : null,
      durationFrames: shot.durationSec !== undefined ? Math.max(1, secondsToFrames(shot.durationSec, frameRate)) : null,
      search: `${scene.number} ${scene.title} ${shot.number} ${shot.title} ${shot.id} ${take?.id ?? ""} ${line}`,
      kind: take === null ? "shot" : "take",
      scenes: [scene.id],
    };
  });
  // Every placeable file the production can see (SPEC-020 R-13), newest first, plus whatever
  // the record's Library still names — a document (R-12), a file the world has lost, or one
  // retired or replaced since it was placed: its row is the one place its uses can be found
  // and its membership taken off.
  const placeableKinds = new Set<ArtifactSidecar["kind"]>(["audio", "video", "image", "board"]);
  const visible = new Set(artifactsForProduction(artifacts, production?.meta.id).map((artifact) => artifact.id));
  const onShelf = new Set(pickableArtifacts([...artifacts]).map((artifact) => artifact.id));
  const shelf = artifacts
    .filter((artifact) => (onShelf.has(artifact.id) && placeableKinds.has(artifact.kind) && visible.has(artifact.id)) || inLibrary.has(`artifact:${artifact.id}`))
    .sort((a, b) => b.created.localeCompare(a.created));
  const artifactItems: LibraryItem[] = shelf.map((artifact) => {
    const lane = laneOf(artifact);
    const file = artifact.file.split("/").pop() ?? artifact.file;
    const name = artifactDisplayName(artifact, linkName);
    const access = resolveProductionArtifact(artifacts, artifact.id, production?.meta.id ?? "");
    const gone = onShelf.has(artifact.id) ? null : artifact.retiredAt !== undefined ? "retired from the shelf" : "replaced by a newer file";
    const why = access.ok ? gone : access.reason;
    const duration = artifact.mediaInfo?.durationSec;
    const still = artifact.kind === "image" || artifact.kind === "board";
    const glyph = artifact.kind === "audio" ? <Wave seed={artifact.file} width={34} height={12} /> : artifact.kind === "video" ? <VideoMark size={12} /> : still ? <Film size={12} /> : <Scroll size={12} />;
    const item: TimelineLibraryItem = { kind: "artifact", artifactId: artifact.id };
    // Where a borrow came from (issue 1033): filing's provenance, spelled with the world's name.
    const from = artifact.origin.by === "user" && artifact.origin.importedFrom?.startsWith("world:") ? `from ${worldName(artifact.origin.importedFrom.slice(6))}` : null;
    return {
      key: `artifact:${artifact.id}`,
      name,
      sub: why ?? (lane === null ? `${artifact.kind} · no picture or sound to place` : [artifact.kind, duration !== undefined ? runtimeSeconds(duration) : null, from].filter((part) => part !== null).join(" · ")),
      subTone: why === null ? "muted" : "destructive",
      thumb: <MediaThumb slug={slug} path={why !== null ? null : artifactPicturePath(artifact)} fallback={glyph} />,
      lane,
      why: why ?? (lane === null ? `a ${artifact.kind} has no picture or sound to place` : null),
      used: usedArtifactIds.has(artifact.id),
      uses: usesOf(`artifact:${artifact.id}`),
      add: why === null && onAddArtifact !== null && lane !== null ? () => onAddArtifact(artifact) : null,
      placeAt: why === null && onPlaceAtPlayhead !== null && lane === "Picture" ? () => onPlaceAtPlayhead(artifact) : null,
      overlay: why === null && onOverlayArtifact && ["video", "image", "board"].includes(artifact.kind) ? () => onOverlayArtifact(artifact) : null,
      // Membership comes off from the row once the record has no more use for it: an unavailable
      // file's, or an available one's after its last clip is gone — deleting a clip leaves the
      // membership behind, and the picker offers shots only, so nowhere else could take it off.
      remove: (why !== null || !usedArtifactIds.has(artifact.id)) && onRemoveFromLibrary !== null && inLibrary.has(`artifact:${artifact.id}`) ? () => onRemoveFromLibrary(item) : null,
      drag: why !== null || lane === null ? null : artifact.id,
      durationFrames: still ? secondsToFrames(CLIP_DEFAULT_SEC, frameRate) : duration !== undefined ? Math.max(1, secondsToFrames(duration, frameRate)) : null,
      search: `${name} ${artifact.file} ${artifact.kind} ${artifact.links.join(" ")}`,
      kind: "artifact",
      artifactKind: artifact.kind,
      scenes: [...artifact.links],
      ...(name !== file ? { file } : {}),
    };
  });
  for (const item of library) {
    if (item.kind !== "artifact" || artifacts.some(artifact => artifact.id === item.artifactId)) continue;
    artifactItems.push({ key: libraryItemKey(item), name: item.artifactId, sub: "Missing media", subTone: "destructive", thumb: <Film size={12} />,
      lane: null, why: "This world does not have the media. Remove it from the Library or import the file.", used: usedArtifactIds.has(item.artifactId),
      uses: usesOf(`artifact:${item.artifactId}`), add: null,
      remove: onRemoveFromLibrary === null ? null : () => onRemoveFromLibrary(item),
      drag: null, durationFrames: null, search: item.artifactId, kind: "artifact", scenes: [] });
  }
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
        const uses = read === null ? [] : usesOf(`take:${read.id}`);
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
          durationFrames: null,
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
    if (kindFilter === "shots" && item.kind !== "shot" && item.kind !== "take") return false;
    if (kindFilter === "video" && item.artifactKind !== "video") return false;
    if (kindFilter === "image" && item.artifactKind !== "image" && item.artifactKind !== "board") return false;
    if (kindFilter === "audio" && item.artifactKind !== "audio" && item.kind !== "line") return false;
    if (filter === "needs-take" && item.kind !== "shot") return false;
    if (filter === "audio" && !((item.kind === "artifact" && item.lane === "Audio") || item.kind === "line")) return false;
    if (filter === "unused" && (item.used || item.kind === "shot")) return false;
    if (filter === "all" && item.kind === "shot") return true;
    return normalQuery === "" || item.search.toLocaleLowerCase().includes(normalQuery);
  };
  const items = [...shotItems, ...lineItems, ...artifactItems].filter((item) => passes(item) && (normalQuery === "" || item.search.toLocaleLowerCase().includes(normalQuery)));
  const narrowed = normalQuery !== "" || filter !== "all" || kindFilter !== "all" || sceneScope !== "all";
  const foreignRows = (foreign?.rows ?? []).filter((row) => {
    // The pressed filter still means what it says on another world's rows: no shots, no takes
    // to need, nothing already in the cut; Audio keeps only sound.
    if (kindFilter === "shots" || filter === "needs-take") return false;
    if (filter === "audio" && row.kind !== "audio") return false;
    if (kindFilter === "video" && row.kind !== "video") return false;
    if (kindFilter === "image" && row.kind !== "image" && row.kind !== "board") return false;
    if (kindFilter === "audio" && row.kind !== "audio") return false;
    return normalQuery === "" || `${row.name} ${row.file} ${row.kind}`.toLocaleLowerCase().includes(normalQuery);
  });
  const browsing = foreign !== null;
  const shown = browsing ? foreignRows.length : items.length;
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
  const filesOver = fileKinds !== null && fileKinds.length > 0 && onImport !== null;

  return (
    <aside ref={panelRef} className={cx("fy-artpanel", filesOver && "fy-artpanel--dropping")} id="cut-library" data-open={open} aria-label="Library"
      onDragOver={event => {
        if (!Array.from(event.dataTransfer.types).includes("Files") || onImport === null) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false); }}
      onDrop={event => {
        setOver(false);
        if (event.dataTransfer.files?.length) { event.preventDefault(); event.stopPropagation(); onImport?.(Array.from(event.dataTransfer.files)); }
      }}>
      {filesOver && (
        <div className={cx("fy-dropzone", over && "fy-dropzone--over")} data-testid="library-dropzone" role="status">
          <Upload size={16} />
          <span>Drop to import</span>
        </div>
      )}
      <div className="fy-artpanel__head">
        <span className="fy-artpanel__title">Library</span>
        <span className="fy-mono fy-artpanel__count">{shown} item{shown === 1 ? "" : "s"}</span>
        <span className="fy-h1row__push" />
        <button
          type="button"
          className="fy-tlbtn fy-tip"
          data-tip="Import to Library"
          aria-label="Import to Library"
          disabled={onImport === null}
          onClick={() => onImport?.()}
        >
          <Upload size={12} />
        </button>
        {hasShots && (
          <button type="button" className="fy-artpanel__add" disabled={onOpenPicker === null} onClick={() => onOpenPicker?.()}>
            <Plus size={11} />
            Add shots
          </button>
        )}
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
              ...(hasShots ? [["needs-take", "Needs a take"] as const] : []),
              ["audio", "Audio"],
            ] as const
          ).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>
              {label}
            </button>
          ))}
          {worlds.length > 1 && (
            <select className="fy-artpanel__kind" aria-label="Browse world" value={browseSlug ?? "here"} onChange={(event) => setBrowseSlug(event.target.value === "here" ? null : event.target.value)}>
              <option value="here">This world</option>
              {worlds.filter((world) => world.worldId !== worldId).map((world) => (
                <option key={world.worldId} value={world.slug}>{world.name}</option>
              ))}
            </select>
          )}
          <select className="fy-artpanel__kind" aria-label="Kind" value={kindFilter} onChange={(event) => setKindFilter(event.target.value as LibraryKind)}>
            <option value="all">All kinds</option>
            {hasShots && <option value="shots">Shots</option>}
            <option value="video">Video</option>
            <option value="image">Image</option>
            <option value="audio">Audio</option>
          </select>
          {hasShots && browseSlug === null && (production?.scenes.length ?? 0) > 1 && (
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
        {pendingImports.flatMap((pending) =>
          pending.files.map((file, index) => {
            const failure = pending.failures?.find((candidate) => candidate.index === index) ?? null;
            const state = pending.failures === null ? "importing…" : failure === null ? "added" : failure.reason;
            return (
              <div key={`${pending.requestId}:${index}`} className={cx("fy-artrow", "fy-artrow--pending", failure !== null && "fy-artrow--missing")} data-testid="pending-import">
                <div className="fy-artrow__pick" style={{ cursor: "default" }}>
                  <span className="fy-artrow__swatch"><Upload size={12} /></span>
                  <span className="fy-artrow__body">
                    <span className="fy-artrow__name">{file.name}</span>
                    <span className={cx("fy-artrow__meta", failure !== null && "fy-artrow__meta--destructive")}>{[file.sizeBytes > 0 ? formatBytes(file.sizeBytes) : null, state].filter((part) => part !== null).join(" · ")}</span>
                  </span>
                  {pending.failures !== null && (
                    <button type="button" className="fy-artrow__dismiss" aria-label={`Dismiss ${file.name}`} onClick={() => onDismissImport(pending.requestId, index)}>&times;</button>
                  )}
                </div>
              </div>
            );
          }),
        )}
        {browsing ? (
          foreign.rows === null || foreign.error !== null || foreignRows.length === 0 ? (
            <div className="fy-artpanel__empty">
              <span className="fy-artpanel__emptymark">
                <Folder size={14} />
              </span>
              <span>{foreign.error ?? (foreign.rows === null ? "Reading…" : narrowed ? "Nothing here matches." : `Nothing to copy from ${worldName(foreign.slug)}.`)}</span>
            </div>
          ) : (
            foreignRows.map((row) => {
              const key = `borrow:${row.id}`;
              const selected = picked === key;
              const glyph = row.kind === "audio" ? <Wave seed={row.file} width={34} height={12} /> : row.kind === "video" ? <VideoMark size={12} /> : <Film size={12} />;
              return (
                <div key={key} className={cx("fy-artrow", selected && "fy-artrow--picked")} data-library-item={key}>
                  <button type="button" className="fy-artrow__pick" aria-pressed={selected} title={row.file} onClick={() => setPicked(selected ? null : key)}>
                    <span className="fy-artrow__swatch"><MediaThumb slug={foreign.slug} path={row.picture} fallback={glyph} /></span>
                    <span className="fy-artrow__body">
                      <span className="fy-artrow__name">{row.name}</span>
                      <span className="fy-artrow__meta">{[row.kind, row.durationSec !== undefined ? runtimeSeconds(row.durationSec) : null, `from ${worldName(foreign.slug)}`].filter((part) => part !== null).join(" · ")}</span>
                    </span>
                    <span className="fy-artrow__lane">{row.kind === "audio" ? "Audio" : "Picture"}</span>
                  </button>
                  {selected && (
                    <div className="fy-artrow__actions" role="group" aria-label={`${row.name} actions`}>
                      <button type="button" className="fy-tlbtn fy-tlbtn--text" disabled={onBorrow === null} onClick={() => onBorrow?.(foreign.slug, row.file)}>
                        <Plus size={11} />
                        Copy into this world
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )
        ) : items.length === 0 && pendingImports.length === 0 ? (
          <div className="fy-artpanel__empty">
            <span className="fy-artpanel__emptymark">
              <Folder size={14} />
            </span>
            <span>{narrowed ? "Nothing here matches." : "Nothing to cut with yet."}</span>
            {!narrowed && <span className="fy-mono">import media · generate takes</span>}
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
                  event.dataTransfer.setData(item.lane === "Audio" ? LANE_DRAG_SOUND : LANE_DRAG_PICTURE, "1");
                  event.dataTransfer.effectAllowed = "copy";
                  // The lanes draw the landing clip at its length while the drag hovers (issue 1035).
                  setLibraryDrag({ artifactId: item.drag, label: item.name, durationFrames: item.durationFrames });
                }}
                onDragEnd={() => setLibraryDrag(null)}
              >
                <button
                  type="button"
                  className="fy-artrow__pick"
                  aria-pressed={selected}
                  title={item.why ?? ([item.file, item.lane !== null ? `drag onto ${item.lane} to place` : null].filter((part) => part).join(" · ") || undefined)}
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
                    {item.placeAt && (
                      <button type="button" className="fy-tlbtn fy-tlbtn--text" onClick={item.placeAt}>
                        <Plus size={11} />
                        Place at playhead
                      </button>
                    )}
                    {item.add !== null && (
                      <button type="button" className="fy-tlbtn fy-tlbtn--text" onClick={item.add}>
                        {item.placeAt ? null : <Plus size={11} />}
                        {item.kind === "artifact" ? "Append to timeline" : "Add to timeline"}
                      </button>
                    )}
                    {item.overlay && <button type="button" className="fy-tlbtn fy-tlbtn--text" onClick={item.overlay}>Overlay at playhead</button>}
                    {item.uses.length > 0 && (
                      <button type="button" className="fy-tlbtn fy-tlbtn--text" onClick={() => locate(item)}>
                        <Locate size={11} />
                        Locate in timeline
                        {item.uses.length > 1 && <span className="fy-mono">{item.uses.length}</span>}
                      </button>
                    )}
                    {item.remove && <button type="button" className="fy-tlbtn fy-tlbtn--text" onClick={item.remove}>Remove from library</button>}
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
    // A desktop file is not an overlay. Left alone it goes on up to the chrome, which appends it
    // to the record (issue 1035); claimed here, it went nowhere, since the chrome stands down for
    // a drop a lane has answered.
    if (e.dataTransfer.files?.length) {
      setOver(null);
      return;
    }
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
              if (Array.from(e.dataTransfer.types).includes("Files")) return;
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
 * The lane gutter: the width of every track's label column, and the zero of every position
 * measured across the canvas. The ruler, the playhead and `.fy-track__label` have to agree on it
 * or the times printed are not the times drawn, so it is stated once and shared.
 */
export const LANE_GUTTER_PX = 88;

/** Where the playhead sits for a fraction of the film, in the one expression all of them use. */
function lanePosition(fraction: number): string {
  return `calc(${LANE_GUTTER_PX}px + (100% - ${LANE_GUTTER_PX}px) * ${Math.min(1, Math.max(0, fraction))})`;
}

/** The second of the film a pointer is over, for a box whose lanes start at the gutter. */
function secondsAtPointer(clientX: number, box: DOMRect, totalSec: number): number | null {
  const laneWidth = box.width - LANE_GUTTER_PX;
  if (laneWidth <= 0 || totalSec <= 0) return null;
  const laneX = Math.max(0, Math.min(clientX - box.left - LANE_GUTTER_PX, laneWidth));
  return (laneX / laneWidth) * totalSec;
}

/**
 * Press and drag to seek, from any surface that spans the lanes.
 *
 * The ruler and the playhead are the same gesture on two elements and they have to agree to the
 * pixel, so the arithmetic lives once. `laneOf` names what the fraction is measured across: the
 * ruler is its own box, the playhead is one pixel wide and has to ask the track stack.
 */
function seekDrag(opts: {
  totalSec: number;
  transport: Transport;
  laneOf: (target: HTMLElement) => HTMLElement | null;
  /** The ruler jumps to where it was pressed; the playhead is already under the hand. */
  seekOnPress: boolean;
}): (e: React.PointerEvent) => void {
  const { totalSec, transport, laneOf, seekOnPress } = opts;
  const { seek, setPlaying } = transport;
  return (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    const lane = laneOf(el);
    if (lane === null) return;
    // Or the press selects text across the lanes, and a drag that started on a clip label ends
    // up dragging the label instead of the transport. It costs the click its own focus, which
    // the arrow keys need, so the element asks for what the default would have given it.
    e.preventDefault();
    el.focus();
    el.setPointerCapture(e.pointerId);
    // Scrubbing while it runs fights the transport for the same value; stop, then seek.
    setPlaying(false);
    const to = (clientX: number) => {
      const at = secondsAtPointer(clientX, lane.getBoundingClientRect(), totalSec);
      if (at !== null) seek(at);
    };
    if (seekOnPress) to(e.clientX);
    const move = (ev: PointerEvent) => to(ev.clientX);
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
}

/** Arrow, Home and End on whichever of the two has focus: the same seek without a pointer. */
function seekKeys(transport: Transport, totalSec: number): (e: React.KeyboardEvent) => void {
  const { time, seek } = transport;
  return (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") seek(time + 1);
    else if (e.key === "ArrowLeft") seek(time - 1);
    else if (e.key === "Home") seek(0);
    else if (e.key === "End") seek(totalSec);
    else return;
    e.preventDefault();
  };
}

/** Label steps a person reads a timeline in; the first that leaves room for the text wins. */
const RULER_STEPS_SEC = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
/** Room for `mm:ss` and the air the design leaves around it. */
const RULER_LABEL_PX = 64;

/** Every second the ruler prints, at the design's regular interval rather than three fixed spots. */
export function rulerTicks(totalSec: number, laneWidthPx: number): number[] {
  if (totalSec <= 0 || laneWidthPx <= 0) return [];
  const step =
    RULER_STEPS_SEC.find((candidate) => (candidate / totalSec) * laneWidthPx >= RULER_LABEL_PX) ??
    RULER_STEPS_SEC[RULER_STEPS_SEC.length - 1]!;
  const ticks: number[] = [];
  for (let at = 0; at < totalSec; at += step) ticks.push(at);
  return ticks;
}

/**
 * Seek by dragging the ruler (24a's "1:26 / 2:40" made reachable).
 *
 * Proportional rather than pixels-per-second: the ruler spans the whole cut whatever the window
 * is doing, so the fraction of its width is the fraction of the film — the same arithmetic the
 * player dock already scrubs by.
 *
 * The times are printed where they are true. Three labels pushed apart by flex named zero, half
 * and the end, but drew them at the edges of their own text: the last sat a label's width short
 * of the end it named, and the middle landed wherever the other two left room. The design draws a
 * regular interval across the lanes and so does this, every label placed by the same expression
 * the playhead is, so a clip edge under the ruler's `0:20` is at twenty seconds.
 */
function CutScrubber({ totalSec, frameRate, transport }: { totalSec: number; frameRate: FrameRate; transport: Transport }) {
  const { time } = transport;
  const ref = useRef<HTMLDivElement>(null);
  const width = useMeasuredWidth(ref);
  const onPointerDown = seekDrag({ totalSec, transport, laneOf: (el) => el, seekOnPress: true });
  return (
    <div
      ref={ref}
      className="fy-timeline__ruler fy-scrub"
      onPointerDown={onPointerDown}
      onKeyDown={seekKeys(transport, totalSec)}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(totalSec)}
      aria-valuenow={Math.round(time)}
      aria-valuetext={formatTimecode(time, frameRate)}
    >
      {rulerTicks(totalSec, width - LANE_GUTTER_PX).map((at) => (
        <span key={at} className="fy-timeline__tick" style={{ left: lanePosition(at / totalSec) }}>
          <span className="fy-mono">{clock(at)}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * What a press on the track stack lands on, when it lands on something that owns the press.
 *
 * Clips are buttons, and so are the grips inside them and a lane's Mute and Solo, so one
 * `closest` covers most of it. The three that are not: a legacy overlay clip is a `div`, the
 * pinned label gutter is not lane at all (a press there means no second of the film), and the
 * new-lane strip is a drop target. The playhead's own band answers as a slider.
 */
const LANE_PRESS_OWNERS =
  "button, input, select, textarea, a, [role='slider'], .fy-ovclip, .fy-clipmenu, .fy-track__label, .fy-track--new";

/**
 * How near an edge the playhead may run before the canvas pages after it.
 *
 * A margin and not the edge itself: a playhead parked exactly on the boundary would page again
 * on the next frame, and a person watching wants to see what is about to happen as well as what
 * just did.
 */
const FOLLOW_MARGIN_PX = 56;

/**
 * Keep the running playhead on screen.
 *
 * Only where there is somewhere to scroll. At 1x the whole film is already in view and the
 * canvas has no business moving; `scrollWidth > clientWidth` is the zoom question asked of the
 * element rather than of the state, so a narrow window at 1x is covered by the same test.
 *
 * A page, not a glide. Pinning the playhead mid-canvas slides the whole timeline under somebody
 * trying to read a clip, which is worse than an occasional jump — and a jump is what every
 * editor that offers both defaults to.
 *
 * The leading margin clears the gutter, and that is not a detail (Codex review). The lane labels
 * are sticky and opaque, so on a scrolled canvas the leftmost thing a person can actually see is
 * the gutter's right edge, not the canvas's. A margin measured from the canvas paged the playhead
 * to a position underneath the labels — and left it there, because the next frame found the
 * margin satisfied and the line stayed hidden until it ran off the other end.
 */
export function followPlayhead(
  // Structural, and not `HTMLElement`: these four numbers are the whole of what the decision
  // reads, and saying so is what lets the decision be tested without a layout engine.
  line: { offsetLeft: number },
  canvas: { scrollWidth: number; clientWidth: number; scrollLeft: number },
): void {
  if (canvas.scrollWidth <= canvas.clientWidth) return;
  const at = line.offsetLeft;
  // What is left once the gutter has taken its share; a margin at each end of the rest.
  const visible = Math.max(0, canvas.clientWidth - LANE_GUTTER_PX);
  const margin = Math.min(FOLLOW_MARGIN_PX, visible / 4);
  const lead = LANE_GUTTER_PX + margin;
  if (at >= canvas.scrollLeft + lead && at <= canvas.scrollLeft + canvas.clientWidth - margin) return;
  canvas.scrollLeft = Math.max(0, at - lead);
}

/**
 * The playhead, and the thing a hand actually grabs.
 *
 * It was a one-pixel line under `pointer-events: none`, so the only way to move the transport was
 * the ruler — a 24-pixel strip above the lanes, which is what "only the top of it drags" meant.
 * The line is the obvious target and is one now: an invisible band rides with it, wide enough to
 * hit without aiming, and the head at the top is inside that band rather than a 7-pixel dot of
 * its own. The band is the only part that takes a pointer and it is only ever where the playhead
 * is, so a clip anywhere else on the lane is untouched by it.
 */
function CutPlayhead({ totalSec, frameRate, transport, tool }: { totalSec: number; frameRate: FrameRate; transport: Transport; tool: EditorTool }) {
  const { time, timeRef, playing } = transport;
  const line = useRef<HTMLDivElement>(null);
  /*
   * While it runs, the line is drawn on the frame clock and the canvas pages after it.
   *
   * `time` reaches React four times a second, which is right for the readout and wrong for the
   * playhead: a line advancing in quarter-second strides reads as a stutter against picture that
   * does not stutter. The position is written to the element from `timeRef` instead — the same
   * split the preview already uses to switch its source — and React's `time` stays what the
   * readout and the slider announce, because sixty ARIA updates a second help nobody.
   *
   * Nothing is restored on the way out. The element is React's again the moment the transport
   * stops, and `useTransport` flushes the true stop position before that paint.
   */
  useEffect(() => {
    const element = line.current;
    // The same guard `useTransport` keeps: a window without the frame clock leaves the playhead
    // on React's throttled value rather than throwing on the first frame.
    if (element === null || !playing || totalSec <= 0 || typeof requestAnimationFrame !== "function") return;
    const canvas = element.closest<HTMLElement>(".fy-timeline__canvas");
    let frame = 0;
    const loop = () => {
      element.style.left = lanePosition(timeRef.current / totalSec);
      if (canvas !== null) followPlayhead(element, canvas);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [playing, totalSec, timeRef]);
  const onPointerDown = seekDrag({
    totalSec,
    transport,
    laneOf: (el) => el.closest<HTMLElement>(".fy-tracks"),
    // Pressing the playhead grabs it where it is; jumping to the centre of the band would move
    // the transport by a few frames for a press that was meant to hold it still.
    seekOnPress: false,
  });
  return (
    <div ref={line} className="fy-playhead" style={{ left: lanePosition(time / totalSec) }}>
      <span
        // Blade cuts where it is pressed and Hand scrolls from under it; both want the lane the
        // band is sitting on, and neither is asking to move the transport. The band stands aside
        // for them rather than swallowing the one press the playhead happens to be over.
        className={cx("fy-playhead__grab", tool !== "select" && "fy-playhead__grab--idle")}
        onPointerDown={onPointerDown}
        onKeyDown={seekKeys(transport, totalSec)}
        role="slider"
        tabIndex={0}
        aria-label="Playhead"
        aria-valuemin={0}
        aria-valuemax={Math.round(totalSec)}
        aria-valuenow={Math.round(time)}
        aria-valuetext={formatTimecode(time, frameRate)}
      />
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
function NewLaneStrip({ onDrop, onFileDrop = null, fileKinds = null }: {
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
          <InspectorRow label="Take">{selectedTakeId ?? "no accepted take"}</InspectorRow>
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
function exportAudioStatus(plan: RenderPlan): string | null {
  if (plan.unmeasuredAudio?.length) return plan.audio.length === 0
    ? "No sound — video audio not measured"
    : "Some video sound is unavailable — measurement missing";
  return plan.audio.length === 0 ? "No sound — no audible audio in this cut" : null;
}

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

/**
 * The shot picker (SPEC-039 R-8, amended; issue 1033): scenes on the left, that scene's shots
 * on the right, each a checkbox. Shots are the one thing the Library curates — a cut brings
 * them in by scene — so this is what the picker is for and all it is for; every filed artifact
 * is already in the list behind it.
 */
function AddToLibraryDialog({
  open,
  production,
  library,
  onClose,
  onAdd,
}: {
  open: boolean;
  production: ProductionBundle | null;
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
  const asItem = (key: string): TimelineLibraryItem => ({ kind: "shot", shotId: key.slice(5) });
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
          {already ? (dropped.has(key) ? "leaves the library" : tone === "destructive" ? `${meta} · in the library` : "in the library") : meta}
        </span>
      </label>
    );
  };
  return (
    <EditorDialog open={open} title="Add shots to the library" onClose={dismiss} width={640} labelledBy="add-to-library-title">
      <div className="fy-libpick fy-libpick--shots">
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

/**
 * Whether desktop files are being dragged over the window, and what they say they are (issue
 * 1035). Read at the document so the whole Cut becomes a target the moment a file leaves
 * Explorer over it, not only the lane the pointer happens to cross. Enter and leave are counted
 * because every element on the way fires its own pair; a drag that ends outside the window
 * fires nothing at all, so a quiet spell with no dragover clears it too.
 */
function useFileDrag(): DroppedKind[] | null {
  const [kinds, setKinds] = useState<DroppedKind[] | null>(null);
  useEffect(() => {
    let depth = 0;
    let quiet: ReturnType<typeof setTimeout> | null = null;
    const clear = () => {
      depth = 0;
      if (quiet !== null) clearTimeout(quiet);
      quiet = null;
      setKinds(null);
    };
    const arm = () => {
      if (quiet !== null) clearTimeout(quiet);
      quiet = setTimeout(clear, 800);
    };
    const kindsOf = (event: Event): DroppedKind[] => {
      const transfer = (event as DragEvent).dataTransfer;
      return transfer ? fileKindsFromTransfer(transfer) : [];
    };
    const onEnter = (event: Event) => {
      const found = kindsOf(event);
      if (found.length === 0) return;
      depth += 1;
      setKinds((current) => (current !== null && current.join() === found.join() ? current : found));
      arm();
    };
    const onOver = (event: Event) => {
      if (kindsOf(event).length > 0) arm();
    };
    const onLeave = () => {
      if (depth > 0) depth -= 1;
      if (depth === 0) clear();
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", clear);
    window.addEventListener("dragend", clear);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", clear);
      window.removeEventListener("dragend", clear);
      if (quiet !== null) clearTimeout(quiet);
    };
  }, []);
  return kinds;
}

export function CutScreen() {
  const { worldId, prodId } = useParams();
  const { connection, state: studio } = useStore();
  const worlds = studio?.worlds ?? [];
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
            ? resolvePictureTimeline(production, { status: "ready", timeline: seedFirstPictureTimeline(production) }, world?.artifacts ?? [])
            : resolvePictureTimeline(production, timelineState, world?.artifacts ?? []);
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
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [showScenes, setShowScenes] = useState(false);
  const [importing, setImporting] = useState(false);
  const importRequest = useRef<string | null>(null);
  /** Dropped files, listed in the Library as rows until they are real (issue 1035). */
  const [pendingImports, setPendingImports] = useState<PendingImport[]>([]);
  const fileKinds = useFileDrag();
  useEffect(() => {
    importRequest.current = null; setImporting(false); setPendingImports([]);
    return subscribeQueueResults(result => {
      // A file that landed is a row of its own now; only the ones that did not keep their rows
      // and their reasons. A refusal of the whole request names every file.
      setPendingImports(current => current.flatMap(pending => {
        if (pending.requestId !== result.requestId) return [pending];
        if (result.failures.length === 0) return [];
        const whole = result.disposition === "rejected" && result.failures.length === 1 && pending.files.length > 1;
        if (whole) return [{ ...pending, failures: pending.files.map((_, index) => ({ index, reason: result.failures[0]!.reason })) }];
        const kept = result.failures.flatMap(failure => {
          const file = pending.files[failure.index];
          return file === undefined ? [] : [{ file, reason: failure.reason }];
        });
        return kept.length === 0 ? [] : [{ ...pending, files: kept.map(entry => entry.file), failures: kept.map((entry, index) => ({ index, reason: entry.reason })) }];
      }));
      if (result.requestId !== importRequest.current) return;
      importRequest.current = null; setImporting(false);
      setTimelineCommandError(result.failures.length ? result.failures.map(failure => failure.reason).join(" ") : null);
    });
  }, [worldId, prodId]);
  useEffect(() => {
    if (connection === "open" || importRequest.current === null) return;
    importRequest.current = null; setImporting(false);
    setPendingImports(current => current.map(pending => pending.failures === null
      ? { ...pending, failures: pending.files.map((_, index) => ({ index, reason: "connection lost" })) } : pending));
    setTimelineCommandError("Connection lost during import. Reconnect and check the Library before importing again.");
  }, [connection]);
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
    cut !== null && view.kind === "scene-order" && (production?.scenes ?? []).every((scene) => orderedShots(scene).length === 0);
  /*
   * Resolved exactly as the coordinator resolves them, because the screen must not advertise a
   * film the export will not produce: `exportOverlays` drops a document or a missing artifact and
   * `exportAudioClips` drops a video not known to carry sound, so measuring raw lane records
   * would let a document stretched to 60s claim a film that encodes as five seconds.
   */
  // The production's own view of the world's files (SPEC-020 R-13): another production's scoped media stays out of this Library and picker.
  const artifacts = artifactsForProduction(world?.artifacts ?? [], prodId);
  // A placed file is named the way the Artifacts page names it (issue 1005): by what it is
  // linked to, and by its file only when nothing names it.
  const linkName = useMemo(() => linkNameResolver(world), [world]);
  const nameOf = (artifact: ArtifactSidecar): string => artifactDisplayName(artifact, linkName);
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
  const previewState: typeof timelineState = useMemo(
    () =>
      production && timelineState.status === "absent" && production.spine === null && !mediaOnly
        ? { status: "ready", timeline: seedFirstPictureTimeline(production) }
        : timelineState,
    [production, timelineState.status, mediaOnly],
  );
  /*
   * Memoised, and the identity matters as much as the cost.
   *
   * The transport reports four times a second, so this ran four times a second for the whole
   * length of every film — resolving the picture timeline, building every overlay and merging
   * the speech regions, none of which had changed. Worse than the work was the churn: the plan
   * is what the monitor mix, the preview's spans and the cue lookup are keyed on, and a fresh
   * object each render restarted all three. The sound heard that as four pause/play cycles a
   * second. The inputs below are the only things the plan is made of, and each of them is either
   * a snapshot the store replaces or a value the screen chooses.
   */
  const planArtifacts = world?.artifacts;
  const subtitleHidden = subtitleTracks.some((track) => track.id === subtitleView && track.muted);
  const renderPlan = useMemo(
    () =>
      production && (!production.spine || timelineState.status === "ready") && timelineError === null
        ? buildRenderPlan({
            production,
            artifacts: planArtifacts ?? [],
            timeline: previewState,
            scope: { kind: "production" },
            preset: "review-cut",
            // A hidden (muted) track is not asked for: the plan would refuse it and take the whole
            // preview with it (round nine). Hiding captions leaves the film.
            ...(subtitleView !== null && !subtitleHidden ? { subtitles: { trackId: subtitleView, mode: "none" as const } } : {}),
          })
        : null,
    [production, planArtifacts, previewState, timelineState.status, timelineError, subtitleView, subtitleHidden],
  );
  /*
   * A plan the projection refuses — a placed artifact the world no longer has, say — blocks the
   * preview and the export by name, and nothing else (SPEC-039 R-39, R-40): the editor stays
   * editable so the clip can be removed, and Undo still works. Only an invalid or unresolvable
   * timeline record blocks editing.
   */
  const renderError = renderPlan !== null && !renderPlan.ok ? renderPlan.reason : view.kind === "unavailable" && timelineState.status !== "ready" ? view.reason : null;
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
  /** Keyed on the plan, so the preview's frame loop restarts when the film changes and not before. */
  const spans = useMemo(
    () => (spineCut ? spineSpans(spineCut) : renderPlan?.ok ? planSpans(renderPlan.plan) : []),
    [spineCut, renderPlan],
  );
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
  // Allocation must reserve the same legacy ids the first coordinator write migrates.
  const placementTimeline = editableTimeline && production ? migrateLegacyCut(editableTimeline, production, world?.artifacts ?? []).timeline : null;
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
  /*
   * The strip under a clip reads its in-point from the resolver's entry, and a live head trim
   * shows the draft: resolved from the saved record, the entry would name the old in-point until
   * the command round-trips, and the strip would go on showing frames before the new head. So a
   * draft or a ghost is resolved too, at the record's own cost; the saved cut stands in if the
   * resolver refuses it.
   */
  let shownCut = cut;
  if (production && shownTimeline && shownTimeline !== editableTimeline && cut !== null && !(production.spine && timelineState.status !== "ready")) {
    try {
      shownCut = resolvePictureTimeline(production, { status: "ready", timeline: shownTimeline }, world?.artifacts ?? []);
    } catch {
      shownCut = cut;
    }
  }
  const views = shownTimeline ? pictureClipViews(shownTimeline, shownCut, artifacts, nameOf) : [];
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
    ? `${runtimeSeconds(spineCut.trackDurationSec)} · ${runtimeSeconds(spineCut.trackDurationSec - spineCut.blackSec)} of ${runtimeSeconds(spineCut.trackDurationSec)} covered · cut to the track`
    : mediaOnly
      ? `${runtimeSeconds(filmSec)} · no story · what you place is the film`
      : cut
        ? `${runtimeSeconds(cut.totalSec)} · ${cut.covered} of ${storyShotCount(production)} shots covered · ${production?.spine ? "cut to the track" : timelineState.status === "ready" ? "saved timeline" : "nothing saved yet"}`
        : "";
  const selectedPictureClip =
    activeSelection?.kind === "picture"
      ? (orderedPictureClips.find((clip) => clip.id === activeSelection.id) ?? null)
      : null;
  const selectedAny = activeSelection?.kind === "picture" ? (allClips.find(({ clip }) => clip.id === activeSelection.id) ?? null) : null;
  // The selection as the lanes draw it right now — the draft under a grip — so the Inspector's
  // timing rows move with the hand rather than freezing until release (issue 1036).
  const shownClips = shownTimeline ? shownTimeline.tracks.flatMap((track) => track.clips.map((clip) => ({ clip, track }))) : allClips;
  const shownSelected = activeSelection?.kind === "picture" ? (shownClips.find(({ clip }) => clip.id === activeSelection.id) ?? selectedAny) : null;
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
    importing ||
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
  const importMedia = (destination: MediaDestination, files?: File[]) => {
    if (commandsDisabled || !worldId || !prodId || !fence) return;
    setTimelineCommandError(null);
    const result = importEditorMedia(worldId, { productionId: prodId, baseRevision: timelineRevision, sourceFingerprint: fence, destination }, files);
    importRequest.current = result.requestId; setImporting(result.requestId !== null);
    if (result.reason) setTimelineCommandError(result.reason);
    if (result.requestId !== null && files !== undefined && files.length > 0) {
      const requestId = result.requestId;
      setPendingImports((current) => [...current, { requestId, files: files.map((file) => ({ name: file.name, sizeBytes: file.size })), failures: null, destination }]);
    }
  };
  /** Copy a file from another world into this one and list it (issue 1033); answered like an upload. */
  const borrow = (slug: string, file: string) => {
    if (commandsDisabled || !worldId || !prodId || !fence) return;
    setTimelineCommandError(null);
    const result = borrowArtifacts(worldId, slug, [file], { productionId: prodId, baseRevision: timelineRevision, sourceFingerprint: fence, destination: "library" });
    importRequest.current = result.requestId; setImporting(result.requestId !== null);
    if (result.reason) setTimelineCommandError(result.reason);
    if (result.requestId !== null) {
      const requestId = result.requestId;
      setPendingImports((current) => [...current, { requestId, files: [{ name: file, sizeBytes: 0 }], failures: null, destination: "library" }]);
    }
  };
  /** The frame a point on a lane strip names, the same arithmetic the lanes use. */
  const stripFrame = (laneWidth: number, x: number): number => Math.max(0, Math.round((x / Math.max(laneWidth, 1)) * Math.max(totalFrames, 1)));
  const appendArtifact = (artifact: ArtifactSidecar) => {
    if (!editableTimeline) return;
    try { sendCommands(mediaPlacementCommands(placementTimeline ?? editableTimeline, [artifact], "append", mintClipId), "Append media"); }
    catch (error) { setTimelineCommandError(error instanceof Error ? error.message : String(error)); }
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
  /** Every edge a drag can land against while Snap is on (issue 1034): clip edges on every lane, the playhead, zero. */
  const snapFrames = snap && shownTimeline ? (except: TimelineClipId) => snapCandidates(shownTimeline.tracks, playheadFrame, except) : null;
  /** The viewer follows an edge in hand (issue 1036): one seek per frame the edge crosses. */
  const scrubTo = (frame: number) => transport.seek(frame / frameRate);
  /** A press on empty lane, measured across the track stack the same way the ruler measures itself. */
  const seekFromLane = seekDrag({ totalSec, transport, laneOf: (element) => element, seekOnPress: true });
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
  const placeArtifact = (artifact: ArtifactSidecar, trackId: TimelineTrackId | null, frame: number,
    options: { kind?: "picture" | "audio"; newTrack?: boolean } = {}) => {
    if (!editableTimeline) return;
    const still = artifact.kind === "image" || artifact.kind === "board";
    const duration = still ? CLIP_DEFAULT_SEC : artifact.mediaInfo?.durationSec;
    if (!duration) { setTimelineCommandError("Measure this media before placing it."); return; }
    const durationFrames = Math.max(1, secondsToFrames(duration, frameRate));
    const kind = options.kind ?? (artifact.kind === "audio" ? "audio" : "picture");
    let track = trackId ? editableTimeline.tracks.find(candidate => candidate.id === trackId) : undefined;
    if (!track && !options.newTrack) track = editableTimeline.tracks.find(candidate => candidate.kind === kind && candidate.id !== basePictureTrack(editableTimeline)?.id &&
      !candidate.clips.some(clip => clip.startFrame < frame + durationFrames && clip.startFrame + clip.durationFrames > frame));
    const sound = track ? AUDIO_TRACK_KINDS.has(track.kind) : kind === "audio";
    if (sound ? !(artifact.kind === "audio" || artifact.kind === "video" && artifact.mediaInfo?.hasAudio) : !(still || artifact.kind === "video")) {
      setTimelineCommandError(sound ? "This media has no measured sound." : "This media has no picture."); return;
    }
    const commands: TimelineClipCommand[] = [];
    // The Library lists every file already (issue 1033); the record's set follows what is placed,
    // so Arke and the Artifacts page still see which files this cut has taken up.
    if (!editableTimeline.library.some((item) => item.kind === "artifact" && item.artifactId === artifact.id)) {
      commands.push({ kind: "add-to-library", items: [{ kind: "artifact", artifactId: artifact.id }] });
    }
    let target = track?.id;
    if (!target) {
      if (sound) { const added = newAudioTrack(placementTimeline ?? editableTimeline); commands.push(added); target = added.trackId; }
      else {
        let number = 1; while (editableTimeline.tracks.some(candidate => candidate.id === 'tr_overlay-' + number)) number++;
        target = ('tr_overlay-' + number) as TimelineTrackId;
        commands.push({ kind: "add-track", trackId: target, trackKind: "picture", name: "Overlay " + number });
      }
    }
    const placedId = mintClipId();
    commands.push({ kind: "place", trackId: target, clip: { id: placedId, startFrame: frame, durationFrames, sourceInFrames: 0,
      source: { kind: "artifact", artifactId: artifact.id, label: artifact.file.split("/").pop() ?? artifact.file },
      ...(sound ? { gainDb: 0 } : artifact.kind === "video" ? { audio: "keep" as const } : {}),
    } });
    sendCommands(commands, "Place media"); pendingSelect.current = placedId;
  };
  /** The base track's click path (issue 1033): the file lands at the playhead, sliding past the clip under it as a shot does. */
  const placeAtPlayhead = (artifact: ArtifactSidecar) => {
    if (!editableTimeline) return;
    const base = basePictureTrack(editableTimeline);
    if (base === null) return;
    const still = artifact.kind === "image" || artifact.kind === "board";
    const seconds = still ? CLIP_DEFAULT_SEC : artifact.mediaInfo?.durationSec;
    if (!seconds) { setTimelineCommandError("Measure this media before placing it."); return; }
    const durationFrames = Math.max(1, secondsToFrames(seconds, frameRate));
    let startFrame = playheadFrame;
    for (const clip of orderedTrackClips(base)) {
      if (clip.startFrame < startFrame + durationFrames && clip.startFrame + clip.durationFrames > startFrame) startFrame = clip.startFrame + clip.durationFrames;
    }
    placeArtifact(artifact, base.id, startFrame);
  };
  /** A record entry for media the world lost or cannot use here comes off the Library by hand. */
  const removeFromLibrary = (item: TimelineLibraryItem) => sendCommands([{ kind: "remove-from-library", items: [item] }], "Remove from the library");
  const placeVoiceTake = (take: Take, shot: Shot, sceneNumber: number) => {
    if (!editableTimeline || !production) return;
    const measured = production.takeMediaInfo?.[take.id]?.mediaInfo.durationSec;
    const durationFrames = Math.max(1, secondsToFrames(measured ?? CLIP_DEFAULT_SEC, frameRate));
    const audioTracks = [...(placementTimeline ?? editableTimeline).tracks].sort((a, b) => a.order - b.order)
      .filter(track => AUDIO_TRACK_KINDS.has(track.kind) && !track.muted);
    const dialogue = audioTracks.find(track => track.kind === "audio" || track.kind === "dialogue") ??
      audioTracks.find(track => !track.clips.some(clip => clip.startFrame < playheadFrame + durationFrames && clip.startFrame + clip.durationFrames > playheadFrame)) ?? null;
    const commands: TimelineCommand[] = [];
    let fresh: TimelineTrackId = "tr_audio-1";
    if (dialogue === null) { const added = newAudioTrack(placementTimeline ?? editableTimeline); fresh = added.trackId; commands.push(added); }
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
        gainDb: 0, role: "dialogue",
      },
    });
    sendCommands(commands, `Place line SH ${shot.number}`);
    pendingSelect.current = id;
  };
  const laneKindFor = (artifact: ArtifactSidecar): "picture" | "audio" => (artifact.kind === "audio" ? "audio" : "picture");
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
    const base = basePictureTrack(editableTimeline);
    if (base === null) return;
    let startFrame = frameWanted;
    for (const clip of orderedTrackClips(base ?? { clips: [] })) {
      if (clip.startFrame < startFrame + durationFrames && clip.startFrame + clip.durationFrames > startFrame) startFrame = clip.startFrame + clip.durationFrames;
    }
    sendCommands(
      [
        {
          kind: "place",
          trackId: base.id,
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
  const importsInFlight = pendingImports.filter((pending) => pending.failures === null);
  const picturePending = importsInFlight.find((pending) => typeof pending.destination === "number");
  const pendingSlot = picturePending ? { frame: picturePending.destination as number, label: picturePending.files[0]?.name ?? "import" } : null;
  const pendingLaneSlots = importsInFlight.flatMap((pending) =>
    typeof pending.destination === "object" && "trackId" in pending.destination
      ? [{ trackId: pending.destination.trackId, frame: pending.destination.frame, label: pending.files[0]?.name ?? "import" }]
      : []);
  const totalFrames = Math.max(
    secondsToFrames(totalSec, frameRate),
    views.reduce((end, view) => Math.max(end, view.clip.startFrame + view.clip.durationFrames), 0),
    ...(shownTimeline?.tracks
      .filter((track) => track.kind === "picture")
      .flatMap((track) => track.clips.map((clip) => clip.startFrame + clip.durationFrames)) ?? []),
  );

  return (
    <div className="fy-cutcols" data-screen="cut"
      // A lane or the Library that took or refused the drag has spoken (issue 1035): its
      // dropEffect stands. What is left is a file over the chrome, which appends — while the
      // record can take it; otherwise the cursor must not promise a copy nothing will make.
      onDragOver={event => {
        if (event.defaultPrevented || commandsDisabled || !Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault(); event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={event => {
        if (event.defaultPrevented || commandsDisabled || !event.dataTransfer.files?.length) return;
        event.preventDefault(); importMedia("append", Array.from(event.dataTransfer.files));
      }}>
      <ArtifactPanel
        worldId={worldId}
        artifacts={world?.artifacts ?? []}
        slug={slug}
        production={production}
        timeline={editableTimeline}
        playheadFrame={playheadFrame}
        usedArtifactIds={usedArtifactIds}
        usedShotIds={usedShotIds}
        library={libraryItems}
        linkName={linkName}
        fileKinds={fileKinds}
        pendingImports={pendingImports}
        onDismissImport={(requestId, index) => setPendingImports((current) => current.flatMap((pending) => {
          if (pending.requestId !== requestId) return [pending];
          // One row, not the request: a batch with several failures keeps the others until each is read.
          const files = pending.files.filter((_, at) => at !== index);
          if (files.length === 0) return [];
          const failures = pending.failures === null ? null : pending.failures
            .filter((failure) => failure.index !== index)
            .map((failure) => (failure.index > index ? { ...failure, index: failure.index - 1 } : failure));
          return [{ ...pending, files, failures }];
        }))}
        onOpenPicker={editableTimeline !== null && !commandsDisabled ? () => setPickerOpen(true) : null}
        onAddLine={editableTimeline !== null && !commandsDisabled ? placeVoiceTake : null}
        onAddArtifact={commandsDisabled ? null : appendArtifact}
        onPlaceAtPlayhead={commandsDisabled ? null : placeAtPlayhead}
        worlds={worlds}
        onBorrow={commandsDisabled ? null : borrow}
        onOverlayArtifact={commandsDisabled ? null : artifact => placeArtifact(artifact, null, playheadFrame, { kind: "picture" })}
        onRemoveFromLibrary={commandsDisabled ? null : removeFromLibrary}
        onImport={commandsDisabled ? null : files => importMedia("library", files)}
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
          <button type="button" className="fy-tlbtn fy-tlbtn--text" disabled={commandsDisabled} onClick={() => importMedia("append")}><Upload size={12} />{importing ? "Importing…" : "Import media"}</button>
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
          <Button size="sm" onClick={() => setWatchToken((n) => n + 1)}>
            <Play size={12} />
            Watch from top
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={timelineError !== null || renderError !== null}
            onClick={() => setExportOpen(true)}
          >
            <Download size={12} />
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
            {/* A control that renames itself after whichever tab was last open cannot be
                learned: it read `Inspector` on the day you wanted Arke (turn 122). */}
            Details
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
            {/*
              One register (issue 1010, U1). Half this strip was glyphs with a tooltip and half
              was words, so the same press cost twice the width depending on which half it landed
              in — and the reader had to learn two ways of being told what a control does. Every
              control here is now a glyph of the same size with the word in its tip.
            */}
            <button type="button" className="fy-tlbtn fy-tip" data-tip="Add audio track" aria-label="Add audio track" disabled={commandsDisabled} onClick={() => editableTimeline && sendCommands([newAudioTrack(placementTimeline ?? editableTimeline)], "Add audio track")}>
              <AudioPlus size={12} />
            </button>
            <button type="button" className="fy-tlbtn fy-tlbtn--toggle fy-tip" data-tip="Scene labels" aria-label="Scene labels" aria-pressed={showScenes} onClick={() => setShowScenes(value => !value)}>
              <Tag size={12} />
            </button>
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
                className="fy-tlbtn fy-tip"
                data-tip={sourceFingerprint === null ? "Open on the timeline · measure the master track first" : "Open on the timeline"}
                aria-label="Open on the timeline"
                disabled={commandPending || sourceFingerprint === null || !worldId || !prodId}
                onClick={openOnTimeline}
              >
                <Film size={12} />
              </button>
            )}
            {editableTimeline !== null && (
              <span className="fy-timeline__group" role="group" aria-label="Edit">
                <button
                  type="button"
                  className="fy-tlbtn fy-tip"
                  data-tip={playheadInsideSelected ? "Split at the playhead · S" : "Move the playhead over the selected clip to split it"}
                  aria-label="Split"
                  disabled={commandsDisabled || !playheadInsideSelected}
                  onClick={() => selectedAction("split")}
                >
                  <SplitMark size={12} />
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
            <button type="button" className="fy-tlbtn fy-tlbtn--toggle fy-tip" data-tip="Snap to clip boundaries" aria-label="Snap" aria-pressed={snap} onClick={() => setSnap((on) => !on)}>
              <Snap size={12} />
            </button>
            {editableTimeline !== null && (
              <button
                type="button"
                className="fy-tlbtn fy-tlbtn--toggle fy-tip"
                data-tip="Duck · Music and Ambience lower under Voice clips"
                aria-label="Duck"
                aria-pressed={editableTimeline.mix.speechFirst}
                disabled={commandsDisabled}
                onClick={() => sendCommands([{ kind: "set-mix", mix: { speechFirst: !editableTimeline.mix.speechFirst } }], editableTimeline.mix.speechFirst ? "Duck off" : "Duck on")}
              >
                <Duck size={12} />
              </button>
            )}
            <button type="button" className="fy-tlbtn fy-tlbtn--help fy-tip" data-tip="Keyboard shortcuts · ?" aria-label="Keyboard shortcuts" aria-pressed={keysOpen} onClick={() => setKeysOpen((open) => !open)}>
              <Help size={12} />
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
          {timelineCommandError && (
            <div className="fy-timeline__refusal" role="alert">Edit refused · {timelineCommandError}</div>
          )}
          <div
            className="fy-timeline__canvas"
            onClick={(event) => {
              const target = event.target as HTMLElement;
              /*
               * Moving the transport is not deselecting (Codex review).
               *
               * `preventDefault` on the press stops the compatibility mouse events but not the
               * click, so a press on the ruler or the playhead still arrives here — and cleared
               * the selection. That breaks the one flow the Split button's own tooltip describes:
               * select a clip, bring the playhead inside it, split. The clip was deselected by
               * the act of bringing the playhead there, and Split was disabled by the time it
               * was reached. Pressing empty lane still clears, because that is the gesture this
               * handler is for; the two surfaces that exist to move the clock are not it.
               */
              if (target.closest(".fy-cutseg, .fy-ovclip, .fy-typedclip, .fy-clipmenu, .fy-trackbtns, .fy-playhead, .fy-scrub")) return;
              setSelected(null);
            }}
          >
            <div className="fy-timeline__zoomwrap" style={{ width: `${zoom * 100}%` }}>
            <CutScrubber
              totalSec={totalSec}
              frameRate={frameRate}
              transport={transport}
            />
            {/*
              * Pressing the lanes moves the playhead.
              *
              * Every other editor puts the transport where you press, and this one offered only
              * the 24px ruler and the line itself — so reaching a moment meant aiming at a strip
              * above the work rather than at the work. The press is read here and not on each
              * lane because the lanes are seven components and the answer is the same on all of
              * them: whatever owns the press keeps it, and the gap between clips is timeline,
              * which is a time.
              */}
            <div
              className="fy-tracks"
              onPointerDown={(event) => {
                if (event.button !== 0 || tool !== "select") return;
                if ((event.target as HTMLElement).closest(LANE_PRESS_OWNERS) !== null) return;
                // The canvas already clears the selection on a click in empty space; doing it
                // here too keeps the two agreeing when the press becomes a drag and no click
                // follows it.
                setSelected(null);
                seekFromLane(event);
              }}
            >
              {totalSec > 0 && <CutPlayhead totalSec={totalSec} frameRate={frameRate} transport={transport} tool={tool} />}
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
                    {showScenes && <SceneBands views={views} totalFrames={totalFrames} />}
                    <PictureTrack
                      production={production ?? undefined}
                      artifacts={world?.artifacts ?? []}
                      onFileDrop={(files, frame) => importMedia(frame, files)}
                      onScrub={scrubTo}
                      snapFrames={snapFrames}
                      fileKinds={fileKinds}
                      pendingSlot={pendingSlot}
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
                              const base = editableTimeline ? basePictureTrack(editableTimeline) : null;
                              if (artifact && base) placeArtifact(artifact, base.id, drop.frame);
                            },
                          })}
                    />
                    <TypedTrackRows
                      production={production ?? undefined}
                      artifacts={world?.artifacts ?? []}
                      slug={slug}
                      nameOf={nameOf}
                      onScrub={scrubTo}
                      snapFrames={snapFrames}
                      fileKinds={fileKinds}
                      pendingSlots={pendingLaneSlots}
                      onFileDrop={commandsDisabled ? undefined : (files, trackId, frame) => importMedia({ trackId, frame }, files)}
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
              {editableTimeline && (
                <NewLaneStrip
                  onDrop={commandsDisabled ? null : dropOnNewLane}
                  onFileDrop={commandsDisabled ? null : (files, laneWidth, x) => importMedia({ newTrack: true, frame: stripFrame(laneWidth, x) }, files)}
                  fileKinds={fileKinds}
                />
              )}
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
                    ? `${cut.covered} of ${storyShotCount(production)} shots placed · ${cut.gaps} gap${cut.gaps === 1 ? "" : "s"}`
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
                    {cut.gaps} gap{cut.gaps === 1 ? "" : "s"} · {runtimeSeconds(cut.uncoveredSec)} uncovered
                  </span>
                )}
          </div>
        </section>
        {/* The timeline animates with transform and clips overflow; fixed sheets must be its
            siblings or the browser confines them to the timeline instead of the viewport. */}
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
      </main>
      <aside ref={rightPanelRef} className="fy-cutside" id="cut-right-pane" data-open={rightOpen} aria-label="Editor details">
        {/*
          Inspector and Arke stack rather than tabbing (design turn 122). Tabs assert that two
          things are alternatives; a property sheet scoped to the selection and a collaborator
          scoped to the whole cut are not, and tabbing them means consulting one costs the other
          at exactly the moment both are wanted — a clip selected, and something to say about it.

          The Inspector is capped at half the edge and scrolls inside it, so a selection with a
          lot to author can never push the composer off the screen: it is the one control here
          that must not need scrolling to reach.
        */}
        <div className="fy-cutside__head">
          <span className="fy-cutside__headlabel">Details</span>
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
        <div className="fy-cutside__panel fy-cutside__panel--inspect" id="cut-inspector-panel">
            <CutInspector
              worldId={worldId}
              prodId={prodId}
              production={production}
              cut={cut}
              spineCut={spineCut}
              artifacts={world?.artifacts ?? []}
              selection={activeSelection}
              selectedClip={shownSelected?.clip ?? null}
              selectedTrack={shownSelected?.track ?? null}
              nameOf={nameOf}
              onScrub={scrubTo}
              timeline={editableTimeline}
              subtitleView={subtitleView}
              onViewSubtitles={setSubtitleChoice}
              onTranscribe={timelineRevision !== null && !commandsDisabled ? transcribe : null}
              savedPictureOrder={timelineState.status === "ready"}
              frameRate={frameRate}
              commandsDisabled={commandsDisabled}
              onCommands={sendCommands}
              onFill={(clipId) => {
                selectPicture(clipId);
                const clip = allClips.find((candidate) => candidate.clip.id === clipId);
                if (clip) transport.seek(clip.clip.startFrame / frameRate);
              }}
              mintClipId={mintClipId}
              sourceLength={sourceLength}
            />
          </div>
        <div className="fy-cutside__panel fy-cutside__panel--arke" id="cut-arke-panel">
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

export { Mentions } from "../components/mentions.js";
export { Wave } from "../components/wave.js";
export { takeMediaView, takeMediaPath, lookPickerLabels, lookOptionScope, filterTakeEpisodes, GenerateScreen, passRow, VoiceLineDialogScreen } from "./production-generate.js";
export { episodeThumbnailPath, defaultEpisodeFor, ProductionLayout, ProductionHomeScreen, ProductionDashboardScreen, ProductionChatScreen } from "./production-shell.js";
export { sceneFileOf, useNewScene, useNewChapter, StoryScreen, ChapterTreeScreen, ScenesScreen, SceneDetailScreen } from "./production-story.js";
export { ProductionCastScreen, carriedSubjects } from "./production-cast.js";
