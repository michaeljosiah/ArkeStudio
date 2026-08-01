import { useState } from "react";
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
}: {
  worldSlug: string | undefined;
  /** World-relative media path, e.g. "references/maren-kest/head-front.png". */
  path: string;
  label: string;
  radius?: number;
}) {
  const [failed, setFailed] = useState(false);
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
      onError={() => setFailed(true)}
    />
  );
}

/** The conventional portrait path for a sheet: its kit's front tile. */
export function sheetPortraitPath(sheetId: string): string {
  return `references/${sheetId}/head-front.png`;
}
