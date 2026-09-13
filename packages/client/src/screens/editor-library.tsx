import {
  artifactPicturePath,
} from "@arke-studio/contracts";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useNavigate } from "react-router";
import {
  type BorrowableArtifact,
  type MediaDestination,
  productionFrameRate,
  libraryItemKey,
  pickableArtifacts,
  type ProductionBundle,
  type ProductionTimeline,
  type TimelineClip,
  type Shot,
  type Take,
  type TimelineClipId,
  type TimelineLibraryItem,
  resolveProductionArtifact,
  secondsToFrames,
  ulid,
  type ArtifactSidecar,
  orderedShots,
} from "@arke-studio/contracts";
import { cx } from "../components/ui.js";
import {
  Film,
  Folder,
  Locate,
  Mic,
  Plus,
  Scroll,
  Search,
  Upload,
  VideoMark,
} from "../components/icons.js";
import { EditorDialog } from "../components/editor-dialog.js";
import { Portrait } from "../components/portrait.js";
import { mediaUrl } from "../lib/media.js";
import { runtimeSeconds } from "../lib/format.js";
import { artifactDisplayName, artifactsForProduction, type LinkName } from "../lib/artifact-view.js";
import {
  acceptedTakeId,
  mediaTakeFor,
  takesForShot,
} from "../lib/selectors.js";
import { ARTIFACT_DRAG_TYPE, LANE_DRAG_PICTURE, LANE_DRAG_SOUND, SHOT_DRAG_TYPE, setLibraryDrag } from "./editor-audio.js";
import { type DroppedKind } from "../lib/clip-gesture.js";
import {
  subscribeWorldArtifacts,
  browseWorldArtifacts,
} from "../lib/store.js";
import { Wave } from "../components/wave.js";
import { takeMediaPath } from "./production-generate.js";
import { CLIP_DEFAULT_SEC } from "./editor-legacy-lanes.js";

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

export type LibraryFilter = "all" | "unused" | "needs-take" | "audio";
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
export function ArtifactPanel({
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

/**
 * The shot picker (SPEC-039 R-8, amended; issue 1033): scenes on the left, that scene's shots
 * on the right, each a checkbox. Shots are the one thing the Library curates — a cut brings
 * them in by scene — so this is what the picker is for and all it is for; every filed artifact
 * is already in the list behind it.
 */
export function AddToLibraryDialog({
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
