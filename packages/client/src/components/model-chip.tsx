import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { findHarnessModel, harnessModelReference, type ClientState } from "@arke-studio/contracts";
import { ChevronDown } from "./icons.js";
import { harnessModelLabel, harnessModelUnavailableReason } from "./harness-models.js";
import { cx } from "./ui.js";
import { useOverlaysOpened } from "../lib/overlays.js";

/** The menu's distance from the chip, as it stood when it hung off the chip itself. */
const GAP = 8;
/** What the menu keeps clear of the window's edges. */
const EDGE = 8;

/**
 * The chat's model, in the composer's own row beside attach and voice (design turn 190e). It named
 * a row of its own above the composer, with a scope word (THIS TURN, CHAT AGENT, DEFAULT), two
 * links and a count of models; here it is the model's name and, opened, the models, then the one
 * press that makes the choice the production's. A dot says the choice is this chat's alone.
 *
 * One chip for every conversation composer, so what it offers follows what the conversation can
 * keep: a production's chats can remember a choice for every chat in the production; the founding
 * chat and production setup have nowhere to remember one, so they pass neither press and the chip
 * only picks for this chat; World Chat takes its model from Settings and the coordinator refuses
 * a named one outside a production, so it passes `readOnly` and the chip says which model answers.
 *
 * The menu is drawn on the body, fixed to the window beside the chip, never inside the composer.
 * Hung off the chip, it was clipped by the composer's own box: in the production dock `.fy-cx`
 * clips its overflow, and of a 320px menu holding ninety models the 40px inside the composer
 * showed — one or two names, read as the only two models there were (2026-10-04). The dock's
 * frame and the app's clip as well, so no z-index could have lifted it out; and every column here
 * enters with `fy-fade-up`, whose transform makes a fixed menu inside it fixed to that column, so
 * the body is the one place it can be drawn. Inside a block drawer (a modal `<dialog>`) it is drawn
 * on the dialog instead: the body outside a modal dialog is inert and under it.
 */
export function ModelChip({
  state,
  value,
  set,
  onPick,
  onRemember,
  onClear,
  disabled,
  needsTools = false,
  unsetLabel = "Use the saved choice",
  readOnly = false,
}: {
  state: ClientState | null;
  /** The model in force: this chat's, the agent's, the production's, else the harness's own. */
  value: string | undefined;
  /** The choice is this chat's, not the production's. */
  set: boolean;
  onPick: (id: string | undefined) => void;
  /** Present when the choice can be made the production's. */
  onRemember?: () => void;
  /** Present when the production has a remembered choice to let go of. */
  onClear?: () => void;
  disabled?: boolean;
  /** The conversation uses tools: a model that cannot is shown, and cannot be picked. */
  needsTools?: boolean;
  /** What letting go of this chat's choice is called, where "saved" would name nothing. */
  unsetLabel?: string;
  /** The model is named, not chosen here: no menu, no chevron, and nothing at all when it has no name to give. */
  readOnly?: boolean;
}) {
  /** Where the open menu is drawn; null while it is closed. */
  const [host, setHost] = useState<HTMLElement | null>(null);
  const open = host !== null;
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const opened = useOverlaysOpened();
  const openedAt = useRef(0);

  const close = (refocus: boolean) => {
    setHost(null);
    if (refocus) button.current?.focus({ preventScroll: true });
  };
  const show = () => {
    const chip = root.current;
    if (chip === null) return;
    openedAt.current = opened;
    setHost(chip.closest("dialog") ?? chip.ownerDocument.body);
  };

  /**
   * Above the chip when the menu fits there or there is more room above than below, else below;
   * never past the window's edges, and no taller than the room it is given. Measured afresh each
   * time, since a catalogue arriving changes the menu's height while it is open.
   */
  const place = () => {
    const panel = menu.current;
    const anchor = button.current;
    if (panel === null || anchor === null) return;
    const doc = panel.ownerDocument;
    const view = doc.defaultView;
    const viewHeight = view?.innerHeight || doc.documentElement.clientHeight || 0;
    const viewWidth = view?.innerWidth || doc.documentElement.clientWidth || 0;
    const chip = anchor.getBoundingClientRect();
    // The stylesheet's own cap measures the height the menu wants.
    panel.style.maxHeight = "";
    const wants = panel.getBoundingClientRect().height;
    const above = chip.top - GAP - EDGE;
    const below = viewHeight - chip.bottom - GAP - EDGE;
    const up = above >= wants || above >= below;
    const room = Math.max(0, up ? above : below);
    if (wants > room) panel.style.maxHeight = `${room}px`;
    panel.style.top = up ? "" : `${chip.bottom + GAP}px`;
    panel.style.bottom = up ? `${viewHeight - chip.top + GAP}px` : "";
    const width = panel.getBoundingClientRect().width;
    panel.style.left = `${Math.max(EDGE, Math.min(chip.left, viewWidth - width - EDGE))}px`;
    panel.setAttribute("data-side", up ? "up" : "down");
  };
  const placing = useRef(place);
  placing.current = place;
  const closing = useRef(close);
  closing.current = close;

  // Every render while open: the chip may have moved, or the menu's contents changed.
  useLayoutEffect(() => {
    if (open) place();
  });

  // The menu is not beside the chip in the page any more, so Tab from the chip would pass it by:
  // opening hands focus to the model in force, else the first that can be picked.
  useLayoutEffect(() => {
    const panel = menu.current;
    if (!open || panel === null) return;
    const target = panel.querySelector<HTMLButtonElement>("button[aria-checked=true]:not(:disabled)")
      ?? panel.querySelector<HTMLButtonElement>("button:not(:disabled)");
    if (target === null) return;
    target.focus({ preventScroll: true });
    const around = panel.getBoundingClientRect();
    const seat = target.getBoundingClientRect();
    if (seat.top < around.top) panel.scrollTop -= around.top - seat.top;
    else if (seat.bottom > around.bottom) panel.scrollTop += seat.bottom - around.bottom;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const doc = root.current?.ownerDocument ?? document;
    const view = doc.defaultView ?? window;
    const within = (element: Element | null, target: EventTarget | null) => element !== null && target !== null && element.contains(target as Node);
    const inside = (target: EventTarget | null) => within(root.current, target) || within(menu.current, target);
    // Capture, so a press elsewhere closes the menu even where that element stops propagation.
    const away = (event: MouseEvent) => {
      if (!inside(event.target)) closing.current(false);
    };
    // Only the menu goes: the dock, drawer or page behind it stays open.
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closing.current(true);
    };
    // Scrolling the dock under the menu is leaving it. A scroll nobody made — a reply streaming in
    // moves the column — only carries the chip, and the menu follows it.
    const wheel = (event: WheelEvent) => {
      if (!within(menu.current, event.target)) closing.current(false);
    };
    const moved = (event: Event) => {
      if (!within(menu.current, event.target)) placing.current();
    };
    const resized = () => placing.current();
    doc.addEventListener("mousedown", away, true);
    doc.addEventListener("keydown", key, true);
    view.addEventListener("wheel", wheel, true);
    doc.addEventListener("scroll", moved, true);
    view.addEventListener("resize", resized);
    return () => {
      doc.removeEventListener("mousedown", away, true);
      doc.removeEventListener("keydown", key, true);
      view.removeEventListener("wheel", wheel, true);
      doc.removeEventListener("scroll", moved, true);
      view.removeEventListener("resize", resized);
    };
  }, [open]);

  // A sheet opened after the menu stands in front of it, so the menu goes (overlays.ts).
  useEffect(() => {
    if (open && opened > openedAt.current) closing.current(false);
  }, [open, opened]);

  const models = state?.app.harnessModels ?? [];
  const manifest = state?.app.manifest?.models;
  const current = value ? findHarnessModel(value, models, manifest) : models.find((model) => model.isDefault);
  const label = current ? harnessModelLabel(state, current) : (value ?? "Model");
  // A catalogue still loading, or a harness that is not running, offers nothing to pick yet.
  const checking = state?.app.health.harness.status !== "healthy" || state?.app.harnessModelStatus?.status !== "ready";
  const ordered = [...models].sort((a, b) => Number(b.isDefault ?? false) - Number(a.isDefault ?? false));
  const reference = current ? harnessModelReference(current) : value;
  if (readOnly) {
    if (current === undefined && value === undefined) return null;
    return (
      <span className="fy-mchip">
        <span className="fy-mchip__btn fy-mchip__btn--fixed" aria-label="Language model" title="Chosen in Settings">
          <span className="fy-mchip__name">{label}</span>
        </span>
      </span>
    );
  }
  const choose = (id: string | undefined) => {
    onPick(id);
    close(true);
  };
  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Out of the menu by Tab is out from the chip: focus goes back to it before the browser moves
    // it on, so Tab lands after the chip and Shift+Tab before it, as when the menu followed it.
    if (event.key === "Tab") {
      close(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    if (items.length === 0) return;
    const at = items.findIndex((item) => item === item.ownerDocument.activeElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : at === -1 ? (event.key === "ArrowDown" ? 0 : items.length - 1)
      : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
  };
  const panel = (
    <div ref={menu} id={menuId} className="fy-mchip__menu" role="menu" aria-label="Language model" onKeyDown={onMenuKey}>
      {set && (
        <button type="button" role="menuitem" className="fy-mchip__item fy-mchip__item--quiet" onClick={() => choose(undefined)}>
          {unsetLabel}
        </button>
      )}
      {value !== undefined && (current === undefined || harnessModelReference(current) !== value) && (
        <button type="button" role="menuitemradio" aria-checked className="fy-mchip__item fy-mchip__item--on" disabled data-model={value}>
          <span>{current ? harnessModelLabel(state, current) : value}</span>
          <span className="fy-mchip__why">{current ? "saved" : "unavailable"}</span>
        </button>
      )}
      {ordered.map((model) => {
        const id = harnessModelReference(model);
        const reason = checking ? undefined : harnessModelUnavailableReason(state, model, false, needsTools);
        return (
          <button
            key={id}
            data-model={id}
            type="button"
            role="menuitemradio"
            aria-checked={id === reference}
            className={cx("fy-mchip__item", id === reference && "fy-mchip__item--on")}
            disabled={checking || reason !== undefined}
            onClick={() => choose(id)}
          >
            <span>{harnessModelLabel(state, model)}</span>
            {reason !== undefined && <span className="fy-mchip__why">{reason}</span>}
          </button>
        );
      })}
      {(onRemember !== undefined || onClear !== undefined) && <hr className="fy-mchip__rule" />}
      {onRemember !== undefined && (
        <button type="button" role="menuitem" className="fy-mchip__item fy-mchip__item--quiet" onClick={() => { onRemember(); close(true); }}>
          Every chat in this production
        </button>
      )}
      {onClear !== undefined && (
        <button type="button" role="menuitem" className="fy-mchip__item fy-mchip__item--quiet" onClick={() => { onClear(); close(true); }}>
          Clear the production&rsquo;s choice
        </button>
      )}
    </div>
  );
  return (
    <span className="fy-mchip" ref={root}>
      <button
        ref={button}
        type="button"
        className={cx("fy-mchip__btn", set && "fy-mchip__btn--set")}
        aria-label="Language model"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(event) => {
          if (open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
          event.preventDefault();
          show();
        }}
      >
        <span className="fy-mchip__name">{label}</span>
        <ChevronDown size={12} />
      </button>
      {host !== null && createPortal(panel, host)}
    </span>
  );
}
