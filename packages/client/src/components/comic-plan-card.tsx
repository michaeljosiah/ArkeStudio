import { comicPilotChapter } from "@arke-studio/contracts";
import type { ComicAsk, ComicPlan, ProductionSetupState } from "@arke-studio/contracts";
import { comicStylePicture, comicStylePreset } from "../lib/comic-styles.js";

/**
 * A graphic novel's setup (design turn 249b, SPEC-064 R-4): the three questions answered by
 * example, the one plan, and what Create will write. The audio drama's setup is the pattern
 * (turn 230c): Arke asks, the page draws the choices, and pressing one is the answer.
 */

const READING_LABEL: Record<ComicPlan["reading"], string> = { ltr: "Left to right", rtl: "Right to left", scroll: "Scroll" };
const LAYOUT_LABEL: Record<string, string> = { "grid-2x2": "Grid", "grid-3x3": "Grid 3×3", "strip-3": "Wide", splash: "Splash", feature: "Feature", manga: "Manga", webtoon: "Webtoon" };

/** A tiny page, its panels numbered in reading order, as [x, y, w, h, n] in a 60 × 84 frame. */
function Mini({ cells }: { cells: ReadonlyArray<readonly [number, number, number, number, number | ""]> }) {
  return (
    <span className="fy-comic-ask__mini" aria-hidden="true">
      {cells.map(([x, y, w, h, n], i) => <u key={i} style={{ left: x, top: y, width: w, height: h }}>{n}</u>)}
    </span>
  );
}

const CARDS: Record<Exclude<ComicAsk, "usual">, ReadonlyArray<{ label: string; sub: string; answer: string; cells: ReadonlyArray<readonly [number, number, number, number, number | ""]> }>> = {
  reading: [
    { label: "Left to right", sub: "as a western comic", answer: "Left to right.", cells: [[3, 3, 25, 38, 1], [32, 3, 25, 38, 2], [3, 45, 25, 36, 3], [32, 45, 25, 36, 4]] },
    { label: "Right to left", sub: "as manga", answer: "Right to left, as manga.", cells: [[3, 3, 25, 38, 2], [32, 3, 25, 38, 1], [3, 45, 25, 36, 4], [32, 45, 25, 36, 3]] },
    { label: "Scroll", sub: "one column, as a webtoon", answer: "One scrolling column, as a webtoon.", cells: [[10, 3, 40, 24, 1], [10, 30, 40, 24, 2], [10, 57, 40, 24, 3]] },
  ],
  aspect: [
    { label: "2:3", sub: "comic book", answer: "A 2:3 comic book page.", cells: [[8, 3, 44, 78, ""]] },
    { label: "3:4", sub: "album", answer: "A 3:4 album page.", cells: [[4, 10, 52, 70, ""]] },
  ],
  pilot: [
    { label: "Yes", sub: "chapter 1 first", answer: "Yes, the pilot first.", cells: [[8, 3, 44, 78, 1]] },
    { label: "No", sub: "plan every chapter", answer: "No pilot: plan every chapter.", cells: [[3, 3, 25, 38, 1], [32, 3, 25, 38, 2], [3, 45, 25, 36, 3], [32, 45, 25, 36, 4]] },
  ],
};

/** The question Arke is asking, as cards to press (249b). A card is the answer, said in the conversation. */
export function ComicAskCards({ ask, disabled, onChoose, pilotTitle }: { ask: ComicAsk; disabled: boolean; onChoose: (text: string) => void; pilotTitle?: string | undefined }) {
  // The usual three as one card to use or change (turn 256a): asking what nearly everyone answers
  // the same way took three turns of the owner's run.
  if (ask === "usual") {
    return (
      <div className="fy-comic-usual" role="group" aria-label="The usual settings">
        <div className="row"><span>Reading</span><b>Left to right</b></div>
        <div className="row"><span>Page</span><b>2:3 comic book</b></div>
        <div className="row"><span>Pilot</span><b>Chapter 1{pilotTitle ? ` · ${pilotTitle}` : ""}</b></div>
        <div className="acts">
          <button type="button" className="fy-comic-usual__use" disabled={disabled} onClick={() => onChoose("Use these: left to right, a 2:3 comic book page, and chapter 1 as the pilot.")}>Use these</button>
          <button type="button" disabled={disabled} onClick={() => onChoose("I'd like to choose these myself.")}>Change</button>
        </div>
      </div>
    );
  }
  return (
    <div className="fy-comic-ask" role="group" aria-label={ask === "reading" ? "Which way it reads" : ask === "aspect" ? "The page shape" : "A pilot chapter first"}>
      {CARDS[ask].map((card) => (
        <button key={card.label} type="button" className="fy-comic-ask__card" disabled={disabled} onClick={() => onChoose(card.answer)}>
          <Mini cells={card.cells} />
          <b>{card.label}</b>
          <span>{card.sub}</span>
        </button>
      ))}
    </div>
  );
}

/** The plan as one thing to accept or change (249b): its facts, then a row for each chapter. */
export function ComicPlanCard({ plan, sourceTitle, sourceWords }: { plan: ComicPlan; sourceTitle: string | undefined; sourceWords: (from: number) => number | undefined }) {
  const pilot = comicPilotChapter(plan);
  const pages = plan.chapters.reduce((sum, chapter) => sum + chapter.pages, 0);
  const preset = comicStylePreset(plan.style?.preset);
  return (
    <section className="fy-comic-plan" aria-label="The plan">
      <div className="fy-comic-plan__sub">
        Graphic novel{sourceTitle ? ` · from ${sourceTitle}` : ""} · {plan.chapters.length} {plan.chapters.length === 1 ? "chapter" : "chapters"}{pages > 0 ? ` · ~${pages} pages` : ""}
      </div>
      <div className="fy-comic-plan__facts">
        <span>{preset && <img src={comicStylePicture(preset.id)} alt="" />}{preset?.name ?? (plan.style ? "Your own" : "World look")}</span>
        <span>{READING_LABEL[plan.reading]}</span>
        <span>{plan.aspect}</span>
        {pilot && <span>Pilot · {pilot.title}</span>}
      </div>
      {plan.chapters.length > 0 && (
        <ol className="fy-comic-plan__rows">
          {plan.chapters.map((chapter, index) => {
            const words = sourceWords(chapter.from);
            return (
              <li key={index} className={chapter === pilot ? "is-pilot" : undefined}>
                <span className="n">{index + 1}</span>
                <span>{chapter.title}{words !== undefined && <small>{words.toLocaleString("en-GB")} words</small>}</span>
                <span className="pg">~{chapter.pages} {chapter.pages === 1 ? "page" : "pages"}</span>
                <span className="lay">{chapter.layout ? LAYOUT_LABEL[chapter.layout] ?? chapter.layout : ""}</span>
              </li>
            );
          })}
        </ol>
      )}
      {plan.chapters.length > 0 && <p className="fy-comic-plan__note">Page counts are a first guess</p>}
    </section>
  );
}

/** What Create will write for a graphic novel: its chapters and how it reads, and no pictures. */
export function GraphicNovelReview({ setup, sourceTitle }: { setup: ProductionSetupState; sourceTitle: string | undefined }) {
  const plan = setup.review!.plan;
  const comic = plan.initialContent?.graphicNovel;
  const pilot = comicPilotChapter(setup.draft.graphicNovel);
  const preset = comicStylePreset(comic?.style?.preset);
  return (
    <section className="fy-production-setup__review" aria-label="Review production">
      <h3>Ready to create · {plan.production.title}</h3>
      <p>Story · graphic novel{sourceTitle ? ` · adapts ${sourceTitle}` : ""}</p>
      {comic && <p>{comic.chapters.length} {comic.chapters.length === 1 ? "chapter" : "chapters"} · {READING_LABEL[comic.reading]} · {comic.aspect} · {preset?.name ?? (comic.style ? "your own style" : "world look")}</p>}
      {pilot && <p>Pilot: {pilot.title}</p>}
      <p>No pictures will be made.</p>
    </section>
  );
}

/**
 * What Start the pilot asks Arke once the book exists: the selected chapter's page plan first,
 * since its pages are drafted only from a plan the author kept.
 */
export function comicPilotAsk(title: string, chapter: number): string {
  return `Plan chapter ${chapter} as the pilot: ${title}, as pages.`;
}
