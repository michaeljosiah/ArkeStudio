import { comicBook, type ProductionBundle, type WorldBundle } from "@arke-studio/contracts";
import { useNavigate, useParams } from "react-router";
import { EmptyState, Screen } from "../components/layout.js";
import { Button, cx } from "../components/ui.js";
import { Sparkle } from "../components/icons.js";
import { useProduction } from "../lib/selectors.js";

/**
 * A graphic novel's home (design turn 256e): each chapter's stage in a word and the one next step.
 * It had the writing dashboard — words today, Continue chapter — which says nothing about pages.
 */
type Stage = "made" | "making" | "written" | "draft" | "plan-waiting" | "kept" | "none";
const STAGE: Record<Stage, string> = {
  made: "Pages made", making: "Making pages", written: "Pages written", draft: "Draft waiting",
  "plan-waiting": "Plan waiting", kept: "Plan kept", none: "Not planned",
};

export interface ChapterStage { id: string; order: number; title: string; stage: Stage; pages: number; made: number }

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
    return { id: chapter.id, order: chapter.order, title: chapter.title, stage, pages: count, made };
  });
}

/** The one thing to do next, in the book's order: a waiting decision first, then the first chapter not done. */
export function nextStep(stages: readonly ChapterStage[]): { chapter: ChapterStage; says: string } | null {
  const waiting = stages.find((chapter) => chapter.stage === "draft" || chapter.stage === "plan-waiting");
  if (waiting) return { chapter: waiting, says: `keep or discard Arke’s ${waiting.stage === "draft" ? "draft" : "plan"} of ${waiting.order} · ${waiting.title}` };
  const open = stages.find((chapter) => chapter.stage !== "made");
  if (!open) return null;
  const says = open.stage === "none" ? `plan ${open.order} · ${open.title} with Arke`
    : open.stage === "kept" ? `draft ${open.order} · ${open.title} from its plan`
    : `make the pages of ${open.order} · ${open.title}`;
  return { chapter: open, says };
}

export function ComicDashboard() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  if (!world || !production) return <Screen id="production-dashboard"><EmptyState title="Opening production…" /></Screen>;
  const stages = chapterStages(world, production);
  const next = nextStep(stages);
  const planned = stages.reduce((sum, chapter) => sum + (chapter.stage === "none" ? 0 : chapter.pages), 0);
  const made = stages.reduce((sum, chapter) => sum + chapter.made, 0);
  const pages = (chapter: string) => navigate(`/w/${worldId}/p/${prodId}/story/pages?chapter=${encodeURIComponent(chapter)}`);
  return (
    <div className="fy-prodmain fy-comic-dash" data-screen="production-dashboard">
      <h1>{production.meta.title}</h1>
      <div className="m">{stages.length} {stages.length === 1 ? "chapter" : "chapters"} · {planned} {planned === 1 ? "page" : "pages"} planned · {made} made</div>
      {next && (
        <div className="fy-comic-dash__next">
          <Sparkle size={15} />
          <span><b>Next</b> · {next.says}</span>
          <span className="grow" />
          <Button size="sm" variant="primary" onClick={() => pages(next.chapter.id)}>Open in Pages</Button>
        </div>
      )}
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
    </div>
  );
}
