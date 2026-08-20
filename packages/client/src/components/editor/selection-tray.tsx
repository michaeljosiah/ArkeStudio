import type { BibleHelperKind } from "@arke-studio/contracts";
import { ChevronsDown, ChevronsUp, Message, Sparkle } from "../icons.js";
import { cx } from "../ui.js";
import { SELECTION_HELPERS, type SelectionState } from "./selection-actions.js";

/**
 * The tray of helpers that appears under a selection.
 *
 * Art kept out of `selection-actions.ts` for the reason the block menu keeps it out of
 * `slash-commands.ts`: the catalogue stays plain data, testable without React.
 */
const ICONS: Record<BibleHelperKind, typeof Sparkle> = {
  rewrite: Sparkle,
  expand: ChevronsDown,
  tighten: ChevronsUp,
  ask: Message,
};

interface SelectionTrayProps {
  state: SelectionState;
  /** The helper mid-flight, or null. One run at a time — a second press has nowhere to land. */
  running: BibleHelperKind | null;
  onRun: (kind: BibleHelperKind) => void;
}

export function SelectionTray({ state, running, onRun }: SelectionTrayProps) {
  return (
    <div
      className="fy-seltray"
      style={{ left: state.left, top: state.top }}
      role="toolbar"
      aria-label="Helpers for the selected text"
    >
      {SELECTION_HELPERS.map((helper) => {
        const Icon = ICONS[helper.kind];
        const busy = running === helper.kind;
        return (
          <button
            key={helper.kind}
            type="button"
            className={cx("fy-seltray__item", busy && "is-running")}
            // Taking focus would collapse the selection the helper is about to act on — the same
            // trap the block menu's rows avoid, and here it would also close the tray mid-press.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onRun(helper.kind)}
            disabled={running !== null}
            aria-busy={busy}
          >
            <span className="fy-seltray__icon">
              <Icon size={13} />
            </span>
            {helper.label}
          </button>
        );
      })}
    </div>
  );
}
