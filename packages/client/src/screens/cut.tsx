import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import {
  CLIP_DEFAULT_SEC,
  deriveCut,
  MEDIA_CANVAS_HEADROOM_SEC,
  type MediaDestination,
  productionFrameRate,
  type ProductionTimeline,
  resolvePictureTimeline,
  previewEditorRequest,
  editorRequestStaleness,
  timelineSourceFingerprint,
  storyTimelineFingerprint,
  type FrameRate,
  type ResolvedPictureCut,
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
  orderedTrackClips,
  secondsToFrames,
  sourceLengthFramesFor,
  storyOrderDrift,
  ulid,
  AUDIO_TRACK_KINDS,
  cueAtSec,
  type ArtifactSidecar,
  orderedShots,
} from "@arke-studio/contracts";
import { Button } from "../components/ui.js";
import {
  AudioPlus,
  ChevronLeft,
  ChevronRight,
  Collapse,
  Copy,
  Download,
  Duck,
  Film,
  Hand,
  Help,
  Minus,
  Play,
  Plus,
  Pointer,
  RotateCcw,
  RotateCw,
  Scissors,
  Snap,
  Sparkle,
  SplitMark,
  Tag,
  Trash,
  Upload,
} from "../components/icons.js";
import { EDITOR_KEYS, EditorDialog } from "../components/editor-dialog.js";
import { ProductionConversation } from "../components/conversation.js";
import { mediaUrl } from "../lib/media.js";
import { runtimeSeconds, seconds } from "../lib/format.js";
import { artifactDisplayName, artifactsForProduction, linkNameResolver } from "../lib/artifact-view.js";
import {
  useProduction,
} from "../lib/selectors.js";
import { spineSpans } from "../lib/cut-playback.js";
import { planSpans } from "../lib/plan-playback.js";
import { editorTimeline } from "../lib/editor-timeline.js";
import {
  PictureTrack,
  pictureClipViews,
  type EditorTool,
} from "./editor-timeline.js";
import { TypedTrackRows, type TrackDrop } from "./editor-audio.js";
import { fileKindsFromTransfer, snapCandidates, type DroppedKind } from "../lib/clip-gesture.js";
import { SubtitleTrackRow, subtitleTracksOf } from "./editor-subtitles.js";
import { EditorRequestCards } from "./editor-requests.js";
import { usePlanAudio } from "../lib/plan-audio.js";
import {
  moveTimelineHistory,
  moveTimelinePictureClip,
  sendTimelineAssemble,
  sendTimelineCommands,
  decideEditorRequest,
  sendTimelineTranscribe,
  importEditorMedia,
  useStore,
  subscribeQueueResults,
  borrowArtifacts,
  subscribeTimelineRefusals,
} from "../lib/store.js";
import { storyShotCount } from "./production-story.js";
import { type PendingImport, type LibraryFilter, ArtifactPanel, AddToLibraryDialog, LIBRARY_DRAWER_QUERY } from "./editor-library.js";
import { seekDrag, CutScrubber, LANE_PRESS_OWNERS, CutPlayhead, useCutTransport } from "./editor-transport.js";
import { CutPreview } from "./editor-preview.js";
import { SpineCutTrack, EmptyEditorTrack, NewLaneStrip, SceneBands } from "./editor-tracks.js";
import { type CutSelection, CutInspector } from "./editor-inspector.js";
import { ExportSheet, exportViewFor } from "./editor-export.js";
import { ABSENT_TIMELINE, useRenderPlan } from "./editor-plan.js";

function focusFirstControl(pane: HTMLElement | null): void {
  pane?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), [href], [tabindex='0']")?.focus();
}

function editorMediaMatches(query: string): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
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
  const timelineState = production?.timeline ?? ABSENT_TIMELINE;
  const frameRate: FrameRate = production ? productionFrameRate(production.meta) : 24;
  /*
   * The record the editor edits (`lib/editor-timeline.ts`): the saved timeline, or — until the
   * first write saves one — the fold that write will make, projected in memory so a legacy
   * placement is already a typed clip with the id the fold reserves for it (issue 1159). Null
   * for a song not yet opened on the timeline (SPEC-037 A-12) and for an invalid record.
   *
   * Memoised on the snapshot and the catalog it is made from, because the plan, the preview's
   * spans and the monitor mix are keyed on its identity: re-seeding it on the transport's clock
   * would rebuild all three four times a second (issue 1158). The seed can refuse — a story
   * order that repeats a shot — and the refusal is the timeline's error, stated below by name.
   */
  const worldArtifacts = world?.artifacts;
  const edited = useMemo((): { timeline: ProductionTimeline | null; error: string | null } => {
    if (!production) return { timeline: null, error: null };
    try {
      return { timeline: editorTimeline(production, production.timeline ?? ABSENT_TIMELINE, worldArtifacts ?? []), error: null };
    } catch (error) {
      return { timeline: null, error: error instanceof Error ? error.message : String(error) };
    }
  }, [production, worldArtifacts]);
  const editableTimeline = edited.timeline;
  let cut: ResolvedPictureCut | null = null;
  let timelineError: string | null = edited.error;
  if (production && timelineError === null) {
    try {
      if (timelineState.status === "invalid") throw new Error(timelineState.message);
      // The song clock derives its picture until its timeline is saved (SPEC-037 §2.3); from then
      // on it reads the saved order like every other production, with the master as a Music clip.
      cut =
        editableTimeline === null
          ? deriveCut(production)
          : resolvePictureTimeline(production, { status: "ready", timeline: editableTimeline }, world?.artifacts ?? []);
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
      if (libraryOpen && editorMediaMatches(LIBRARY_DRAWER_QUERY)) {
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
  // The production's own view of the world's files (SPEC-020 R-13): another production's scoped media stays out of this Library and picker.
  const artifacts = artifactsForProduction(world?.artifacts ?? [], prodId);
  // A placed file is named the way the Artifacts page names it (issue 1005): by what it is
  // linked to, and by its file only when nothing names it.
  const linkName = useMemo(() => linkNameResolver(world), [world]);
  const nameOf = (artifact: ArtifactSidecar): string => artifactDisplayName(artifact, linkName);
  /*
   * One render plan for the preview and the export (SPEC-038 R-1, issue 680), derived by the
   * editor's own hook from these inputs and nothing else: the transport's clock is not among
   * them, so playback reuses the plan and only an authored change rebuilds it (issue 1158).
   */
  const subtitleHidden = subtitleTracks.some((track) => track.id === subtitleView && track.muted);
  const { renderPlan } = useRenderPlan({
    production,
    artifacts: world?.artifacts,
    timelineState,
    timeline: editableTimeline,
    timelineError,
    subtitleView,
    subtitleHidden,
  });
  /*
   * A plan the projection refuses — a placed artifact the world no longer has, say — blocks the
   * preview and the export by name, and nothing else (SPEC-039 R-39, R-40): the editor stays
   * editable so the clip can be removed, and Undo still works. Only an invalid or unresolvable
   * timeline record blocks editing.
   */
  const renderError = renderPlan !== null && !renderPlan.ok ? renderPlan.reason : view.kind === "unavailable" && timelineState.status !== "ready" ? view.reason : null;
  const planTotalSec = renderPlan?.ok ? renderPlan.plan.totalSec : null;
  /*
   * Two lengths. The CANVAS is how much timeline to draw and must extend past the last clip or
   * there is nowhere to drop the next one; the FILM is how long the thing actually is. Trailing
   * editing headroom is not part of the film, so it is the film that plays and the film the
   * header states — presenting the canvas as the runtime would let "Watch from top" run on into
   * blank editor space the export never emits. Both come from the plan, which reads the record
   * the editor edits; a production with no story keeps room past its last clip for the next one.
   */
  const canvasSec = spineCut
    ? spineCut.trackDurationSec
    : Math.max(cut?.totalSec ?? 0, planTotalSec ?? 0, mediaOnly ? (planTotalSec ?? 0) + MEDIA_CANVAS_HEADROOM_SEC : 0);
  const filmSec = planTotalSec ?? canvasSec;
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
   * What a song not yet opened on the timeline still holds in `cut.json`: counted, because the
   * opening folds it in, and a split is not counted twice — the sound half files a second record
   * over the same file, which a person dropped once and will see as one clip.
   */
  const legacyClipCount = (production?.cut.overlays ?? []).filter((o) => (o.audio ?? "keep") !== "only").length;
  /** The fence for the first materialising command; null while the song is unmeasured. */
  const sourceFingerprint = production ? timelineSourceFingerprint(production, masterDurationSec) : null;
  /*
   * A saved record is fenced by its revision alone; the fingerprint fences only the first
   * assembly (SPEC-037 R-24). A song whose master lost its measurement must still be editable
   * once it is on the timeline, so the fence falls back to the story's for a ready record —
   * the coordinator does not read it there (round six).
   */
  const fence = sourceFingerprint ?? (production && timelineState.status === "ready" ? storyTimelineFingerprint(production) : null);
  /** What the record holds, legacy placements folded in — or, for a song not yet opened, what the opening will fold (round ten). */
  const clipCount = editableTimeline
    ? editableTimeline.tracks.reduce((count, track) => count + track.clips.length, 0)
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
      (libraryOpen && editorMediaMatches(LIBRARY_DRAWER_QUERY))
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
  // What the cut uses is what the record holds (round four): a legacy placement is a typed clip
  // on it from the moment the production opens.
  const usedArtifactIds = new Set(
    editableTimeline?.tracks.flatMap((track) => track.clips.flatMap((clip) => (clip.source.kind === "artifact" ? [clip.source.artifactId] : []))) ?? [],
  );
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
    try { sendCommands(mediaPlacementCommands(editableTimeline, [artifact], "append", mintClipId), "Append media"); }
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
      if (sound) { const added = newAudioTrack(editableTimeline); commands.push(added); target = added.trackId; }
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
    const audioTracks = [...editableTimeline.tracks].sort((a, b) => a.order - b.order)
      .filter(track => AUDIO_TRACK_KINDS.has(track.kind) && !track.muted);
    const dialogue = audioTracks.find(track => track.kind === "audio" || track.kind === "dialogue") ??
      audioTracks.find(track => !track.clips.some(clip => clip.startFrame < playheadFrame + durationFrames && clip.startFrame + clip.durationFrames > playheadFrame)) ?? null;
    const commands: TimelineCommand[] = [];
    let fresh: TimelineTrackId = "tr_audio-1";
    if (dialogue === null) { const added = newAudioTrack(editableTimeline); fresh = added.trackId; commands.push(added); }
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
    if (libraryOpen && editorMediaMatches(LIBRARY_DRAWER_QUERY)) return false;
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
          if (editorMediaMatches(LIBRARY_DRAWER_QUERY)) queueMicrotask(() => libraryToggleRef.current?.focus());
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
            <button type="button" className="fy-tlbtn fy-tip" data-tip="Add audio track" aria-label="Add audio track" disabled={commandsDisabled} onClick={() => editableTimeline && sendCommands([newAudioTrack(editableTimeline)], "Add audio track")}>
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
              if (target.closest(".fy-cutseg, .fy-typedclip, .fy-clipmenu, .fy-trackbtns, .fy-playhead, .fy-scrub")) return;
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
