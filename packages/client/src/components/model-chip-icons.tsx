import type { ReactNode } from "react";

/**
 * The picker's own glyphs, drawn as design turn 195 draws them: a house stroke would be lighter
 * than the chip's chevron and the tick, which are 2 and 2.4 there, and the frames are binding.
 */
function glyph(size: number, strokeWidth: number, joined: boolean, children: ReactNode) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      {...(joined ? { strokeLinejoin: "round" as const } : {})}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const ChipChevron = () => glyph(12, 2, true, <path d="m6 9 6 6 6-6" />);
export const PickerTick = () => glyph(14, 2.4, true, <path d="M5 12.5l4.5 4.5L19 7.5" />);
export const PickerSearch = () => glyph(15, 2, false, <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>);
export const PickerSliders = () => glyph(15, 1.8, false, <><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>);
/** The effort with no default to name, where the row has no room for the word (local.16). */
export const ChipGauge = () => glyph(15, 1.8, true, <><path d="M4.5 17a8.5 8.5 0 1 1 15 0" /><path d="m12 14 3.5-4" /></>);
export const PickerInfo =() => glyph(14, 1.8, false, <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></>);
