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
  const left = Math.max(GUTTER, Math.min(rect.left, window.innerWidth - width - GUTTER));
  // Below the name unless that runs off the window, then above it.
  const below = rect.bottom + 8;
  const top = below + height > window.innerHeight - GUTTER ? Math.max(GUTTER, rect.top - 8 - height) : below;
  return { left, top };
}

function seen(chapters: number[]): string | null {
  if (chapters.length === 0) return null;
  const first = chapters[0]!, last = chapters[chapters.length - 1]!;
  return chapters.length === 1
    ? `Chapter ${first}`
    : `Ch ${first}–${last} · ${chapters.length} chapters`;
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
              {sheet.role !== undefined && sheet.role !== "" && <span>{sheet.role}</span>}
            </span>
          </header>
          {(sheet.linesHere !== undefined || (sheet.chapters?.length ?? 0) > 0) && (
            <p className="fy-namecard__facts">
              {sheet.linesHere !== undefined && sheet.linesHere > 0 && <span>{sheet.linesHere} line{sheet.linesHere === 1 ? "" : "s"} here</span>}
              {seen(sheet.chapters ?? []) !== null && <span>{seen(sheet.chapters ?? [])}</span>}
            </p>
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
            <Link className="ui-btn ui-btn--ghost ui-btn--default" to={sheet.open}>Open</Link>
            <Button variant="ghost" onClick={() => onAsk(sheet)}>Ask Arke</Button>
          </div>
        </section>
      ))}
    </div>
  );
}
