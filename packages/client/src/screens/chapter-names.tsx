import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Play } from "../components/icons.js";
import { Button, cx } from "../components/ui.js";

/**
 * The name card (design turn 227b, SPEC-056 R-17): who a linked name is, without leaving the page.
 * One card lists every sheet the text names, so `Ade` shared by two characters shows both.
 */

export interface NameCardSheet {
  id: string;
  kind: "character" | "place";
  name: string;
  role?: string;
  face: string | null;
  /** Lines spoken in this chapter, from its cast. */
  linesHere?: number;
  /** The chapters, by number, the book's cast stamps have them speaking in. */
  chapters?: number[];
  /** How many chapters the book has, for "14 of 25". */
  book?: number;
  voice?: string;
  /** The character's designated voice sample, to hear from the card (227b). */
  sample?: boolean;
  open: string;
  voicePage?: string;
}

const CARD_WIDTH = 320;
const GUTTER = 16;

function where(rect: DOMRect, height: number): { left: number; top: number } {
  // The card narrows with the window (its CSS max-width), so it is placed by the width it has.
  const width = Math.min(CARD_WIDTH, window.innerWidth - 2 * GUTTER);
  // Centred under the name (227b), held inside the window.
  const left = Math.max(GUTTER, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - GUTTER));
  // Below the name unless that runs off the window, then above it.
  const below = rect.bottom + 8;
  const top = below + height > window.innerHeight - GUTTER ? Math.max(GUTTER, rect.top - 8 - height) : below;
  return { left, top };
}

/** The line under the name (227b): the role, then the lines spoken here. */
function sub(sheet: NameCardSheet): string {
  const lines = sheet.linesHere !== undefined && sheet.linesHere > 0 ? `${sheet.linesHere} line${sheet.linesHere === 1 ? "" : "s"} here` : "";
  return [sheet.role ?? "", lines].filter((part) => part !== "").join(" · ");
}

/** First seen, how many chapters, last seen (227b): label and value, a row each. */
function seen(chapters: number[], book: number | undefined): [string, string][] {
  if (chapters.length === 0) return [];
  const first = chapters[0]!, last = chapters[chapters.length - 1]!;
  return [
    ["First seen", `Chapter ${first}`],
    ["Chapters", book !== undefined ? `${chapters.length} of ${book}` : String(chapters.length)],
    ...(last !== first ? [["Last seen", `Chapter ${last}`] as [string, string]] : []),
  ];
}

export function NameCard({ sheets, rect, onEnter, onLeave, onClose, onAsk, onHear }: {
  sheets: NameCardSheet[];
  rect: DOMRect;
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
  onAsk: (sheet: NameCardSheet) => void;
  onHear?: (sheet: NameCardSheet) => void;
}) {
  const card = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    setAt(where(rect, card.current?.offsetHeight ?? 200));
  }, [rect, sheets.length]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // The card is placed against the name; once the page scrolls it would point at nothing.
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !card.current?.contains(event.target)) onClose();
    };
    // A press anywhere else puts it away: on touch there is no pointer to move off it.
    const press = (event: Event) => {
      if (!(event.target instanceof Node) || !card.current?.contains(event.target)) onClose();
    };
    window.addEventListener("keydown", key);
    window.addEventListener("scroll", scroll, true);
    document.addEventListener("pointerdown", press);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("scroll", scroll, true);
      document.removeEventListener("pointerdown", press);
    };
  }, [onClose]);
  return (
    <div
      ref={card}
      className="fy-namecard"
      role="dialog"
      aria-label={sheets.map((sheet) => sheet.name).join(", ")}
      data-testid="name-card"
      style={at === null ? { visibility: "hidden", left: 0, top: 0 } : at}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {sheets.map((sheet) => (
        <section key={sheet.id} className="fy-namecard__sheet">
          <header className="fy-namecard__head">
            <span className={cx("fy-namecard__face", sheet.kind === "place" && "fy-namecard__face--place")} aria-hidden="true">
              {sheet.face !== null ? <img src={sheet.face} alt="" /> : sheet.name.slice(0, 1)}
            </span>
            <span className="fy-namecard__who">
              <strong>{sheet.name}</strong>
              {sub(sheet) !== "" && <span>{sub(sheet)}</span>}
            </span>
          </header>
          {seen(sheet.chapters ?? [], sheet.book).length > 0 && (
            <dl className="fy-namecard__facts">
              {seen(sheet.chapters ?? [], sheet.book).map(([label, value]) => (
                <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
              ))}
            </dl>
          )}
          {sheet.kind === "character" && (
            <p className="fy-namecard__voice">
              {sheet.sample === true && onHear !== undefined && (
                <button type="button" className="fy-namecard__hear" aria-label={`Hear ${sheet.name}`} onClick={() => onHear(sheet)}>
                  <Play size={12} />
                </button>
              )}
              <span>{sheet.voice ?? "No voice"}</span>
              {sheet.voicePage !== undefined && <Link to={sheet.voicePage}>Change</Link>}
            </p>
          )}
          <div className="fy-namecard__acts">
            <Link className="ui-btn ui-btn--secondary ui-btn--default" to={sheet.open}>Open</Link>
            <Button variant="secondary" onClick={() => onAsk(sheet)}>Ask Arke</Button>
          </div>
        </section>
      ))}
    </div>
  );
}
