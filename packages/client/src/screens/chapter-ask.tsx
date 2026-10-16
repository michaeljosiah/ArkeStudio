import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronRight, Quote, Sparkle } from "../components/icons.js";
import { cx } from "../components/ui.js";
import { ownAsk, TONE_ACTIONS, toneAction, type PassageAction } from "../lib/passage-actions.js";

/*
 * The selection bar and the Ask Arke menu (design turn 227p–q, SPEC-056 R-22, R-23): what a
 * selection in the writing room offers. The bar formats in place; Ask Arke opens the menu under
 * the selection, whose rewrites come back into the page (R-24) without opening Chat, and whose
 * replies and Open in Arke are Chat's. The asks themselves are `passage-actions.ts`'s list.
 */

/** Where the bar and the menu sit, in the manuscript's own coordinates. */
export type BarAt = {
  top: number;
  left: number;
  below: number;
  end: boolean;
  /** Change tone opens on the left: the menu and its tones together do not fit to the right. */
  subEnd?: boolean;
};

/** One rule for the gate's refusal (SPEC-012 R-58a), said in one clause on Ask Arke. */
export function passageRefusal(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (/\r?\n[ \t]*\r?\n/.test(trimmed)) return "Select within one paragraph";
  if (trimmed.length > 1_200) return "Select at most 1,200 characters";
  if (trimmed.split(/\s+/).filter(Boolean).length < 3) return "Select at least three words";
  return null;
}

export function SelectionBar({ at, format, words, held, refused, actions, onAsk, onOpenInArke }: {
  at: BarAt;
  /** The editor's marks for the selection, or null in the Markdown source, where there are none. */
  format: null | { bold: boolean; italic: boolean; quote: boolean; onBold: () => void; onItalic: () => void; onQuote: () => void };
  words: number;
  /** Why nothing can be asked yet (not saved, saving…, asking…), said on the press. */
  held?: string;
  /** Why this selection is not a passage, as Ask Arke's tooltip (R-22). */
  refused: string | null;
  actions: readonly PassageAction[];
  onAsk: (action: PassageAction) => void;
  onOpenInArke: () => void;
}) {
  const [open, setOpen] = useState(false);
  const press = useRef<HTMLButtonElement | null>(null);
  const [fromKeys, setFromKeys] = useState(false);
  useEffect(() => {
    if (held !== undefined || refused !== null) setOpen(false);
  }, [held, refused]);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) press.current?.focus();
  };
  return (
    <div className="fy-selbar-wrap" style={{ top: at.top, left: at.left }}>
      <div className="fy-selbar" role="toolbar" aria-label="Selection" data-testid="selection-bar">
        {format !== null && (
          <>
            <button type="button" className={cx("fy-selbar__btn", format.bold && "fy-selbar__btn--on")} aria-label="Bold" aria-pressed={format.bold} onMouseDown={(e) => e.preventDefault()} onClick={format.onBold}><b>B</b></button>
            <button type="button" className={cx("fy-selbar__btn", format.italic && "fy-selbar__btn--on")} aria-label="Italic" aria-pressed={format.italic} onMouseDown={(e) => e.preventDefault()} onClick={format.onItalic}><i>I</i></button>
            <button type="button" className={cx("fy-selbar__btn", format.quote && "fy-selbar__btn--on")} aria-label="Quote" aria-pressed={format.quote} onMouseDown={(e) => e.preventDefault()} onClick={format.onQuote}><Quote size={14} /></button>
            <span className="fy-selbar__sep" aria-hidden="true" />
          </>
        )}
        <button
          ref={press}
          type="button"
          className="fy-ch__ask fy-selbar__ask"
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={held !== undefined || refused !== null}
          title={refused ?? undefined}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            // A click with no pointer behind it (detail 0) is Enter or Space: the keys go into the menu.
            if (!open && e.detail === 0) setFromKeys(true);
            setOpen((was) => !was);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setFromKeys(true);
              setOpen(true);
            }
          }}
        >
          <Sparkle size={13} />
          {held !== undefined ? `Ask Arke · ${held}` : refused !== null ? "Ask Arke" : `Ask Arke · ${words.toLocaleString()} words`}
        </button>
      </div>
      {open && (
        <AskArkeMenu
          below={at.below - at.top}
          end={at.end}
          subEnd={at.subEnd ?? at.end}
          actions={actions}
          focusFirst={fromKeys}
          onFocused={() => setFromKeys(false)}
          onAsk={(action) => {
            close(false);
            onAsk(action);
          }}
          onOpenInArke={() => {
            close(false);
            onOpenInArke();
          }}
          onClose={() => close(true)}
        />
      )}
    </div>
  );
}

const REWRITES = ["tighten", "expand", "simplify", "vivid"];
const REPLIES = ["style", "critique"];

/**
 * The menu under the selection (R-23): a field for the author's own words, the rewrites, Change
 * tone ›, the replies marked as such, and Open in Arke. Arrows move, Enter chooses, → opens Change
 * tone and ← or Esc comes back, Esc again closes.
 */
function AskArkeMenu({ below, end, subEnd, actions, focusFirst, onFocused, onAsk, onOpenInArke, onClose }: {
  below: number;
  end: boolean;
  subEnd: boolean;
  actions: readonly PassageAction[];
  focusFirst: boolean;
  onFocused: () => void;
  onAsk: (action: PassageAction) => void;
  onOpenInArke: () => void;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement | null>(null);
  const sub = useRef<HTMLDivElement | null>(null);
  const toneItem = useRef<HTMLButtonElement | null>(null);
  const [own, setOwn] = useState("");
  const [tones, setTones] = useState(false);
  const [tone, setTone] = useState("");
  useEffect(() => {
    if (!focusFirst) return;
    menu.current?.querySelector<HTMLElement>(".fy-askm__field")?.focus();
    onFocused();
  }, [focusFirst, onFocused]);
  useEffect(() => {
    if (tones) sub.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [tones]);
  const rewrites = REWRITES.flatMap((id) => actions.filter((action) => action.id === id));
  const replies = REPLIES.flatMap((id) => actions.filter((action) => action.id === id));
  const move = (container: HTMLElement | null, by: number) => {
    const stops = [...(container?.querySelectorAll<HTMLElement>(":scope > .fy-askm__field, :scope > [role=menuitem], :scope > div > [role=menuitem], :scope > .fy-askm__tone-field") ?? [])];
    const at = stops.indexOf(document.activeElement as HTMLElement);
    stops[(at + by + stops.length) % stops.length]?.focus();
  };
  const keys = (e: ReactKeyboardEvent, container: HTMLElement | null, inner: boolean) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      move(container, e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Escape" || (inner && e.key === "ArrowLeft" && !(e.target instanceof HTMLInputElement))) {
      e.preventDefault();
      e.stopPropagation();
      if (inner) {
        setTones(false);
        toneItem.current?.focus();
      } else onClose();
    }
  };
  return (
    <div
      ref={menu}
      className={cx("fy-askm", end && "fy-askm--end")}
      style={{ top: below }}
      role="menu"
      aria-label="Ask about this passage"
      onKeyDown={(e) => keys(e, menu.current, false)}
    >
      <input
        className="fy-askm__field"
        aria-label="Ask Arke about this"
        placeholder="Ask Arke about this…"
        value={own}
        onChange={(e) => setOwn(e.target.value)}
        onKeyDown={(e) => {
          // Enter that commits an IME candidate is not a send.
          if (e.key === "Enter" && !e.nativeEvent.isComposing && own.trim() !== "") {
            e.preventDefault();
            onAsk(ownAsk(own));
          }
        }}
      />
      {rewrites.map((action) => (
        <button key={action.id} type="button" role="menuitem" className="fy-askm__item" onMouseDown={(e) => e.preventDefault()} onClick={() => onAsk(action)}>
          {action.label}
        </button>
      ))}
      <div className="fy-askm__tone">
        <button
          ref={toneItem}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={tones}
          className={cx("fy-askm__item", tones && "fy-askm__item--on")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setTones((was) => !was)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") {
              e.preventDefault();
              setTones(true);
            }
          }}
        >
          <span>Change tone</span>
          <ChevronRight size={13} />
        </button>
        {tones && (
          <div ref={sub} className={cx("fy-askm fy-askm__sub", subEnd && "fy-askm__sub--end")} role="menu" aria-label="Change tone" onKeyDown={(e) => keys(e, sub.current, true)}>
            {TONE_ACTIONS.map((action) => (
              <button key={action.id} type="button" role="menuitem" className="fy-askm__item" onMouseDown={(e) => e.preventDefault()} onClick={() => onAsk(action)}>
                {action.label}
              </button>
            ))}
            <input
              className="fy-askm__field fy-askm__tone-field"
              aria-label="Another tone"
              placeholder="Another tone…"
              value={tone}
              onChange={(e) => setTone(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && tone.trim() !== "") {
                  e.preventDefault();
                  onAsk(toneAction(tone));
                }
              }}
            />
          </div>
        )}
      </div>
      {replies.length > 0 && <hr className="fy-askm__rule" />}
      {replies.map((action) => (
        <button key={action.id} type="button" role="menuitem" className="fy-askm__item" onMouseDown={(e) => e.preventDefault()} onClick={() => onAsk(action)}>
          <span>{action.label}</span>
          <span className="fy-askm__reply">Reply</span>
        </button>
      ))}
      <hr className="fy-askm__rule" />
      <button type="button" role="menuitem" className="fy-askm__item" onMouseDown={(e) => e.preventDefault()} onClick={onOpenInArke}>
        Open in Arke
      </button>
    </div>
  );
}
