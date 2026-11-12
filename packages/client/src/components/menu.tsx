// The tool menu a row opens: its items, options and presses, and the popover under them (issue 2816).
import { useState, useRef, useEffect, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { More, ChevronDown, ChevronRight } from "./icons.js";

/**
 * A toolbar press and what it opens under it (design turn 194): open on press, closed by Escape —
 * focus back on the press — or by a press outside both. The reading menu's own rule, shared by the
 * Direct and illustrate menu, the speaker filter and the notes.
 */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const press = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (panel.current?.contains(event.target as Node) || press.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    // Escape closes it wherever the focus is. The panel's own key handler only heard it from inside:
    // Notes opens without taking the focus, so its Escape went to the press and the sheet stayed
    // open (local.15). Captured, so only this goes — the block drawer or dock behind it stays.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      press.current?.focus();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) press.current?.focus();
  };
  const onKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...(panel.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? [])];
    if (items.length === 0) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[(at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  };
  return { open, setOpen, press, panel, close, onKey };
}

/** One item of a toolbar menu: the label, its state at the right in mono, and its press. */
export type ToolMenuItem = { key: string; label: string; state: string; disabled: boolean; testId?: string; mark?: ReactNode; section?: string; separator?: boolean } & ({ press: () => void; children?: never } | { children: readonly ToolMenuItem[]; press?: never });

/**
 * Direct and illustrate (design turn 194, rule 3): one press, its menu drawn with the reading
 * menu's primitive, each item saying where it stands. The items keep the head's handlers.
 */
export function ToolMenu({ label, items, testId, icon = false, lead }: {
  label: string;
  items: readonly ToolMenuItem[];
  testId?: string;
  /** Below 1100 (194, rule 15) the press is a ⋯ and the label is its name. */
  icon?: boolean;
  /**
   * Presses that head the menu (design turn 198j: the lines to cast, on a phone), under their own
   * heading and over a rule; the menu's own items are then one row, `label ›`, that opens them.
   */
  lead?: { head: string; items: readonly ToolMenuItem[]; /** Presses under the rule, before the menu's own row (part A's Reset). */ also?: readonly ToolMenuItem[] };
}) {
  const pop = usePopover();
  const [inner, setInner] = useState(false);
  const [submenu, setSubmenu] = useState<ToolMenuItem | null>(null);
  useEffect(() => {
    if (!pop.open) { setInner(false); setSubmenu(null); }
  }, [pop.open]);
  useEffect(() => {
    if (pop.open) pop.panel.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [pop.open, inner, submenu]);
  const leading = lead !== undefined && lead.items.length > 0 && !inner;
  if (leading) {
    return (
      <span className="fy-ab__tool">
        <button
          ref={pop.press}
          type="button"
          className={icon ? `fy-ab__ico${pop.open ? " fy-ab__ico--on" : ""}` : `fy-ab__pill${pop.open ? " fy-ab__pill--on" : ""}`}
          aria-haspopup="menu"
          aria-expanded={pop.open}
          {...(icon ? { "aria-label": label, title: label } : {})}
          onClick={() => pop.setOpen((was) => !was)}
          {...(testId !== undefined ? { "data-testid": testId } : {})}
        >
          {icon ? <More size={16} /> : <>{label}<ChevronDown size={13} stroke={2} aria-hidden="true" /></>}
        </button>
        {pop.open && (
          <div ref={pop.panel} className="fy-ab__menu fy-ab__toolmenu fy-ab__toolmenu--end fy-ab__toolmenu--lead" role="menu" aria-label={label} onKeyDown={pop.onKey}>
            <div className="fy-ab__menu-hd">{lead.head}</div>
            {lead.items.map((item) => <ToolMenuOption key={item.key} item={item} onDone={() => pop.close(false)} />)}
            <div className="fy-ab__menu-rule" role="separator" />
            {(lead.also ?? []).map((item) => <ToolMenuOption key={item.key} item={item} onDone={() => pop.close(false)} />)}
            <button type="button" role="menuitem" className="fy-ab__menu-opt" onClick={() => setInner(true)} data-testid={testId !== undefined ? `${testId}-items` : undefined}>
              <span className="fy-ab__menu-label">{label}</span>
              <ChevronRight size={13} stroke={2} aria-hidden="true" />
            </button>
          </div>
        )}
      </span>
    );
  }
  return (
    <span className="fy-ab__tool">
      <button
        ref={pop.press}
        type="button"
        className={icon ? `fy-ab__ico${pop.open ? " fy-ab__ico--on" : ""}` : `fy-ab__pill${pop.open ? " fy-ab__pill--on" : ""}`}
        aria-haspopup="menu"
        aria-expanded={pop.open}
        {...(icon ? { "aria-label": label, title: label } : {})}
        onClick={() => pop.setOpen((was) => !was)}
        {...(testId !== undefined ? { "data-testid": testId } : {})}
      >
        {icon ? (
          <More size={16} />
        ) : (
          <>
            {label}
            <ChevronDown size={13} stroke={2} aria-hidden="true" />
          </>
        )}
      </button>
      {pop.open && (
        <div ref={pop.panel} className="fy-ab__menu fy-ab__toolmenu fy-ab__toolmenu--end" role="menu" aria-label={label} onKeyDown={pop.onKey}>
          {submenu !== null && <div className="fy-ab__menu-hd">{submenu.label}</div>}
          {(submenu?.children ?? items).map((item) => <ToolMenuOption key={item.key} item={item} onChildren={() => setSubmenu(item)} onDone={() => pop.close(false)} />)}
        </div>
      )}
    </span>
  );
}

/** One item of a toolbar menu, as the toolbar's menus draw it: its label, its state at the right. */
function ToolMenuOption({ item, onDone, onChildren }: { item: ToolMenuItem; onDone: () => void; onChildren?: () => void }) {
  return (
    <>
    {item.separator && <div className="fy-ab__menu-rule" role="separator" />}
    {item.section !== undefined && <div className="fy-ab__menu-hd">{item.section}</div>}
    <button
      type="button"
      role="menuitem"
      aria-disabled={item.disabled}
      className="fy-ab__menu-opt"
      aria-haspopup={item.children !== undefined ? "menu" : undefined}
      onClick={() => {
        if (item.disabled) return;
        if (item.children !== undefined) { onChildren?.(); return; }
        onDone();
        item.press();
      }}
      {...(item.testId !== undefined ? { "data-testid": item.testId } : {})}
    >
      {item.mark}
      <span className="fy-ab__menu-label">{item.label}</span>
      {item.state !== "" && <span className="fy-ab__menu-meta">{item.state}</span>}
      {item.children !== undefined && <ChevronRight size={13} stroke={2} aria-hidden="true" />}
    </button>
    </>
  );
}

/**
 * A press and the menu it opens (design turn 198): `2 paragraphs to cast ▾` on the toolbar, after
 * the speaker filter, with its stale dot, and the Voices rail's `Cast again` — both offering
 * `Cast 2 paragraphs` and `Cast the chapter` with its count of paragraphs.
 */
export function MenuPress({ label, items, testId, className, disabled = false, end = false }: { label: ReactNode; items: readonly ToolMenuItem[]; testId: string; className: string; disabled?: boolean; /** The menu's right edge under the press's, for a press at the window's edge. */ end?: boolean }) {
  const pop = usePopover();
  useEffect(() => {
    if (pop.open) pop.panel.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [pop.open]);
  return (
    <span className="fy-ab__tool">
      <button
        ref={pop.press}
        type="button"
        className={`${className}${pop.open ? ` ${className}--on` : ""}`}
        aria-haspopup="menu"
        aria-expanded={pop.open}
        disabled={disabled}
        onClick={() => pop.setOpen((was) => !was)}
        data-testid={testId}
      >
        {label}
      </button>
      {pop.open && (
        <div ref={pop.panel} className={`fy-ab__menu fy-ab__toolmenu fy-ab__castmenu${end ? " fy-ab__toolmenu--end" : ""}`} role="menu" aria-label="Cast" onKeyDown={pop.onKey}>
          {items.map((item) => <ToolMenuOption key={item.key} item={item} onDone={() => pop.close(false)} />)}
        </div>
      )}
    </span>
  );
}
