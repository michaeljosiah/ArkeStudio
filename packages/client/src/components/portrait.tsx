import { useEffect, useState } from "react";
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
  if (!worldSlug || failed) {
    return (
      <div className="fy-portrait--fallback" style={{ borderRadius: radius }}>
        {label}
      </div>
    );
  }
  return (
    <img
      className="fy-portrait"
      style={{ borderRadius: radius }}
      src={mediaUrl(worldSlug, path)}
      alt={label}
      draggable={false}
      onLoad={() => onAvailabilityChange?.(true)}
      onError={() => {
        setFailed(true);
        onAvailabilityChange?.(false);
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
