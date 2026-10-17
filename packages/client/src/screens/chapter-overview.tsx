import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, Check, Waveform } from "../components/icons.js";
import { cx } from "../components/ui.js";

/*
 * The Chapter view (design turn 227, SPEC-056 §1.11): the chapter's production home. The hero holds
 * its picture, the book strip, the title and synopsis, one meta line and the actions; under it the
 * cast as the world overview's cards, progress as four steps, the pictures, then what the old side
 * column held. Every write stays the workspace's: this draws, and calls back.
 */

/** `order` is the chapter's own number, which a retired chapter before it does not change. */
export type BookStripChapter = { id: string; order: number; title: string; words: number; planned: boolean };

/** One segment a chapter, sized by its words; the open one solid, planned ones outlined (R-36). */
export function BookStrip({ chapters, current, onChapter }: { chapters: readonly BookStripChapter[]; current: string; onChapter: (id: string) => void }) {
  const at = chapters.findIndex((c) => c.id === current);
  const previous = at > 0 ? chapters[at - 1]! : null;
  const next = at >= 0 && at < chapters.length - 1 ? chapters[at + 1]! : null;
  return (
    <div className="fy-chov__book">
      <button type="button" className="fy-chov__nav" aria-label="Previous chapter" title={previous?.title} disabled={previous === null} onClick={() => previous && onChapter(previous.id)}>
        <ChevronLeft size={12} />
      </button>
      <b>Chapter {chapters[at]?.order ?? at + 1}</b>
      <span>of {chapters.length}</span>
      <span className="fy-chov__strip" role="group" aria-label="Chapters">
        {chapters.map((c) => (
          <button
            key={c.id}
            type="button"
            className={cx("fy-chov__seg", c.id === current && "fy-chov__seg--here", c.planned && "fy-chov__seg--planned")}
            style={{ flexGrow: Math.max(c.words, 300) }}
            title={`Chapter ${c.order} · ${c.title}`}
            aria-label={`Chapter ${c.order} · ${c.title}`}
            aria-current={c.id === current ? "page" : undefined}
            onClick={() => c.id !== current && onChapter(c.id)}
          />
        ))}
      </span>
      <button type="button" className="fy-chov__nav" aria-label="Next chapter" title={next?.title} disabled={next === null} onClick={() => next && onChapter(next.id)}>
        <ChevronRight size={12} />
      </button>
    </div>
  );
}

export type CastCard = { key: string; name: string; line: string; picture: string | null; narrator?: boolean };

/** The cast as the world overview's polaroids (R-37): picture, name, one line. No colour rings. */
export function CastCards({ cards, selected, onCard }: { cards: readonly CastCard[]; selected: string | null; onCard: (key: string) => void }) {
  return (
    <div className="fy-chov__cards" data-testid="chapter-cast">
      {cards.map((card) => (
        <button key={card.key} type="button" className={cx("fy-polaroid fy-chov__card", selected === card.key && "fy-chov__card--open")} aria-pressed={selected === card.key} onClick={() => onCard(card.key)}>
          <span className="fy-polaroid__frame fy-chov__frame">
            {card.picture !== null ? <img src={card.picture} alt="" loading="lazy" /> : <span className="fy-chov__initial" aria-hidden="true">{card.name.slice(0, 1)}</span>}
            {card.narrator && <span className="fy-chov__badge" aria-hidden="true"><Waveform size={13} /></span>}
          </span>
          <span className="fy-polaroid__name">{card.name}</span>
          <span className="fy-polaroid__role">{card.line}</span>
        </button>
      ))}
    </div>
  );
}

export type ProgressStep = { key: string; label: string; state: "done" | "need" | "idle"; value: string; meta?: string; action?: ReactNode };

/** Progress in order (R-39): each step its state and one action. A step that needs the author marks its number. */
export function ProgressSteps({ steps }: { steps: readonly ProgressStep[] }) {
  return (
    <ol className="fy-chov__steps" aria-label="Progress">
      {steps.map((step, i) => (
        <li key={step.key} className={cx("fy-chov__step", `fy-chov__step--${step.state}`)}>
          <span className="fy-chov__stepk">
            <i aria-hidden="true">{step.state === "done" ? <Check size={11} /> : i + 1}</i>
            {step.label}
          </span>
          <b>{step.value}</b>
          {step.meta !== undefined && <small>{step.meta}</small>}
          {step.action !== undefined && <span className="fy-chov__stepact">{step.action}</span>}
        </li>
      ))}
    </ol>
  );
}

export function ChapterOverview({
  picture,
  strip,
  title,
  synopsis,
  meta,
  actions,
  views,
  cast,
  voiceCard,
  steps,
  pictures,
  onPicture,
  illustrate,
  continuity,
  versions,
  more,
}: {
  picture: string | null;
  strip: ReactNode;
  title: ReactNode;
  synopsis: string | undefined;
  meta: ReactNode;
  actions: ReactNode;
  views: ReactNode;
  cast: ReactNode;
  voiceCard: ReactNode;
  steps: ReactNode;
  pictures: readonly string[];
  onPicture: (index: number) => void;
  illustrate: ReactNode;
  continuity: ReactNode;
  versions: ReactNode;
  more: ReactNode;
}) {
  const shown = pictures.slice(0, 5);
  return (
    <div className="fy-chov" data-testid="chapter-overview">
      <section className={cx("fy-chov__hero", picture === null && "fy-chov__hero--bare")}>
        {picture !== null && <div className="fy-chov__art" style={{ backgroundImage: `url("${picture}")` }} aria-hidden="true" />}
        <div className="fy-chov__heroin">
          {strip}
          <h1 className="fy-chov__title">{title}</h1>
          {synopsis !== undefined && synopsis !== "" && <p className="fy-chov__synopsis">{synopsis}</p>}
          <div className="fy-chov__meta">{meta}</div>
          <div className="fy-chov__acts">{actions}</div>
        </div>
      </section>
      <div className="fy-chov__views">{views}</div>
      <div className="fy-chov__body">
        {cast !== null && (
          <section className="fy-chov__section">
            <h2>Cast</h2>
            {cast}
            {voiceCard}
          </section>
        )}
        <section className="fy-chov__section">{steps}</section>
        {pictures.length > 0 && (
          <section className="fy-chov__section">
            <h2>
              Pictures <small>{pictures.length}</small>
              <span className="fy-chov__push" />
              {illustrate}
            </h2>
            <div className="fy-chov__pics">
              {shown.map((src, i) => (
                <button key={src + i} type="button" className="fy-chov__pic" style={{ backgroundImage: `url("${src}")` }} aria-label={`Picture ${i + 1}`} onClick={() => onPicture(i)} />
              ))}
              {pictures.length > shown.length && <span className="fy-chov__pic fy-chov__pic--more">+{pictures.length - shown.length}</span>}
            </div>
          </section>
        )}
        <div className="fy-chov__two">
          <div>{continuity}</div>
          <div>
            {versions}
            {more}
          </div>
        </div>
      </div>
    </div>
  );
}
