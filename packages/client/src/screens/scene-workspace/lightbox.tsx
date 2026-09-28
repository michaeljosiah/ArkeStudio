import { useEffect, useRef, useState } from "react";
import { useMediaQuery } from "../../lib/media-query.js";
import { PageSheet } from "../../components/page-sheet.js";
import { acceptTake, useStore } from "../../lib/store.js";
import {
  beatPictureShotId,
  effectiveFraming,
  DEFAULT_SHOT_SEC,
  hasOwnFrame,
  orderedShots,
  productionShape,
  type ArtifactSidecar,
  type ProductionBundle,
  type SceneRecord,
} from "@arke-studio/contracts";
import { ChevronLeft, ChevronRight, ImageMark, More, X } from "../../components/icons.js";
import { mediaUrl } from "../../lib/media.js";
import { shotFramePath as beatFrame } from "./boards.js";
import { mediaTakeFor, acceptedTakeId } from "../../lib/selectors.js";
import { posterNameFor, posterize } from "../../lib/poster.js";

/**
 * The picture the preview shows for a shot: its own filed frame first, then the poster of the
 * steering take, then a legacy accepted still. The stage and the lightbox share it, so opening
 * the lightbox never swaps the frame you were just looking at for a different one.
 */
export function shotFramePath(
  production: ProductionBundle,
  artifacts: readonly ArtifactSidecar[],
  shotId: string,
): string | null {
  const selection = production.selections[shotId];
  if (hasOwnFrame(selection, artifacts)) {
    const artifact = artifacts.find((candidate) => candidate.id === selection?.startFrameArtifactId);
    if (artifact !== undefined) return `artifacts/${artifact.file}`;
  }
  const steeringId = selection?.startFrameTakeId ?? null;
  const steering = steeringId === null ? undefined : production.takes.find((take) => take.id === steeringId);
  const steeringMedia = steering === undefined ? null : mediaTakeFor(production, steering);
  if (steeringMedia !== null) {
    return `productions/${production.meta.id}/takes/${steeringMedia.id}/${posterNameFor(steeringMedia.media)}`;
  }
  const accepted = acceptedTakeId(production, shotId);
  const legacy = accepted === null
    ? undefined
    : production.takes.find((take) => take.id === accepted && (take.kind === "frame" || take.kind === "still"));
  const legacyMedia = legacy === undefined ? null : mediaTakeFor(production, legacy);
  if (legacyMedia !== null) {
    return `productions/${production.meta.id}/takes/${legacyMedia.id}/${posterNameFor(legacyMedia.media)}`;
  }
  // A rendered shot with no frame of its own still has a picture: its clip's poster, the same
  // one Preview's filmstrip falls back to, so Larger never says "no frame yet" over a clip.
  const clip = accepted === null ? undefined : production.takes.find((take) => take.id === accepted && take.kind === "clip");
  const clipMedia = clip === undefined ? null : mediaTakeFor(production, clip);
  return clipMedia === null ? null : posterize(`productions/${production.meta.id}/takes/${clipMedia.id}/${clipMedia.media}`);
}

/**
 * The preview lightbox (SPEC-036 R-1, R-19): one shot, large, with arrows that walk the scene
 * order and carry the selection with them.
 *
 * It is controlled from outside — `shotId` is the shot on show, and stepping asks the owner to
 * move it through `onSelectShot` — because the same overlay is reached from three places (the
 * stage, a row's frame, the run bar's Review) and each already owns the shot it wants to show.
 * A native dialog puts it in the top layer, over the rail and the dock alike.
 */
export function ShotLightbox({
  scene,
  production,
  artifacts,
  worldSlug,
  worldId,
  review = false,
  locked = false,
  retry,
  aspect,
  shotId,
  onClose,
  onSelectShot,
  onEditShot,
  onOpenInGenerator,
}: {
  scene: SceneRecord;
  production: ProductionBundle;
  artifacts: readonly ArtifactSidecar[];
  worldSlug: string | undefined;
  worldId?: string;
  review?: boolean;
  locked?: boolean;
  retry?: (shotId: string) => (() => void) | null;
  aspect: string;
  shotId: string | null;
  onClose: () => void;
  onSelectShot: (shotId: string) => void;
  onEditShot: (shotId: string) => void;
  onOpenInGenerator: (shotId: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const phone = useMediaQuery("(max-width: 599px)");
  const { connection } = useStore();
  const [variants, setVariants] = useState(false), [menu, setMenu] = useState(false);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => { setVariants(false); setMenu(false); swipe.current = null; }, [shotId]);
  const open = shotId !== null;
  // Keyed on open rather than the shot: showModal() on a dialog that is already modal throws,
  // and the arrows change the shot without ever closing it.
  useEffect(() => {
    const node = dialog.current;
    if (!open || node === null) return;
    const opener = document.activeElement;
    if (node.showModal !== undefined) node.showModal();
    else node.setAttribute("open", "");
    return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, [open]);
  if (shotId === null) return null;
  const shots = orderedShots(scene);
  const index = shots.findIndex((candidate) => candidate.id === shotId);
  const shot = shots[index];
  if (shot === undefined) return null;
  const step = (delta: number) => {
    const next = shots[(index + delta + shots.length) % shots.length];
    if (next !== undefined) onSelectShot(next.id);
  };
  // A visual novel's beat that keeps the picture before shows that picture here too, as the page
  // behind it does (turn 174): the arrows step onto such a beat without remounting (codex round 7).
  const beats = productionShape(production.meta).playsAsBeats;
  const pictureShotId = beats ? beatPictureShotId(shots, shot.id) : shot.id;
  // A beat shows its picture or nothing: never a clip's poster or a steering take's, which the
  // story does not use — the rows' resolution, not the film's fallbacks (codex round 14).
  const path = beats ? beatFrame(production, artifacts, pictureShotId).path : shotFramePath(production, artifacts, pictureShotId);
  const src = path === null || worldSlug === undefined ? null : mediaUrl(worldSlug, path);
  const durationSec = shot.durationSec ?? DEFAULT_SHOT_SEC;
  // The lens the shot actually has, inherited from the scene when it sets none of its own.
  const lens = effectiveFraming(scene, shot).lens;
  const frameVariants = production.takes.filter(take => take.coversShots.includes(pictureShotId) && (take.kind === "frame" || take.kind === "still") && take.media !== undefined);
  const again = retry?.(pictureShotId) ?? null;
  return (
    <>
    <dialog
      ref={dialog}
      className="fy-swlightbox"
      aria-label="Shot preview"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={event => {
        if (event.defaultPrevented || (event.target as HTMLElement).closest("input,textarea,select")) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); step(event.key === "ArrowLeft" ? -1 : 1); }
      }}
    >
      <div className="fy-swlightbox__panel">
        {phone ? <header className="fy-swlightbox__phone-head">
          <button type="button" aria-label="Close" onClick={onClose}><X size={20} /></button>
          <div>{review ? "New frames" : "Shot preview"}<span>{index + 1} of {shots.length}</span></div>
          <button type="button" aria-label="Frame actions" aria-haspopup="dialog" onClick={() => setMenu(true)}><More size={20} /></button>
        </header> : <div className="fy-swlightbox__head">
          <span className="fy-swlightbox__label">shot {shot.number}</span>
          <span className="fy-swlightbox__title">{shot.title}</span>
          <span className="fy-swlightbox__chip">
            {aspect} · {durationSec.toFixed(1)}s{lens === undefined ? "" : ` · ${lens}`}
          </span>
          <button type="button" className="fy-swlightbox__close" aria-label="Close" onClick={onClose}><X size={13} /></button>
        </div>}
        <div className="fy-swlightbox__frame" style={{ aspectRatio: aspect.replace(":", " / ") }}
          onPointerDown={event => { if (event.isPrimary === false || (event.target as HTMLElement).closest("button")) { swipe.current = null; return; } swipe.current = { x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture?.(event.pointerId); }}
          onPointerCancel={() => { swipe.current = null; }}
          onPointerUp={event => { const start = swipe.current; swipe.current = null; if (!start) return; const dx = event.clientX-start.x, dy = event.clientY-start.y; if (Math.abs(dx)>45 && Math.abs(dx)>Math.abs(dy)*1.5) step(dx<0?1:-1); }}>
          {src === null ? (
            <div className="fy-swlightbox__empty">
              <ImageMark size={22} />
              <span>no frame yet</span>
              <button type="button" onClick={() => { onClose(); onOpenInGenerator(pictureShotId); }}>Generate frame</button>
            </div>
          ) : (
            <img src={src} alt={shot.title} draggable={false} />
          )}
          <button type="button" className="fy-swlightbox__prev" aria-label="Previous shot" onClick={() => step(-1)}><ChevronLeft size={14} /></button>
          <button type="button" className="fy-swlightbox__next" aria-label="Next shot" onClick={() => step(1)}><ChevronRight size={14} /></button>
        </div>
        {phone ? <>
          <div className="fy-swlightbox__phone-caption"><button type="button" aria-label="Previous shot" onClick={() => step(-1)}><ChevronLeft size={20} /></button><b>Shot {shot.number} · {shot.title}</b><button type="button" aria-label="Next shot" onClick={() => step(1)}><ChevronRight size={20} /></button></div>
          <div className="fy-swlightbox__dots" aria-label={`Frame ${index+1} of ${shots.length}`}>{shots.map(item => <i key={item.id} data-on={item.id===shot.id || undefined} />)}</div>
          <footer className="fy-swlightbox__phone-foot"><button type="button" disabled={locked || !again} onClick={() => again?.()}>Retry</button><button type="button" disabled={!frameVariants.length} onClick={() => setVariants(true)}>Variants · {frameVariants.length}</button></footer>
        </> : <div className="fy-swlightbox__foot">
          <p>{shot.description}</p>
          <button type="button" onClick={() => { onClose(); onEditShot(shot.id); }}>Open the shot</button>
        </div>}
      </div>
    </dialog>
    <PageSheet open={menu} title={`Shot ${shot.number}`} onClose={() => setMenu(false)}><div className="fy-scene-menu"><button type="button" onClick={() => { setMenu(false); onClose(); onEditShot(shot.id); }}>Open the shot</button><button type="button" onClick={() => { setMenu(false); onClose(); onOpenInGenerator(pictureShotId); }}>Open in generator</button></div></PageSheet>
    <PageSheet open={variants} title={`Shot ${shot.number} · variants`} onClose={() => setVariants(false)} className="fy-review-variants"><div className="fy-swvariants__grid">{frameVariants.map(take => {
      const selection = production.selections[pictureShotId];
      const current = selection?.startFrameTakeId === take.id || artifacts.some(artifact => artifact.id === selection?.startFrameArtifactId && artifact.links.includes(take.id));
      return <article key={take.id}><img src={worldSlug === undefined ? undefined : mediaUrl(worldSlug, `productions/${production.meta.id}/takes/${take.id}/${take.media}`)} alt={`Variant for shot ${shot.number}`} /><div><span>{take.model}</span><button type="button" disabled={current || locked || connection !== "open" || !worldId} onClick={() => { if (worldId) { acceptTake(worldId, production.meta.id, take.id, pictureShotId); setVariants(false); } }}>{current ? "Current" : "Use frame"}</button></div></article>;
    })}</div></PageSheet>
    </>
  );
}
