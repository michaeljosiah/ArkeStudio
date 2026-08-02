import { cx } from "./ui.js";

/**
 * The one loading state.
 *
 * Ten were drawn (design-system/loading.html) and this is the one adopted for every wait in the
 * app: the A of the wordmark with a band of light crossing it. It won on the properties that
 * matter for a house loader rather than on being the prettiest —
 *
 *   · nothing about it moves, so it can sit inside a line of text without shoving anything;
 *   · it is a glyph and a gradient, so it reads at 14px beside a sentence and at 44px alone;
 *   · its stopped state is a solid letter, which is the whole of it — nothing is lost by holding
 *     still, so the reduced-motion path costs one rule rather than a second design;
 *   · it is the mark, not a spinner with the mark parked in it.
 *
 * It is deliberately indeterminate. Where a real percentage exists — first-run setup — the app
 * already shows the number, and a number beats an animation every time.
 */
export function Loading({
  label,
  inline = false,
  size,
}: {
  /** What is being waited on. Almost always worth saying; a loader without a subject is a shrug. */
  label?: string;
  /** Beside a line of text rather than alone on a screen. */
  inline?: boolean;
  size?: number;
}) {
  return (
    <div className={cx("fy-loading", inline && "fy-loading--inline")} role="status" aria-live="polite">
      <span className="fy-loading__mark" style={size ? { fontSize: size } : undefined} aria-hidden>
        A
      </span>
      {label && <span className="fy-loading__label">{label}</span>}
    </div>
  );
}
