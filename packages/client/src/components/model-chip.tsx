import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useInRouterContext, useNavigate } from "react-router";
import {
  findHarnessModel, harnessEffortLabel, harnessEffortLabels, harnessModelReference, titleCaseVariant,
  type ClientState,
} from "@arke-studio/contracts";
import { ProviderMark } from "../screens/settings-parts.js";
import { harnessModelLabel } from "./harness-models.js";
import { ChipChevron, PickerTick } from "./model-chip-icons.js";
import { ModelPicker } from "./model-picker.js";
import { modelGroups, providerHeading, recentModels } from "./model-picker-data.js";
import { cx } from "./ui.js";
import { useOverlaysOpened } from "../lib/overlays.js";
import { readRecentModels, rememberRecentModel } from "../lib/recent-models.js";

/** The layer's distance from the chip, as it stood when it hung off the chip itself. */
const GAP = 8;
/** What a layer keeps clear of the window's edges (design turn 195: 12). */
const EDGE = 12;

type MenuKind = "model" | "effort";

/**
 * A layer drawn on the body, fixed to the window beside the chip that opened it, never inside the
 * composer. Hung off the chip, the menu was clipped by the composer's own box: in the production
 * dock `.fy-cx` clips its overflow, and of a 320px menu holding ninety models the 40px inside the
 * composer showed — one or two names, read as the only two models there were (2026-10-04). The
 * dock's frame and the app's clip as well, so no z-index could have lifted it out; and every
 * column here enters with `fy-fade-up`, whose transform makes a fixed menu inside it fixed to that
 * column, so the body is the one place it can be drawn. Inside a block drawer (a modal `<dialog>`)
 * it is drawn on the dialog instead: the body outside a modal dialog is inert and under it.
 *
 * Above the chip when the layer fits there or there is more room above than below, else below;
 * never past the window's edges, and no taller than the room it is given. Closes on Escape, on a
 * press elsewhere, on scrolling what is under it, and when a sheet opens after it.
 */
function AnchoredLayer({
  host, anchor, root, panelRef, className, id, role, label, onClose, onEscape, onKeyDown, children,
}: {
  host: HTMLElement;
  anchor: RefObject<HTMLButtonElement | null>;
  /** The chip's own box: a press in it is the chip being used, not a press elsewhere. */
  root: RefObject<HTMLSpanElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  className: string;
  id: string;
  role: "dialog" | "menu";
  label: string;
  onClose: (refocus: boolean) => void;
  /** Asked before Escape closes; true means the layer used the key itself. */
  onEscape?: () => boolean;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  const opened = useOverlaysOpened();
  const openedAt = useRef(opened);
  /** Above or below, fixed when it opens so a search that shortens the list does not flip the layer. */
  const side = useRef<"up" | "down" | null>(null);

  const place = (again = false) => {
    const panel = panelRef.current;
    const chip = anchor.current;
    if (panel === null || chip === null) return;
    const doc = panel.ownerDocument;
    const view = doc.defaultView;
    const viewHeight = view?.innerHeight || doc.documentElement.clientHeight || 0;
    const viewWidth = view?.innerWidth || doc.documentElement.clientWidth || 0;
    const box = chip.getBoundingClientRect();
    // The stylesheet's own cap measures the height the layer wants.
    panel.style.maxHeight = "";
    const wants = panel.getBoundingClientRect().height;
    const above = box.top - GAP - EDGE;
    const below = viewHeight - box.bottom - GAP - EDGE;
    if (again || side.current === null) side.current = above >= wants || above >= below ? "up" : "down";
    const up = side.current === "up";
    const room = Math.max(0, up ? above : below);
    if (wants > room) panel.style.maxHeight = `${room}px`;
    panel.style.top = up ? "" : `${box.bottom + GAP}px`;
    panel.style.bottom = up ? `${viewHeight - box.top + GAP}px` : "";
    const width = panel.getBoundingClientRect().width;
    panel.style.left = `${Math.max(EDGE, Math.min(box.left, viewWidth - width - EDGE))}px`;
    panel.setAttribute("data-side", up ? "up" : "down");
  };
  const placing = useRef(place);
  placing.current = place;
  const closing = useRef(onClose);
  closing.current = onClose;
  const escaping = useRef(onEscape);
  escaping.current = onEscape;

  // Every render: the chip may have moved, or the contents changed.
  useLayoutEffect(() => { place(); });

  useEffect(() => {
    const doc = panelRef.current?.ownerDocument ?? document;
    const view = doc.defaultView ?? window;
    const within = (element: Element | null, target: EventTarget | null) => element !== null && target !== null && element.contains(target as Node);
    const inside = (target: EventTarget | null) => within(root.current, target) || within(panelRef.current, target);
    // Capture, so a press elsewhere closes the layer even where that element stops propagation.
    const away = (event: MouseEvent) => {
      if (!inside(event.target)) closing.current(false);
    };
    // Only the layer goes: the dock, drawer or page behind it stays open.
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (escaping.current?.() === true) return;
      closing.current(true);
    };
    // Scrolling the dock under the layer is leaving it. A scroll nobody made — a reply streaming in
    // moves the column — only carries the chip, and the layer follows it.
    const wheel = (event: WheelEvent) => {
      if (!within(panelRef.current, event.target)) closing.current(false);
    };
    const moved = (event: Event) => {
      if (!within(panelRef.current, event.target)) placing.current();
    };
    const resized = () => placing.current(true);
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
  }, []);

  // A sheet opened after the layer stands in front of it, so the layer goes (overlays.ts).
  useEffect(() => {
    if (opened > openedAt.current) closing.current(false);
  }, [opened]);

  return createPortal(
    <div ref={panelRef} id={id} className={className} role={role} aria-label={label} onKeyDown={onKeyDown}>
      {children}
    </div>,
    host,
  );
}

/** Tab from the last press, or Shift+Tab from the first, leaves the layer; the focus goes back to the chip first so Tab lands after it. */
function leavesOnTab(event: ReactKeyboardEvent<HTMLDivElement>, panel: HTMLDivElement | null): boolean {
  if (event.key !== "Tab" || panel === null) return false;
  const doc = panel.ownerDocument;
  const stops = [...panel.querySelectorAll<HTMLElement>("input, button:not(:disabled)")];
  if (stops.length === 0) return true;
  const at = stops.findIndex((stop) => stop === doc.activeElement);
  return event.shiftKey ? at <= 0 : at === stops.length - 1;
}

/** A tip drawn on the body for the same reason the menu is: the composer clips what hangs off it. */
function Tip({ anchor, children }: { anchor: HTMLElement; children: ReactNode }) {
  const box = anchor.getBoundingClientRect();
  const view = anchor.ownerDocument.defaultView;
  const viewHeight = view?.innerHeight || anchor.ownerDocument.documentElement.clientHeight || 0;
  return createPortal(
    <span role="tooltip" className="fy-mchip__tip" style={{ left: `${box.left}px`, bottom: `${viewHeight - box.top + 6}px` }}>{children}</span>,
    anchor.closest("dialog") ?? anchor.ownerDocument.body,
  );
}

/** Opens Settings at AI models: its own component because the hook it needs only exists inside a router. */
function useManageModels(): (() => void) | undefined {
  return useInRouterContext() ? useRouterManage() : undefined;
}
function useRouterManage(): () => void {
  const navigate = useNavigate();
  return () => navigate("/settings/models");
}

/**
 * The chat's model, in the composer's own row beside attach and voice (design turns 190e and 195).
 * It named a row of its own above the composer, with a scope word (THIS TURN, CHAT AGENT, DEFAULT),
 * two links and a count of models; here it is the provider's mark and the model's name and, opened,
 * a picker with search, the models in groups and a card for the one under the pointer, then the one
 * press that makes the choice the production's. A dot says the choice is this chat's alone, and a
 * second chip beside it names the effort for a model that offers one.
 *
 * One chip for every conversation composer, so what it offers follows what the conversation can
 * keep: a production's chats can remember a choice for every chat in the production; the founding
 * chat and production setup have nowhere to remember one, so they pass neither press and the chip
 * only picks for this chat; World Chat takes its model from Settings and the coordinator refuses
 * a named one outside a production, so it passes `readOnly` and the chip says which model answers.
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
  variant,
  onVariant,
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
  /** The effort in force for this model, in the harness's own name; absent means the harness's default. */
  variant?: string;
  /** Present when the effort can be chosen; the effort chip is drawn only then, and only for a model that offers one. */
  onVariant?: (variant: string) => void;
}) {
  /** Which layer is open and where it is drawn; null while both are closed. */
  const [menu, setMenu] = useState<{ kind: MenuKind; host: HTMLElement } | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const effortButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const escapeRef: MutableRefObject<(() => boolean) | null> = useRef(null);
  const menuId = useId();
  const listboxId = useId();
  const manage = useManageModels();
  const [tip, setTip] = useState<HTMLElement | null>(null);

  const closeMenu = (refocus: boolean) => {
    const kind = menu?.kind;
    setMenu(null);
    if (refocus) (kind === "effort" ? effortButton : button).current?.focus({ preventScroll: true });
  };
  const show = (kind: MenuKind) => {
    const chip = root.current;
    if (chip === null) return;
    setMenu({ kind, host: chip.closest("dialog") ?? chip.ownerDocument.body });
  };

  // The effort's menu is not beside its chip in the page any more, so Tab from the chip would pass
  // it by: opening hands focus to the effort in force, else the first.
  const effortOpening = menu?.kind === "effort";
  useLayoutEffect(() => {
    if (!effortOpening) return;
    const target = panel.current?.querySelector<HTMLButtonElement>("button[aria-checked=true]") ?? panel.current?.querySelector<HTMLButtonElement>("button");
    target?.focus({ preventScroll: true });
  }, [effortOpening]);

  const models = state?.app.harnessModels ?? [];
  const manifest = state?.app.manifest?.models;
  const current = value ? findHarnessModel(value, models, manifest) : models.find((model) => model.isDefault);
  const label = current ? harnessModelLabel(state, current) : (value ?? "Model");
  // A catalogue that is not one the harness has just confirmed — loading, failed, or the harness
  // stopped — offers nothing to pick; the menu still opens, so a saved choice can be let go of.
  const notReady = state?.app.health.harness.status !== "healthy" || state?.app.harnessModelStatus?.status !== "ready";
  // Only a catalogue on its way, or a harness still starting, is "Checking models": the chip waits
  // for it. A failed one is said under the composer, with its retry (harnessModelsNeedAWord), and
  // the chip stays open to use.
  const checking = state?.app.harnessModelStatus?.status === "loading" || state?.app.health.harness.status === "starting";
  const reference = current ? harnessModelReference(current) : value;

  if (readOnly) {
    if (current === undefined && value === undefined) return null;
    return (
      <span className="fy-mchip">
        <span
          className="fy-mchip__btn fy-mchip__btn--fixed"
          role="note"
          tabIndex={0}
          aria-label={`Language model: ${label}. Chosen in Settings`}
          onMouseEnter={(event) => setTip(event.currentTarget)}
          onMouseLeave={() => setTip(null)}
          onFocus={(event) => setTip(event.currentTarget)}
          onBlur={() => setTip(null)}
        >
          <span className="fy-mchip__name">{label}</span>
        </span>
        {tip !== null && <Tip anchor={tip}>Chosen in Settings</Tip>}
      </span>
    );
  }

  const choose = (id: string | undefined) => {
    if (id !== undefined) rememberRecentModel(id);
    onPick(id);
    closeMenu(true);
  };
  const open = menu?.kind === "model";
  const effortOpen = menu?.kind === "effort";

  const groups = open ? modelGroups(state, models, notReady, needsTools) : [];
  const recent = open ? recentModels(state, groups, readRecentModels()) : [];
  const lost = value !== undefined && (current === undefined || harnessModelReference(current) !== value)
    ? { label: current ? harnessModelLabel(state, current) : value, tag: current ? "saved" : "unavailable", value }
    : null;

  // The effort chip: only for a model that declares variants, and only where the host can keep a choice.
  const variants = current?.variants;
  const effortShown = variants !== undefined && onVariant !== undefined;
  const inForce = variant !== undefined && variants?.names.includes(variant) ? variant : variants?.default;
  const effortLabel = variants === undefined ? "" : inForce === undefined ? "Effort" : (harnessEffortLabel(variants, inForce) ?? titleCaseVariant(inForce));
  const efforts = variants === undefined ? [] : harnessEffortLabels(variants.names);

  const onEffortKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Out of the menu by Tab is out from the chip: focus goes back to it before the browser moves
    // it on, so Tab lands after the chip and Shift+Tab before it, as when the menu followed it.
    if (event.key === "Tab") {
      closeMenu(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const items = [...(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    if (items.length === 0) return;
    const at = items.findIndex((item) => item === item.ownerDocument.activeElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : at === -1 ? (event.key === "ArrowDown" ? 0 : items.length - 1)
      : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
  };
  return (
    <span className="fy-mchip" ref={root}>
      <button
        ref={button}
        type="button"
        className={cx("fy-mchip__btn", set && "fy-mchip__btn--set", current === undefined && "fy-mchip__btn--bare")}
        aria-label="Language model"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled || checking}
        title={checking ? "Checking models" : undefined}
        onClick={() => (open ? closeMenu(false) : show("model"))}
        onKeyDown={(event) => {
          if (open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
          event.preventDefault();
          show("model");
        }}
      >
        {current !== undefined && <ProviderMark id={current.provider} label={providerHeading(current.provider, [current])} size="xs" />}
        <span className="fy-mchip__name">{label}</span>
        <ChipChevron />
      </button>
      {effortShown && (
        <button
          ref={effortButton}
          type="button"
          className="fy-mchip__btn fy-mchip__btn--effort"
          aria-label="Effort"
          aria-haspopup="menu"
          aria-expanded={effortOpen}
          aria-controls={effortOpen ? `${menuId}-effort` : undefined}
          disabled={disabled || checking}
          onClick={() => (effortOpen ? closeMenu(false) : show("effort"))}
          onKeyDown={(event) => {
            if (effortOpen || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
            event.preventDefault();
            show("effort");
          }}
        >
          <span className="fy-mchip__name">{effortLabel}</span>
          <ChipChevron />
        </button>
      )}
      {menu !== null && open && (
        <AnchoredLayer
          host={menu.host}
          anchor={button}
          root={root}
          panelRef={panel}
          className="fy-mchip__menu fy-mpick"
          id={menuId}
          role="dialog"
          label="Language model"
          onClose={closeMenu}
          onEscape={() => escapeRef.current?.() ?? false}
          onKeyDown={(event) => { if (leavesOnTab(event, panel.current)) closeMenu(true); }}
        >
          <ModelPicker
            groups={groups}
            recent={recent}
            total={models.length}
            reference={reference}
            lost={lost}
            set={set}
            unsetLabel={unsetLabel}
            listboxId={listboxId}
            panelRef={panel}
            escapeRef={escapeRef}
            onChoose={choose}
            {...(onRemember !== undefined ? { onRemember: () => { onRemember(); closeMenu(true); } } : {})}
            {...(onClear !== undefined ? { onClear: () => { onClear(); closeMenu(true); } } : {})}
            onManage={() => { closeMenu(false); manage?.(); }}
          />
        </AnchoredLayer>
      )}
      {menu !== null && effortOpen && variants !== undefined && onVariant !== undefined && (
        <AnchoredLayer
          host={menu.host}
          anchor={effortButton}
          root={root}
          panelRef={panel}
          className="fy-mchip__menu fy-mchip__menu--effort"
          id={`${menuId}-effort`}
          role="menu"
          label="Effort"
          onClose={closeMenu}
          onKeyDown={onEffortKey}
        >
          <div className="fy-mpick__grp fy-mpick__grp--first" role="presentation">Effort</div>
          {variants.names.map((name, index) => (
            <button
              key={name}
              type="button"
              role="menuitemradio"
              aria-checked={name === inForce}
              data-variant={name}
              className={cx("fy-mpick__row", name === inForce && "fy-mpick__row--on")}
              onClick={() => { onVariant(name); closeMenu(true); }}
            >
              <span className="fy-mpick__name">{efforts[index]}</span>
              {name === inForce && <PickerTick />}
            </button>
          ))}
        </AnchoredLayer>
      )}
    </span>
  );
}
