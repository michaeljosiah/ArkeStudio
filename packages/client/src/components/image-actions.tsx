import { useState } from "react";
import { toast } from "sonner";
import { Download } from "./icons.js";
import { cx } from "./ui.js";
import { downloadMedia, downloadNameFor } from "../lib/download.js";

/**
 * The one control that saves a picture out of the app (issue 478).
 *
 * It sits over the image rather than under it, on the secondary-action pattern the audio buttons
 * already use (design 3a): out of the way until the pointer is on the picture or something inside
 * the frame holds focus, and revealed with opacity so nothing moves when it appears. Its host is
 * whatever box the picture fills — give that box `fy-imghost`.
 *
 * Written once and passed around rather than copied into each screen, because the part that
 * decays is the accessible name and the click isolation, and those are the same everywhere.
 */
export function ImageDownload({
  worldSlug,
  path,
  /** A human name for the picture. The extension always comes from the file, never from here. */
  name,
  /**
   * Whether the bytes are known to be there. A control that would save an empty response is a
   * promise the screen cannot keep, so it disables instead of failing after the click.
   */
  ready = true,
  className,
}: {
  worldSlug: string | undefined;
  /** World-relative media path — the same one the `<img>` was given. */
  path: string;
  name?: string;
  ready?: boolean;
  className?: string;
}) {
  const [saving, setSaving] = useState(false);
  const filename = downloadNameFor(path, name);
  const label = `Download ${filename}`;
  const available = Boolean(worldSlug) && path !== "" && ready;
  return (
    <button
      type="button"
      className={cx("fy-imgdl", className)}
      // The picture underneath is usually inside something that opens, selects or accepts on
      // click. Saving a copy is none of those, so the event stops here — at the pointer press
      // as well, since a card that arms on mousedown would otherwise still fire.
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (saving || !available) return;
        setSaving(true);
        void downloadMedia(worldSlug, path, name).then((outcome) => {
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
      disabled={!available || saving}
      aria-label={label}
      title={available ? label : "That image is not here to save"}
    >
      <Download size={13} />
    </button>
  );
}
