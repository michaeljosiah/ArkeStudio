import { useCallback, useEffect, useRef, useState } from "react";
import { mainPhotoFor, orderedLocationViews, type WorldBundle } from "@arke-studio/contracts";
import { mediaUrl } from "../lib/media.js";
import { ImageDownload } from "./image-actions.js";

/**
 * A world media image with the prototype's placeholder behaviour: the frame keeps its size
 * and shows a quiet label until (or unless) the file exists. Never a broken-image glyph.
 */
export function Portrait({
  worldSlug,
  path,
  label,
  radius = 7,
  download = false,
  downloadName,
  onAvailabilityChange,
}: {
  worldSlug: string | undefined;
  /** World-relative media path, e.g. "references/maren-kest/head-front.png". */
  path: string;
  label: string;
  radius?: number;
  /**
   * Offer to save this picture (issue 478). Opt-in, because most pictures on these screens are
   * an avatar, a card frame or a chip standing in for something else — user media is the subset
   * a person would actually want a copy of, and only the screen knows which is which.
   *
   * The host box needs `fy-imghost`, which is what the control positions and reveals against.
   */
  download?: boolean;
  /** A human name for the saved file. The extension always comes from the file itself. */
  downloadName?: string;
  onAvailabilityChange?: (available: boolean) => void;
}) {
  const [failed, setFailed] = useState(false);
  /*
   * Which picture is known to have arrived, rather than a bare "something has" — the same shape
   * ImageDialog's trigger uses, and for the same reason. A save control enabled by the *previous*
   * subject's load would write the wrong bytes, or none.
   */
  const subject = `${worldSlug ?? ""}|${path}`;
  const [loadedSubject, setLoadedSubject] = useState<string | null>(null);
  const loaded = loadedSubject === subject;
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
  const settle = useCallback(
    (node: HTMLImageElement | null) => {
      if (!node || !node.complete) return;
      if (node.naturalWidth > 0) {
        setLoadedSubject(subject);
        notify.current?.(true);
      } else {
        setFailed(true);
        notify.current?.(false);
      }
    },
    [subject],
  );

  if (!worldSlug || failed) {
    const frame = (
      <div className="fy-portrait--fallback" style={{ borderRadius: radius }}>
        {label}
      </div>
    );
    // A frame with no file behind it is a placeholder, not a failure — nothing to offer to save.
    // A path that was recorded and did not arrive is the other thing, and says so.
    if (!download || path === "") return frame;
    return (
      <>
        {frame}
        <ImageDownload worldSlug={worldSlug} path={path} name={downloadName} ready={false} />
      </>
    );
  }
  const src = mediaUrl(worldSlug, path);
  const picture = (
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
      onLoad={() => {
        setLoadedSubject(subject);
        notify.current?.(true);
      }}
      onError={() => {
        setFailed(true);
        notify.current?.(false);
      }}
    />
  );
  if (!download) return picture;
  /*
   * A fragment, not a wrapper. Half the screens in this app style the picture as a direct child
   * of its frame (`.fy-artdirection__master > .fy-portrait`), and a box put between the two
   * silently unstyles every one of them. The control is a sibling instead, absolutely placed
   * against the `fy-imghost` the screen already draws.
   */
  return (
    <>
      {picture}
      <ImageDownload worldSlug={worldSlug} path={path} name={downloadName} ready={loaded} />
    </>
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

/**
 * A location's establishing view — what a card and the detail hero show (issue 243, turn 57).
 *
 * Three steps down, and the last two are only for worlds that predate location kits. A location
 * that has accepted a view shows it; one that was given a main photo before views existed shows
 * that; anything else falls back to the conventional path, which for a location names a file that
 * has never existed and so renders as the quiet placeholder rather than a broken image.
 */
export function locationPortraitPath(world: WorldBundle | null | undefined, sheetId: string): string {
  const kit = world?.referenceKits.find((candidate) => candidate.sheetId === sheetId);
  const establishing = kit ? orderedLocationViews(kit)[0] : undefined;
  if (establishing) return `references/${sheetId}/${establishing.file}`;
  const photo = kit ? mainPhotoFor(kit) : null;
  return photo ? `references/${sheetId}/${photo.file}` : sheetPortraitPath(sheetId);
}
