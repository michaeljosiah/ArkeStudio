import { useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "../components/icons.js";
import { Button, cx } from "../components/ui.js";
import type { PlacedNote, ReviewFinding } from "../lib/review-notes.js";

/*
 * Review notes in the margin (design turn 227r, SPEC-056 R-29, R-30): a finished review's open
 * findings beside the words they quote. The open note shows its number, category and certainty,
 * the observation, and Fix, Intentional and Dismiss; the rest are their first line. The header
 * counts what is open and steps between them; a quote gone from the chapter is said so there.
 */

const CERTAINTY: Record<ReviewFinding["certainty"], string> = {
  contradiction: "Contradiction",
  "possible-confusion": "Possible confusion",
  "cannot-assess": "Cannot assess",
};
const CATEGORY: Record<ReviewFinding["category"], string> = {
  clarity: "Clarity",
  continuity: "Continuity",
  image: "Image",
  narration: "Narration",
};

export function ReviewNotes({ host, placed, lost, current, disabled, onCurrent, onFix, onDecide }: {
  host: HTMLElement | null;
  placed: readonly PlacedNote[];
  lost: readonly ReviewFinding[];
  current: number | null;
  disabled: boolean;
  onCurrent: (n: number) => void;
  onFix: (note: PlacedNote) => void;
  onDecide: (finding: ReviewFinding, decision: "intentional" | "dismissed") => void;
}) {
  const column = useRef<HTMLDivElement | null>(null);
  const [tops, setTops] = useState<Record<number, number>>({});
  // Each note beside its quote, pushed down past the one above when they would overlap.
  useLayoutEffect(() => {
    if (host === null || column.current === null) return;
    const frame = column.current.getBoundingClientRect();
    const next: Record<number, number> = {};
    let floor = 0;
    for (const note of placed) {
      const quote = host.querySelector<HTMLElement>(`.fy-review-quote[data-note="${note.n}"]`);
      const card = column.current.querySelector<HTMLElement>(`[data-note-card="${note.n}"]`);
      const anchor = quote?.getBoundingClientRect?.().top;
      const top = Math.max(floor, anchor === undefined ? floor : anchor - frame.top);
      next[note.n] = top;
      floor = top + (card?.offsetHeight ?? 0) + 8;
    }
    setTops((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next));
  });
  const at = current === null ? -1 : placed.findIndex((note) => note.n === current);
  const step = (by: 1 | -1) => {
    const note = placed[(Math.max(0, at) + by + placed.length) % placed.length];
    if (note === undefined) return;
    onCurrent(note.n);
    host?.querySelector<HTMLElement>(`.fy-review-quote[data-note="${note.n}"]`)?.scrollIntoView?.({ block: "center" });
  };
  return (
    <aside className="fy-notes" aria-label="Review notes" data-testid="review-notes">
      <header className="fy-notes__head">
        <strong>Review</strong>
        <small>{placed.length + lost.length} open</small>
        <span className="fy-notes__push" />
        <button type="button" className="fy-ch__wbtn" aria-label="Previous note" disabled={placed.length < 2} onClick={() => step(-1)}><ChevronLeft size={14} /></button>
        <button type="button" className="fy-ch__wbtn" aria-label="Next note" disabled={placed.length < 2} onClick={() => step(1)}><ChevronRight size={14} /></button>
      </header>
      {lost.length > 0 && (
        <div className="fy-notes__lost">
          <p className="fy-notes__lost-head">Quote no longer in the chapter</p>
          {lost.map((finding) => <p key={finding.id} className="fy-notes__line">{finding.observation}</p>)}
        </div>
      )}
      <div ref={column} className="fy-notes__column">
        {placed.map((note) => {
          const open = note.n === current;
          return (
            <section
              key={note.finding.id}
              className={cx("fy-note", open && "fy-note--open")}
              data-note-card={note.n}
              style={tops[note.n] === undefined ? undefined : { top: tops[note.n] }}
              onClick={() => (open ? undefined : onCurrent(note.n))}
            >
              <header className="fy-note__head">
                <span className="fy-note__n">{note.n}</span>
                <span className="fy-note__kind">{CATEGORY[note.finding.category]} · {CERTAINTY[note.finding.certainty]}</span>
              </header>
              <p className={cx("fy-note__body", !open && "fy-notes__line")}>{note.finding.observation}</p>
              {open && (
                <div className="fy-note__acts">
                  <Button variant="primary" disabled={disabled} onClick={() => onFix(note)}>Fix</Button>
                  <Button variant="ghost" disabled={disabled} onClick={() => onDecide(note.finding, "intentional")}>Intentional</Button>
                  <Button variant="ghost" disabled={disabled} onClick={() => onDecide(note.finding, "dismissed")}>Dismiss</Button>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </aside>
  );
}
