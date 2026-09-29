import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { formatSeconds, type ArtifactSidecar } from "@arke-studio/contracts";
import { Button } from "./ui.js";
import { ChevronLeft, ChevronRight, ChevronUp, Copy, Download, More, X } from "./icons.js";
import { PageSheet } from "./page-sheet.js";
import { useMediaQuery } from "../lib/media-query.js";
import { RichMarkdownEditor } from "./editor/rich-markdown-editor.js";
import { artifactDisplayName, artifactIsServable, artifactViewer } from "../lib/artifact-view.js";
import { useArtifactText } from "../lib/artifact-text.js";
import { downloadMedia, downloadNameFor } from "../lib/download.js";
import { generatedOriginLabel, shortDateTime } from "../lib/format.js";
import { mediaUrl } from "../lib/media.js";
import { playbackSnapshot, togglePlayback } from "../lib/audio.js";

/**
 * One frame, every artifact (issue 477).
 *
 * The shelf could count files and drag them into a cut; it could not open one. This is the frame
 * that opens them — a native `<dialog>` for the same reasons `ImageDialog` uses one (focus trap,
 * Escape, background inerting come with it), holding a stage chosen by the file's own type and a
 * metadata column that stays the same whatever the stage is.
 *
 * Two decisions worth stating, because both would be easy to undo by accident:
 *
 * **The viewer is dialog state, not a route.** A route would remount the shelf, and the shelf is
 * carrying a kind filter, a "made here" toggle, an import report, extraction notices and a scroll
 * position. Losing all five to look at a picture is a worse trade than not having a shareable
 * link to one — and an artifact id is not shareable off this machine anyway.
 *
 * **The subject is an artifact, not an index.** `ArtifactsScreen` holds the selected id and looks
 * the sidecar up in the live snapshot on every render, so a world update, a filing, or a
 * superseding replacement moves this frame's contents or closes it, rather than silently
 * re-pointing it at whatever slid into that row.
 */
export function ArtifactViewer({
  artifact,
  artifacts,
  worldSlug,
  linkName,
  onClose,
  onRetire,
  visibleArtifacts = artifacts,
  onNavigate,
}: {
  /** The artifact on screen, or null for closed. */
  artifact: ArtifactSidecar | null;
  /** The world's shelf, for the one fact an artifact cannot state about itself: who replaced it. */
  artifacts: readonly ArtifactSidecar[];
  worldSlug: string | undefined;
  /** Names a link the way the cards do — "The Vigil", never "the-vigil". */
  linkName: (link: string, links?: readonly string[]) => string;
  onClose: () => void;
  onRetire?: (artifactId: string) => void;
  /** Navigation stays inside the shelf's current filters and order. */
  visibleArtifacts?: readonly ArtifactSidecar[];
  onNavigate?: (artifactId: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const focusAfterNavigation = useRef<string | null>(null);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    // `showModal` is guarded because the DOM this renders under in tests is not a browser's.
    if (artifact !== null) {
      const opening = !node.open;
      if (opening) node.showModal?.();
      if (node.querySelector(".fy-artview__foot")) {
        const label = focusAfterNavigation.current;
        const target = label && [...node.querySelectorAll<HTMLButtonElement>("button")].find(button => button.getAttribute("aria-label") === label && !button.disabled);
        if (opening || label) (target || node.querySelector<HTMLElement>("h2"))?.focus({ preventScroll: true });
      }
      focusAfterNavigation.current = null;
    }
    if (artifact === null && node.open) node.close();
  }, [artifact]);

  return (
    <dialog
      ref={dialog}
      className="fy-artview"
      aria-labelledby={titleId}
      // Escape arrives here as well as the close button, so the screen's state and the element
      // agree however it was dismissed.
      onClose={(event) => { if (event.target === event.currentTarget) onClose(); }}
      onClick={(event) => {
        // A click that lands on the dialog itself rather than its panel is the backdrop.
        if (event.target === event.currentTarget) dialog.current?.close();
      }}
    >
      {artifact !== null && (
        <ArtifactPanel
          // Keyed by the file, so opening another artifact builds a new stage rather than
          // handing the old `<video>` a new source and keeping its failure.
          key={artifact.id}
          artifact={artifact}
          artifacts={artifacts}
          worldSlug={worldSlug}
          linkName={linkName}
          titleId={titleId}
          onRetire={onRetire}
          visibleArtifacts={visibleArtifacts}
          onNavigate={onNavigate ? (id) => {
            focusAfterNavigation.current = document.activeElement?.getAttribute("aria-label") ?? null;
            onNavigate(id);
          } : undefined}
          onClose={() => dialog.current?.close()}
        />
      )}
    </dialog>
  );
}

function ArtifactPanel({
  artifact,
  artifacts,
  worldSlug,
  linkName,
  titleId,
  onClose,
  onRetire,
  visibleArtifacts,
  onNavigate,
}: {
  artifact: ArtifactSidecar;
  artifacts: readonly ArtifactSidecar[];
  worldSlug: string | undefined;
  linkName: (link: string, links?: readonly string[]) => string;
  titleId: string;
  onClose: () => void;
  onRetire?: (artifactId: string) => void;
  visibleArtifacts: readonly ArtifactSidecar[];
  onNavigate?: (artifactId: string) => void;
}) {
  const compact = useMediaQuery("(max-width: 859px)");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => { if (!compact) setDetailsOpen(false); }, [compact]);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const index = visibleArtifacts.findIndex(item => item.id === artifact.id);
  const previous = visibleArtifacts[index - 1];
  const next = index >= 0 ? visibleArtifacts[index + 1] : undefined;
  const filename = artifact.file.split("/").pop() ?? artifact.file;
  const name = artifactDisplayName(artifact, linkName);
  const path = `artifacts/${artifact.file}`;
  const viewer = artifactViewer(artifact);
  /*
   * A retry is a second request, not the same failure handed back: the attempt rides on the query
   * string, which the media route splits off before it resolves anything, and the stage is keyed
   * by it so the element that failed is replaced rather than re-pointed.
   */
  const [attempt, setAttempt] = useState(0);
  const src = worldSlug ? mediaUrl(worldSlug, path, { attempt: String(attempt) }) : "";
  const retry = () => setAttempt((n) => n + 1);

  const extension = filename.includes(".") ? filename.split(".").pop() : null;
  const sub = [
    artifact.kind,
    ...(extension !== null && extension !== undefined ? [extension.toLowerCase()] : []),
    ...(artifact.mediaInfo ? [formatSeconds(artifact.mediaInfo.durationSec)] : compact && dimensions ? [`${dimensions.width} × ${dimensions.height}`] : []),
  ].join(" · ");

  return (
    <div className="fy-artview__panel">
      <div className="fy-artview__head">
        <div className="fy-artview__titles">
          <h2 id={titleId} title={filename} tabIndex={compact ? -1 : undefined}>{name}</h2>
          <div className="fy-artview__sub">{sub}</div>
        </div>
        {artifactIsServable(artifact) && (
          <SaveCopy worldSlug={worldSlug} path={path} name={filename} />
        )}
        {onRetire && artifact.retiredAt === undefined && (compact ? <details className="fy-artview__menu">
          <summary aria-label="Artifact options"><More size={20} /></summary>
          <div><Button variant="ghost" onClick={() => onRetire(artifact.id)}>Remove from shelf</Button></div>
        </details> : <Button variant="outline" onClick={() => onRetire(artifact.id)}>Remove from shelf</Button>)}
        <button
          type="button"
          className="fy-artview__close"
          aria-label={`Close ${name}`}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      <div className="fy-artview__body">
        <div className="fy-artview__stage" data-viewer={viewer}
          onTouchStart={(event) => {
            touch.current = null;
            if (!compact || !onNavigate || event.touches.length !== 1 || (event.target as Element).closest("button,a,input,textarea,video,audio")) return;
            const point = event.touches[0]!;
            touch.current = { x: point.clientX, y: point.clientY };
          }}
          onTouchCancel={() => { touch.current = null; }}
          onTouchEnd={(event) => {
            const start = touch.current;
            touch.current = null;
            const end = event.changedTouches[0];
            if (!start || !end) return;
            const dx = end.clientX - start.x, dy = end.clientY - start.y;
            if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 2) return;
            const destination = dx < 0 ? next : previous;
            if (destination) onNavigate?.(destination.id);
          }}>
          <Stage key={attempt} viewer={viewer} src={src} name={name} path={path} worldSlug={worldSlug} onRetry={retry} onDimensions={setDimensions} />
        </div>
        {!compact && <ArtifactMeta artifact={artifact} artifacts={artifacts} linkName={linkName} />}
      </div>
      {compact && <>
        <div className="fy-artview__foot">
          <button type="button" aria-label="Previous artifact" disabled={!previous || !onNavigate} onClick={() => previous && onNavigate?.(previous.id)}><ChevronLeft size={22} /></button>
          <span>{index >= 0 ? `${index + 1} of ${visibleArtifacts.length}` : "Outside current filter"}</span>
          <button type="button" className="fy-artview__details" onClick={() => setDetailsOpen(true)}>Details<ChevronUp size={16} /></button>
          <span aria-hidden="true" />
          <button type="button" aria-label="Next artifact" disabled={!next || !onNavigate} onClick={() => next && onNavigate?.(next.id)}><ChevronRight size={22} /></button>
        </div>
        <PageSheet className="fy-artview__sheet" open={detailsOpen} title={name} onClose={() => setDetailsOpen(false)} footer={<div className="fy-artview__detailactions">
          {onRetire && artifact.retiredAt === undefined && <Button variant="outline" onClick={() => onRetire(artifact.id)}>Remove from shelf</Button>}
          {artifactIsServable(artifact) && <SaveCopy worldSlug={worldSlug} path={path} name={filename} text />}
        </div>}><ArtifactMeta artifact={artifact} artifacts={artifacts} linkName={linkName} compact /></PageSheet>
      </>}
    </div>
  );
}

/** The stage for one viewer kind. Every branch that can fail says so and offers another go. */
function Stage({
  viewer,
  src,
  name,
  path,
  worldSlug,
  onRetry,
  onDimensions,
}: {
  viewer: ReturnType<typeof artifactViewer>;
  src: string;
  name: string;
  path: string;
  worldSlug: string | undefined;
  onRetry: () => void;
  onDimensions: (dimensions: { width: number; height: number }) => void;
}) {
  if (worldSlug === undefined) return <Failed note="No world open" />;
  switch (viewer) {
    case "image":
      return <ImageStage src={src} name={name} onRetry={onRetry} onDimensions={onDimensions} />;
    case "video":
      return <VideoStage src={src} name={name} onRetry={onRetry} />;
    case "audio":
      return <AudioStage src={src} name={name} onRetry={onRetry} />;
    case "markdown":
      return <MarkdownStage worldSlug={worldSlug} path={path} name={name} />;
    case "text":
      return <TextStage worldSlug={worldSlug} path={path} name={name} />;
    case "pdf":
      /*
       * `<object>` rather than `<iframe>`, for its fallback: a host that does not render the PDF
       * renders the children instead of a blank rectangle, and the save control in the head above
       * is still the way out either way.
       *
       * The note says what is known and no more (issue 530). These children stand in for *any*
       * failure to render — a refused load included — so the earlier "No PDF viewer here" asserted
       * a cause it could not see. It was wrong the first time it ever showed: the load had been
       * blocked by `frame-src`, and the note sent the reader hunting for a missing viewer.
       */
      return (
        <object className="fy-artview__pdf" type="application/pdf" data={src} aria-label={`${name} — PDF`}>
          <Failed note="Could not display this PDF" onRetry={onRetry} />
        </object>
      );
    default:
      // Nothing here renders it and nothing here can fetch it, so the metadata column beside this
      // is the whole answer. Said plainly rather than drawn as an empty frame.
      return <Failed note={`No viewer for ${name.split(".").pop() ?? "this file"}`} />;
  }
}

function Failed({ note, onRetry }: { note: string; onRetry?: () => void }) {
  return (
    <div className="fy-artview__fail">
      <span>{note}</span>
      {onRetry && (
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

function ImageStage({ src, name, onRetry, onDimensions }: { src: string; name: string; onRetry: () => void; onDimensions: (dimensions: { width: number; height: number }) => void }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Failed note="Could not read this image" onRetry={onRetry} />;
  return (
    <img className="fy-artview__image" src={src} alt={name} draggable={false} onLoad={event => onDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setFailed(true)} />
  );
}

/**
 * Real video controls over the range-capable media route, never a thumbnail pointed at an `.mp4`.
 *
 * `preload="metadata"` and no `autoPlay`: opening a viewer may get the file ready, but sound
 * starts when a person asks for it. Starting here pauses the dock, because one thing sounding at
 * a time is the rule the app has had since SPEC-011 and two would be nobody's intention.
 */
function VideoStage({ src, name, onRetry }: { src: string; name: string; onRetry: () => void }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Failed note="Could not play this video" onRetry={onRetry} />;
  return (
    <video
      className="fy-artview__media"
      src={src}
      controls
      playsInline
      preload="metadata"
      aria-label={name}
      onPlay={hushTheDock}
      onError={() => setFailed(true)}
    />
  );
}

function AudioStage({ src, name, onRetry }: { src: string; name: string; onRetry: () => void }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Failed note="Could not play this audio" onRetry={onRetry} />;
  return (
    <audio
      className="fy-artview__media"
      src={src}
      controls
      preload="metadata"
      aria-label={name}
      onPlay={hushTheDock}
      onError={() => setFailed(true)}
    />
  );
}

/** Read the dock rather than subscribe to it: this asks once, on a press, not on every tick. */
function hushTheDock(): void {
  if (playbackSnapshot().status === "playing") togglePlayback();
}

/**
 * A filed markdown document, read through the editor the bible is written in.
 *
 * Read-only, and labelled so. An artifact's bytes are immutable — superseding one files a new
 * artifact carrying `supersedes` (SPEC-015 R-5) — and no such filing path exists from the shelf
 * yet. An editor that took keystrokes with nowhere to put them would be the worse half of this
 * issue rather than the fix for it.
 */
function MarkdownStage({ worldSlug, path, name }: { worldSlug: string; path: string; name: string }) {
  const loaded = useArtifactText(worldSlug, path);
  if (loaded.status === "loading") return <div className="fy-artview__note">Reading…</div>;
  if (loaded.status === "failed") return <Failed note={`Could not read ${name}`} onRetry={loaded.retry} />;
  if (loaded.status === "binary") return <Failed note="Not text" onRetry={loaded.retry} />;
  return (
    <div className="fy-artview__doc">
      <div className="fy-artview__note">read-only</div>
      <RichMarkdownEditor value={loaded.text} ariaLabel={name} readOnly />
    </div>
  );
}

function TextStage({ worldSlug, path, name }: { worldSlug: string; path: string; name: string }) {
  const loaded = useArtifactText(worldSlug, path);
  if (loaded.status === "loading") return <div className="fy-artview__note">Reading…</div>;
  if (loaded.status === "failed") return <Failed note={`Could not read ${name}`} onRetry={loaded.retry} />;
  if (loaded.status === "binary") return <Failed note="Not text" onRetry={loaded.retry} />;
  return (
    <div className="fy-artview__doc">
      <div className="fy-artview__note">
        <button
          type="button"
          className="fy-artview__copy"
          aria-label={`Copy ${name}`}
          onClick={() => void navigator.clipboard?.writeText(loaded.text)}
        >
          <Copy size={13} /> Copy
        </button>
      </div>
      {/* `<pre>` because the whitespace is the document: an indented block that reflows is a
          different file from the one that was filed. */}
      <pre className="fy-artview__text">{loaded.text}</pre>
    </div>
  );
}

/** Save these bytes out of the app, through the same confined identity the stage reads them by. */
function SaveCopy({ worldSlug, path, name, text = false }: { worldSlug: string | undefined; path: string; name: string; text?: boolean }) {
  const [saving, setSaving] = useState(false);
  const filename = downloadNameFor(path, name);
  const label = `Download ${filename}`;
  const available = Boolean(worldSlug) && !saving;
  return (
    <button
      type="button"
      className={text ? "ui-btn ui-btn--primary" : "fy-artview__save"}
      aria-label={label}
      title={label}
      disabled={!available}
      onClick={() => {
        if (!available) return;
        setSaving(true);
        void downloadMedia(worldSlug, path, name, "file").then((outcome) => {
          setSaving(false);
          if (outcome.ok || outcome.cancelled) return;
          toast.error(`${filename} was not saved`, {
            description: outcome.reason,
            classNames: {
              toast: "fy-toast",
              title: "fy-toast__title",
              description: "fy-toast__description",
              closeButton: "fy-toast__close",
            },
          });
        });
      }}
    >
      <Download size={13} />
      {text && "Save"}
    </button>
  );
}

/**
 * What this file is, beside what it looks like.
 *
 * The same column whatever the stage holds, because the questions a person opens an artifact with
 * — where did this come from, what is it linked to, has something replaced it — do not change
 * with the file type.
 */
function ArtifactMeta({
  artifact,
  artifacts,
  linkName,
  compact = false,
}: {
  artifact: ArtifactSidecar;
  artifacts: readonly ArtifactSidecar[];
  compact?: boolean;
  linkName: (link: string, links?: readonly string[]) => string;
}) {
  const replacement = artifacts.find((a) => a.supersedes === artifact.id);
  const generation = artifact.generation;
  return (
    <dl className="fy-artview__meta">
      {!compact && <Row label="id">{artifact.id}</Row>}
      <Row label="kind">{compact ? [artifact.kind, artifact.file.split(".").pop()].join(" · ") : artifact.kind}</Row>
      <Row label="origin">
        {artifact.origin.by === "system"
          ? generatedOriginLabel(artifact)
          : artifact.origin.importedFrom !== undefined
            ? `imported · ${artifact.origin.importedFrom}`
            : "filed by hand"}
      </Row>
      <Row label="created">{shortDateTime(artifact.created)}</Row>
      {!compact && <Row label="hash">{`${artifact.hash.slice(0, 19)}…`}</Row>}
      <Row label="links">{artifact.links.length > 0 ? artifact.links.map((link) => linkName(link, artifact.links)).join(", ") : "—"}</Row>
      {artifact.production !== undefined && <Row label="production">{artifact.production}</Row>}
      {generation !== undefined && <Row label="model">{`${generation.provider} · ${generation.model}`}</Row>}
      {generation !== undefined && generation.source === "bench" && (
        <Row label="from">{`take ${generation.takeNumber} · ${generation.sessionId}`}</Row>
      )}
      {generation !== undefined && generation.source === "character-reference" && (
        <Row label="from">{`${generation.workflow} · ${linkName(generation.sheetId, artifact.links)}`}</Row>
      )}
      {generation?.source === "founding" && <Row label="from">{generation.label} · founding conversation</Row>}
      {artifact.boundaryExtraction !== undefined && (
        <Row label="cut from">{artifact.boundaryExtraction.sourceTakeId}</Row>
      )}
      {artifact.supersedes !== undefined && <Row label="supersedes">{artifact.supersedes}</Row>}
      {replacement !== undefined && <Row label="superseded by">{replacement.file}</Row>}
      {compact && <Row label="hash">{`${artifact.hash.slice(0, 19)}…`}</Row>}
    </dl>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fy-artview__row">
      <dt className="fy-artview__key">{label}</dt>
      <dd className="fy-artview__val">{children}</dd>
    </div>
  );
}
