import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { cx } from "./ui.js";
import { Portrait } from "./portrait.js";
import {
  filterMentions,
  insertMention,
  mentionQueryAt,
  type MentionOption,
  type MentionQuery,
} from "../lib/bench-mention.js";

/**
 * The bench's brief editor, with the @ completion in it (issue 476).
 *
 * One component, worn two ways. The composer's brief and the write-large window used to be two
 * plain textareas with the same value threaded through both, which is exactly the shape in which
 * a completion added to one quietly fails to exist in the other. Everything about editing —
 * the caret, the query, the menu, the insertion — lives here; the variants differ only in dress.
 *
 * The textarea stays the editor. The chips are an underlay beneath it sharing every metric, and
 * the menu is anchored by a second, invisible copy of the words with the query marked — so the
 * caret, the chips and the menu all agree about where the words are without any of them being
 * asked to hold the text. Paste, undo and an IME all keep working, because none of them ever
 * stopped talking to a real textarea.
 */
export function BenchBrief({
  value,
  onChange,
  options,
  worldSlug,
  underlay,
  label,
  placeholder,
  variant = "compact",
  autoFocus = false,
  onEscape,
}: {
  value: string;
  onChange: (next: string) => void;
  /** The references attached right now — the only things the menu may offer. */
  options: readonly MentionOption[];
  worldSlug: string | undefined;
  /** The words with their chips, drawn beneath the transparent editor. */
  underlay: ReactNode;
  label: string;
  placeholder?: string;
  variant?: "compact" | "large";
  autoFocus?: boolean;
  /** Escape with no menu open — the write-large window closes on it. */
  onEscape?: () => void;
}) {
  const listId = useId();
  const text = useRef<HTMLTextAreaElement>(null);
  const under = useRef<HTMLDivElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const mark = useRef<HTMLSpanElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const [menu, setMenu] = useState<MentionQuery | null>(null);
  const [active, setActive] = useState(0);
  const [anchor, setAnchor] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  /** Read synchronously by the key handler, which runs before the state it would read settles. */
  const query = useRef<MentionQuery | null>(null);
  /** The "@" an Escape dismissed: the menu stays shut until the caret leaves that citation. */
  const dismissed = useRef<number | null>(null);
  /** Where the caret goes once a chosen mention has been written into the value. */
  const caretAfter = useRef<number | null>(null);

  const matches = menu === null ? [] : filterMentions(options, menu.query);
  // No matches is not a menu: the keys stay the textarea's, so ordinary writing is never eaten.
  const open = menu !== null && matches.length > 0;
  const highlighted = Math.min(active, Math.max(0, matches.length - 1));

  /** Re-read the caret and decide whether a citation is being written at it. */
  const sync = (el: HTMLTextAreaElement): void => {
    const found = options.length === 0 ? null : mentionQueryAt(el.value, el.selectionStart ?? 0);
    if (found !== null && dismissed.current === found.start) {
      query.current = null;
      setMenu(null);
      return;
    }
    dismissed.current = null;
    const before = query.current;
    if (before === null && found === null) return;
    if (before !== null && found !== null && before.start === found.start && before.query === found.query) return;
    query.current = found;
    setMenu(found);
    setActive(0);
  };

  const choose = (option: MentionOption): void => {
    const el = text.current;
    const at = query.current;
    if (el === null || at === null) return;
    const next = insertMention(el.value, at, option.token);
    query.current = null;
    dismissed.current = null;
    setMenu(null);
    setActive(0);
    caretAfter.current = next.caret;
    onChange(next.text);
  };

  // The caret goes back where the completion left it, once the new words have been rendered.
  useLayoutEffect(() => {
    const wanted = caretAfter.current;
    if (wanted === null) return;
    caretAfter.current = null;
    const el = text.current;
    if (el === null) return;
    el.focus();
    el.setSelectionRange(wanted, wanted);
  }, [value]);

  /**
   * Put the menu against the citation itself, measured on the invisible copy of the words. Below
   * the line where there is room and above it where there is not, and never off the side.
   *
   * Called again whenever anything moves the words under it. The menu is fixed to the viewport
   * and the query is not: scroll the brief with the menu open and, left alone, the words slide
   * away while the menu stays where it was, pointing at whatever has arrived in its place.
   */
  const place = (): void => {
    const el = text.current;
    const at = mark.current;
    if (el === null || at === null) return;
    const box = el.getBoundingClientRect();
    const lineTop = box.top + at.offsetTop - el.scrollTop;
    const lineBottom = lineTop + at.offsetHeight;
    // Scrolled clean out of the editor: there is nothing left for the menu to point at, so it
    // goes rather than hovering over words that are not the ones being written.
    if (lineBottom <= box.top || lineTop >= box.bottom) {
      query.current = null;
      setMenu(null);
      return;
    }
    const left = Math.max(8, Math.min(box.left + at.offsetLeft, window.innerWidth - 268));
    const wants = Math.min(232, matches.length * 38 + 12);
    setAnchor(
      lineBottom + wants + 10 > window.innerHeight
        ? { left, bottom: Math.max(8, window.innerHeight - lineTop + 4) }
        : { left, top: lineBottom + 4 },
    );
  };
  const placing = useRef(place);
  placing.current = place;

  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    place();
    // `place` is re-made every render and reads only refs and the values in this list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, menu?.start, menu?.query, matches.length, value]);

  // Anything that scrolls between the words and the viewport moves the query under a fixed
  // menu — the composer's own column included, which is why this listens on the way down.
  useEffect(() => {
    if (!open) return;
    const moved = () => placing.current();
    window.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    return () => {
      window.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
    };
  }, [open]);

  /**
   * Keep the row Enter would insert in sight.
   *
   * Arrow keys move a highlight the mouse is not following, and the list is taller than it is
   * allowed to be from seven references up — and a model may take sixteen. Measured off the
   * rects rather than `offsetTop`, which is rounded to whole pixels and left the row a fraction
   * clipped at a fractional scroll position.
   */
  useLayoutEffect(() => {
    const box = list.current;
    const row = box?.children[highlighted] as HTMLElement | undefined;
    if (!box || !row) return;
    const around = box.getBoundingClientRect();
    const seat = row.getBoundingClientRect();
    if (seat.top < around.top) box.scrollTop -= around.top - seat.top;
    else if (seat.bottom > around.bottom) box.scrollTop += seat.bottom - around.bottom;
  }, [highlighted, open]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    // Mid-composition every key belongs to the IME, Enter above all: it commits the candidate.
    if (event.nativeEvent.isComposing) return;
    if (open) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((i) => (i + 1) % matches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const picked = matches[highlighted];
        if (picked !== undefined) {
          event.preventDefault();
          choose(picked);
          return;
        }
      }
      if (event.key === "Escape") {
        // The words are untouched; only the menu goes. The window behind it stays open.
        event.preventDefault();
        event.stopPropagation();
        dismissed.current = query.current?.start ?? null;
        query.current = null;
        setMenu(null);
        return;
      }
    }
    if (event.key === "Escape") onEscape?.();
  };

  return (
    <div className={cx("fy-bench__briefstack", variant === "large" && "fy-bench__briefstack--large")}>
      <div ref={under} className="fy-bench__briefunder" aria-hidden>
        {underlay}
        {"​"}
      </div>
      {menu !== null && (
        <div ref={mirror} className="fy-bench__briefmirror" aria-hidden>
          {value.slice(0, menu.start)}
          <span ref={mark}>{value.slice(menu.start, menu.start + 1 + menu.query.length)}</span>
          {value.slice(menu.start + 1 + menu.query.length)}
        </div>
      )}
      <textarea
        ref={text}
        autoFocus={autoFocus}
        aria-label={label}
        className="fy-bench__brieftext"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        {...(open ? { "aria-activedescendant": `${listId}-${highlighted}` } : {})}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          sync(e.target);
        }}
        onSelect={(e) => sync(e.currentTarget)}
        onBlur={() => {
          query.current = null;
          setMenu(null);
        }}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          if (under.current) under.current.scrollTop = e.currentTarget.scrollTop;
          if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop;
          if (open) place();
        }}
      />
      {open && anchor !== null && (
        <ul
          ref={list}
          id={listId}
          role="listbox"
          aria-label="Attached references"
          className="fy-bench__mentions"
          data-testid="bench-mentions"
          style={{
            left: anchor.left,
            ...(anchor.top !== undefined ? { top: anchor.top } : {}),
            ...(anchor.bottom !== undefined ? { bottom: anchor.bottom } : {}),
          }}
        >
          {matches.map((option, index) => (
            <li
              key={option.token}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === highlighted}
              aria-label={`${option.token} — ${option.name}`}
              className="fy-bench__mentionrow"
              // Taking focus would close the menu on blur before the click ever lands.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(option)}
            >
              <span className="fy-bench__mentionthumb">
                {option.imagePath !== undefined ? (
                  <Portrait worldSlug={worldSlug} path={option.imagePath} label={option.kind} radius={0} />
                ) : (
                  <span className="fy-bench__mentionkind">{option.kind}</span>
                )}
              </span>
              <span className="fy-bench__mentiontext">
                <span className="fy-bench__mentiontoken">{`@${option.token}`}</span>
                <span className="fy-bench__mentionname">{option.name}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
