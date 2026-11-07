import { DEFAULT_COMIC_SETTINGS, comicBook, comicPanelStates, type ProductionBundle, type WorldBundle } from "@arke-studio/contracts";
import { useNavigate, useParams } from "react-router";
import { useGlobalChat } from "../components/global-chat-context.js";
import { EmptyState, Screen } from "../components/layout.js";
import { takeFile } from "./comic-pages.js";
import { Button, cx } from "../components/ui.js";
import { Sparkle } from "../components/icons.js";
import { useProduction } from "../lib/selectors.js";
import { createChapter } from "../lib/store.js";

/**
 * A graphic novel's home (design turn 256e): each chapter's stage in a word and the one next step.
 * It had the writing dashboard — words today, Continue chapter — which says nothing about pages.
 */
type Stage = "made" | "making" | "written" | "draft" | "plan-waiting" | "kept" | "none";
const STAGE: Record<Stage, string> = {
  made: "Pages made", making: "Making pages", written: "Pages written", draft: "Draft waiting",
  "plan-waiting": "Plan waiting", kept: "Plan kept", none: "Not planned",
};

export interface ChapterStage {
  id: string; order: number; title: string; stage: Stage; pages: number; made: number;
  /** How its pages stand in Panel by panel (turn 272): "make" has only panels to draw; "decide" has something for the author in Pages. */
  panels?: "make" | "decide" | undefined;
  /** A panel or page of it is being drawn right now. */
  running?: boolean | undefined;
}

/** Where each chapter stands, from its script, its waiting draft and its accepted takes. */
export function chapterStages(world: Pick<WorldBundle, "proposals">, production: ProductionBundle): ChapterStage[] {
  const book = comicBook(production);
  return production.chapters.filter((chapter) => !chapter.retired).sort((a, b) => a.order - b.order).map((chapter) => {
    const path = `productions/${production.meta.id}/comic/${chapter.id}.json`;
    const waiting = world.proposals.find((staged) => staged.comicScripts?.[path] !== undefined)?.comicScripts?.[path];
    const script = production.comicScripts?.find((entry) => entry.chapter === chapter.id)?.script;
    const pages = book.filter((entry) => entry.chapter === chapter.id);
    const made = pages.filter((entry) => entry.take !== undefined).length;
    const stage: Stage = waiting ? (waiting.pages.length === 0 ? "plan-waiting" : "draft")
      : pages.length > 0 ? (made === pages.length ? "made" : made > 0 ? "making" : "written")
      : script?.plan ? "kept" : "none";
    const count = pages.length || (waiting?.pages.length ?? 0) || (script?.plan?.pages.length ?? waiting?.plan?.pages.length ?? 0);
    const states = production.comic?.mode === "overlay" && made < pages.length
      ? pages.filter((entry) => entry.take === undefined).flatMap((entry) => comicPanelStates(entry.page, production.comicPages?.find((held) => held.page === entry.id)?.record, production.comic ?? DEFAULT_COMIC_SETTINGS))
      : [];
    const panels = states.length === 0 ? undefined
      : states.some((state) => state.failed !== undefined || (state.shown !== undefined && state.accepted === undefined)) || states.every((state) => state.shown !== undefined) ? "decide" as const
      : "make" as const;
    const running = pages.some((entry) => (production.comicPages?.find((held) => held.page === entry.id)?.record.making.length ?? 0) > 0);
    return { id: chapter.id, order: chapter.order, title: chapter.title, stage, pages: count, made, ...(panels ? { panels } : {}), ...(running ? { running } : {}) };
  });
}

/** What Next's press does (turn 272): the step itself where Arke can take it, and Pages where the author decides. */
export type NextPress = "plan" | "draft" | "make" | "open";

/** The one thing to do next, in the book's order: a waiting decision first, then the first chapter not done. */
export function nextStep(stages: readonly ChapterStage[]): { chapter: ChapterStage; says: string; press: NextPress; now?: boolean } | null {
  const waiting = stages.find((chapter) => chapter.stage === "draft" || chapter.stage === "plan-waiting");
  if (waiting) return { chapter: waiting, says: `keep or discard Arke’s ${waiting.stage === "draft" ? "draft" : "plan"} of ${waiting.order} · ${waiting.title}`, press: "open" };
  const open = stages.find((chapter) => chapter.stage !== "made");
  if (!open) return null;
  const name = `${open.order} · ${open.title}`;
  if (open.running) return { chapter: open, says: `Arke is making ${name}`, press: "open", now: true };
  if (open.stage === "none") return { chapter: open, says: `plan ${name}`, press: "plan" };
  if (open.stage === "kept") return { chapter: open, says: `draft ${name} from its plan`, press: "draft" };
  if (open.panels === "make") return { chapter: open, says: `make ${name}`, press: "make" };
  return { chapter: open, says: open.panels === "decide" ? `finish the pages of ${name}` : `make the pages of ${name}`, press: "open" };
}

const PRESS: Record<Exclude<NextPress, "open">, string> = { plan: "Plan with Arke", draft: "Draft with Arke", make: "Make with Arke" };

export function ComicDashboard() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const chat = useGlobalChat();
  const chatSurface = chat?.forPage() ?? null;
  if (!world || !production) return <Screen id="production-dashboard"><EmptyState title="Opening production…" /></Screen>;
  const stages = chapterStages(world, production);
  const next = nextStep(stages);
  const planned = stages.reduce((sum, chapter) => sum + (chapter.stage === "none" ? 0 : chapter.pages), 0);
  const made = stages.reduce((sum, chapter) => sum + chapter.made, 0);
  const book = comicBook(production).filter((entry) => entry.take !== undefined && takeFile(world, entry.take) !== null);
  const pages = (chapter: string) => navigate(`/w/${worldId}/p/${prodId}/story/pages?chapter=${encodeURIComponent(chapter)}`);
  // One press asks (turn 256), in the words Pages uses, so Pages says Arke is at work on the chapter.
  const askArke = (step: NonNullable<typeof next>) => {
    if (!chat || !chatSurface) return;
    const { order, title, id } = step.chapter;
    const adapted = production.comic?.adapts?.chapters.find((entry) => entry.chapter === id);
    const story = adapted ? world.productions.find((candidate) => candidate.meta.id === production.comic!.adapts!.story) : undefined;
    const source = adapted ? story?.chapters.find((candidate) => candidate.id === adapted.from) : undefined;
    const from = story && source ? ` from chapter ${source.order} of ${story.meta.title}` : "";
    chat.setValue(chatSurface.key, "draft", step.press === "plan" ? `Plan chapter ${order}, ${title}, as pages${from}.`
      : step.press === "draft" ? `Draft chapter ${order}, ${title}, from its kept plan${from}.`
      : `Make chapter ${order}, ${title}, with Arke.`);
    chat.setValue(chatSurface.key, "autoSend", true);
    chat.open(chatSurface);
  };
  return (
    // The column's wide padding is the main column's; the dashboard sits inside it, as every screen does.
    // On the column itself, its max-width squeezed the page to a few characters (installed 0.5.80).
    <div className="fy-prodmain" data-screen="production-dashboard"><div className="fy-comic-dash">
      <h1>{production.meta.title}</h1>
      <div className="m">{stages.length === 0 ? "No chapters yet" : <>{stages.length} {stages.length === 1 ? "chapter" : "chapters"} · {planned === 0 ? "no pages yet" : <>{planned} {planned === 1 ? "page" : "pages"} planned · {made} made</>}</>}</div>
      {next && (
        <div className="fy-comic-dash__next">
          <Sparkle size={15} />
          <span><b>{next.now ? "Now" : "Next"}</b> · {next.says}</span>
          <span className="grow" />
          {next.press !== "open" && chatSurface
            ? <Button size="sm" variant="primary" onClick={() => askArke(next)}><Sparkle size={14} />{PRESS[next.press]}</Button>
            : <Button size="sm" variant="primary" onClick={() => pages(next.chapter.id)}>Open in Pages</Button>}
        </div>
      )}
      {stages.length === 0 && (
        <div className="fy-comic-dash__next">
          <Sparkle size={15} />
          <span><b>Next</b> · add a chapter</span>
          <span className="grow" />
          <Button size="sm" variant="primary" onClick={() => { if (worldId && prodId) createChapter(worldId, prodId, "Untitled", 1); }}>+ Chapter</Button>
        </div>
      )}
      {/* The book so far, as pictures: a list of "Untitled · Pages made" showed none of it (issue 2466). */}
      {book.length > 0 && <div className="fy-comic-dash__pages">
        {book.map((entry) => <button key={entry.id} type="button" aria-label={`Page ${entry.number}`} onClick={() => pages(entry.chapter)}><img src={takeFile(world, entry.take)!} alt="" /></button>)}
      </div>}
      <ol className="fy-comic-dash__rows">
        {stages.map((chapter) => (
          <li key={chapter.id}>
            <button type="button" onClick={() => pages(chapter.id)}>
              <span className="n">{chapter.order}</span>
              <span className="t">{chapter.title}</span>
              <span className={cx("fy-comic-dash__stage", chapter.stage)}>{STAGE[chapter.stage]}</span>
              <span className="m">{chapter.stage === "made" || chapter.stage === "making" ? `${chapter.made} of ${chapter.pages}` : chapter.pages > 0 ? `${chapter.pages} ${chapter.pages === 1 ? "page" : "pages"}` : ""}</span>
            </button>
          </li>
        ))}
      </ol>
    </div></div>
  );
}
