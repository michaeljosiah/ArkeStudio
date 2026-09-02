import { useEffect, useRef } from "react";
import {
  effectiveFraming,
  DEFAULT_SHOT_SEC,
  hasOwnFrame,
  orderedShots,
  type ArtifactSidecar,
  type ProductionBundle,
  type SceneRecord,
} from "@arke-studio/contracts";
import { ChevronLeft, ChevronRight, ImageMark, X } from "../../components/icons.js";
import { mediaUrl } from "../../lib/media.js";
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
  aspect: string;
  shotId: string | null;
  onClose: () => void;
  onSelectShot: (shotId: string) => void;
  onEditShot: (shotId: string) => void;
  onOpenInGenerator: (shotId: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const open = shotId !== null;
  // Keyed on open rather than the shot: showModal() on a dialog that is already modal throws,
  // and the arrows change the shot without ever closing it.
  useEffect(() => {
    const node = dialog.current;
    if (!open || node === null) return;
    if (node.showModal !== undefined) node.showModal();
    else node.setAttribute("open", "");
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
  const path = shotFramePath(production, artifacts, shot.id);
  const src = path === null || worldSlug === undefined ? null : mediaUrl(worldSlug, path);
  const durationSec = shot.durationSec ?? DEFAULT_SHOT_SEC;
  // The lens the shot actually has, inherited from the scene when it sets none of its own.
  const lens = effectiveFraming(scene, shot).lens;
  return (
    <dialog
      ref={dialog}
      className="fy-swlightbox"
      aria-label="Shot preview"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="fy-swlightbox__panel">
        <div className="fy-swlightbox__head">
          <span className="fy-swlightbox__label">shot {shot.number}</span>
          <span className="fy-swlightbox__title">{shot.title}</span>
          <span className="fy-swlightbox__chip">
            {aspect} · {durationSec.toFixed(1)}s{lens === undefined ? "" : ` · ${lens}`}
          </span>
          <button type="button" className="fy-swlightbox__close" aria-label="Close" onClick={onClose}><X size={13} /></button>
        </div>
        <div className="fy-swlightbox__frame" style={{ aspectRatio: aspect.replace(":", " / ") }}>
          {src === null ? (
            <div className="fy-swlightbox__empty">
              <ImageMark size={22} />
              <span>no frame yet</span>
              <button type="button" onClick={() => { onClose(); onOpenInGenerator(shot.id); }}>Generate frame</button>
            </div>
          ) : (
            <img src={src} alt={shot.title} />
          )}
          <button type="button" className="fy-swlightbox__prev" aria-label="Previous shot" onClick={() => step(-1)}><ChevronLeft size={14} /></button>
          <button type="button" className="fy-swlightbox__next" aria-label="Next shot" onClick={() => step(1)}><ChevronRight size={14} /></button>
        </div>
        <div className="fy-swlightbox__foot">
          <p>{shot.description}</p>
          <button type="button" onClick={() => { onClose(); onEditShot(shot.id); }}>Advanced</button>
        </div>
      </div>
    </dialog>
  );
}
