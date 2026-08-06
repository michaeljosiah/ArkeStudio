import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import { Portrait } from "./portrait.js";
import { X } from "./icons.js";
import { cx } from "./ui.js";

/**
 * A world image that opens larger where it stands.
 *
 * Three screens had grown their own copy of this: the cast listing's featured portrait, the
 * reference page's character sheet, and now the two main photos. They agreed on the important
 * parts and differed only in class names, so this is that agreement written once.
 *
 * A native <dialog> with showModal() rather than a hand-rolled overlay, because it brings the
 * focus trap, Esc, and background inerting with it. Two things the copies got right and are worth
 * keeping deliberately: focus returns to the trigger on close, and a click that lands on the
 * dialog itself rather than its panel is a backdrop click and dismisses.
 *
 * The trigger disables until the image actually loads. A picture that has not arrived cannot be
 * enlarged, and a button that opens an empty frame reads as broken.
 */
export function ImageDialog({
  worldSlug,
  path,
  label,
  dialogLabel,
  title,
  subtitle,
  triggerLabel,
  closeLabel,
  triggerClassName,
  triggerRadius = 9,
  dialogClassName,
  dialogRadius = 9,
}: {
  worldSlug: string | undefined;
  /** World-relative media path, shown both in the trigger and enlarged. */
  path: string;
  label: string;
  /**
   * Alt for the enlarged copy, when it can say more than the thumbnail's. In a grid the tile is
   * captioned by everything around it; the dialog has only its own alt to go on.
   */
  dialogLabel?: string;
  /** Heading inside the dialog. */
  title: ReactNode;
  /**
   * What this picture is, under the name — "main photo", "character sheet". The canvas (42a)
   * splits the two rather than running them together on one line, so the subject reads first and
   * the kind sits under it in mono, the way every other metadata line in the app does.
   */
  subtitle?: ReactNode;
  /** Accessible name for the trigger. */
  triggerLabel: string;
  /** Accessible name for the close button; defaults from the trigger's subject. */
  closeLabel?: string;
  triggerClassName: string;
  triggerRadius?: number;
  /** Extra class on the dialog, for screens that size it differently. */
  dialogClassName?: string;
  dialogRadius?: number;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  /*
   * Which picture is known to have arrived, rather than a bare "something has".
   *
   * A different picture has not loaded yet, whatever the last one did — the trigger must not stay
   * enabled across a change of subject and open an empty frame. That used to be an effect that
   * reset the flag, which raced the load it was guarding: for a cached image the load can settle
   * during the first paint, and the mount pass of the effect then set it straight back to false.
   * Comparing against the current path decides the same thing during render, with nothing to race.
   */
  const subject = `${worldSlug ?? ""}|${path}`;
  const [loaded, setLoaded] = useState<string | null>(null);
  const available = loaded === subject;
  const onAvailabilityChange = useCallback(
    (ok: boolean) => setLoaded(ok ? subject : null),
    [subject],
  );
  const close = () => dialog.current?.close();

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={triggerClassName}
        aria-label={triggerLabel}
        aria-haspopup="dialog"
        disabled={!available}
        onClick={() => dialog.current?.showModal()}
      >
        <Portrait
          worldSlug={worldSlug}
          path={path}
          label={label}
          radius={triggerRadius}
          onAvailabilityChange={onAvailabilityChange}
        />
      </button>
      <dialog
        ref={dialog}
        className={cx("fy-portrait-dialog", dialogClassName)}
        aria-labelledby={titleId}
        onClose={() => trigger.current?.focus()}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <div className="fy-portrait-dialog__panel">
          <div className="fy-portrait-dialog__head">
            <div className="fy-portrait-dialog__titles">
              <h2 id={titleId}>{title}</h2>
              {subtitle && <div className="fy-portrait-dialog__sub">{subtitle}</div>}
            </div>
            <button
              type="button"
              className="fy-portrait-dialog__close"
              aria-label={closeLabel ?? "Close"}
              onClick={close}
            >
              <X size={18} />
            </button>
          </div>
          <div className="fy-portrait-dialog__image">
            <Portrait worldSlug={worldSlug} path={path} label={dialogLabel ?? label} radius={dialogRadius} />
          </div>
        </div>
      </dialog>
    </>
  );
}
