import { useCallback, useEffect, useRef, useState } from "react";
import { mainPhotoFor, type WorldBundle } from "@arke-studio/contracts";
import { mediaUrl } from "../lib/media.js";

/**
 * A world media image with the prototype's placeholder behaviour: the frame keeps its size
 * and shows a quiet label until (or unless) the file exists. Never a broken-image glyph.
 */
export function Portrait({
  worldSlug,
  path,
  label,
  radius = 7,
  onAvailabilityChange,
}: {
  worldSlug: string | undefined;
  /** World-relative media path, e.g. "references/maren-kest/head-front.png". */
  path: string;
  label: string;
  radius?: number;
  onAvailabilityChange?: (available: boolean) => void;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [worldSlug, path]);

  // Held in a ref so `settle` below keeps one identity: callers pass an inline arrow, and a ref
  // callback that changes every render is detached and reattached every render with it.
  const notify = useRef(onAvailabilityChange);
  notify.current = onAvailabilityChange;

  /*
   * Availability is read off the element as well as listened for.
   *
   * A cached image is already `complete` before React can attach onLoad, and a load event that
   * has already fired never fires again — so an image that arrived fastest is precisely the one
   * whose onLoad never runs. Screens preload these files (the cast page emits <link rel=preload>
   * for the very portraits its rows link to), which made that the normal case rather than a race:
   * the enlarge trigger on the character detail page stayed disabled every time.
   */
  const settle = useCallback((node: HTMLImageElement | null) => {
    if (!node || !node.complete) return;
    if (node.naturalWidth > 0) notify.current?.(true);
    else {
      setFailed(true);
      notify.current?.(false);
    }
  }, []);

  if (!worldSlug || failed) {
    return (
      <div className="fy-portrait--fallback" style={{ borderRadius: radius }}>
        {label}
      </div>
    );
  }
  const src = mediaUrl(worldSlug, path);
  return (
    <img
      // Remounted per source, so `settle` runs again for the next picture rather than only for
      // the first one to occupy this slot.
      key={src}
      ref={settle}
      className="fy-portrait"
      style={{ borderRadius: radius }}
      src={src}
      alt={label}
      draggable={false}
      onLoad={() => notify.current?.(true)}
      onError={() => {
        setFailed(true);
        notify.current?.(false);
      }}
    />
  );
}

/** The conventional portrait path for a sheet: its kit's front tile. */
export function sheetPortraitPath(sheetId: string): string {
  return `references/${sheetId}/head-front.png`;
}

/** The accepted character identity, preserving immutable nested take paths. */
export function characterPortraitPath(world: WorldBundle | null | undefined, sheetId: string): string {
  const kit = world?.referenceKits.find((candidate) => candidate.sheetId === sheetId);
  const photo = kit ? mainPhotoFor(kit) : null;
  return photo ? `references/${sheetId}/${photo.file}` : sheetPortraitPath(sheetId);
}
