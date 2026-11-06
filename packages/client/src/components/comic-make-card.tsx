import { useState } from "react";
import { useNavigate } from "react-router";
import {
  DEFAULT_COMIC_SETTINGS,
  comicBook,
  comicInk,
  comicPageFinishable,
  comicPageHash,
  comicPanelStates,
  pageAspect,
  panelTakeClears,
  priceLabel,
  type ComicPage,
  type ConversationActionCard,
  type LetteringPlacement,
  type ProductionBundle,
  type WorldBundle,
} from "@arke-studio/contracts";
import { flattenComicPage, type PlacedBalloon } from "../lib/comic-balloons.js";
import { mediaUrl } from "../lib/media.js";
import { finishComicPage, stopComicMake, useStore } from "../lib/store.js";
import { Check, ChevronRight, CircleAlert } from "./icons.js";
import { Button } from "./ui.js";

/**
 * The Make card (design turn 270a – 270c). What it counts is read from the pages themselves, so the card
 * and Pages can never disagree, and a run the app closed on still shows what it left. Its target's pages
 * come from the action, its price from the approved card.
 */
function pagesOf(production: ProductionBundle, action: ConversationActionCard): ComicPage[] {
  const body = action.shown.body;
  const ids = new Set(body.family === "generation" ? body.deterministicInputs ?? [] : []);
  return comicBook(production).filter((entry) => ids.has(entry.id)).map((entry) => entry.page);
}

const artUrl = (world: WorldBundle, artifactId: string | undefined): string | null => {
  const file = world.artifacts.find((candidate) => candidate.id === artifactId)?.file;
  return file ? mediaUrl(world.meta.slug, `artifacts/${file}`) : null;
};

/** Accept page from the card (turn 270c): the same flatten as Words, for pages with nothing left to decide. */
async function acceptPage(world: WorldBundle, production: ProductionBundle, page: ComicPage): Promise<void> {
  const settings = production.comic ?? DEFAULT_COMIC_SETTINGS;
  const record = production.comicPages?.find((entry) => entry.page === page.id)?.record;
  const states = comicPanelStates(page, record, settings);
  const lines = page.panels.flatMap((panel) => panel.lettering);
  const balloons: PlacedBalloon[] = (record?.placements ?? []).flatMap((placement: LetteringPlacement) => {
    const line = lines.find((item) => item.id === placement.item);
    return line ? [{ placement, text: line.text, shape: placement.shape ?? line.kind }] : [];
  });
  const panels = states.map((state) => ({ url: artUrl(world, state.accepted?.artifact)!, rect: state.rect }));
  const aspect = pageAspect(page, settings);
  const jpeg = await flattenComicPage({ aspect, panels, balloons, typeface: settings.typeface, ink: comicInk(settings) });
  finishComicPage(world.meta.worldId, production.meta.id, page.id, comicPageHash(page, settings, "overlay"), jpeg);
}

export function ComicMakeCardBody({ action }: { action: ConversationActionCard }) {
  const world = useStore().state?.world;
  const navigate = useNavigate();
  const [accepting, setAccepting] = useState(false);
  const body = action.shown.body;
  if (body.family !== "generation") return null;
  const production = world?.productions.find((candidate) => candidate.meta.id === action.productionId);
  const cap = body.enforceableCapMicroUsd;
  // Denied or gone stale: it made nothing, and its reason is on the card.
  if (["denied", "stale", "superseded"].includes(action.status)) return null;

  if (action.status === "pending" || !world || !production) {
    return <div className="fy-comicmake">
      <div className="fy-comicmake__facts">
        {(body.options ?? []).map((option) => <div key={option.label}><span>{option.label}</span><b>{option.value}</b></div>)}
        <div><span>Model</span><b>{body.model}</b></div>
        <div className="price"><span>Price</span><b>{body.cost}</b></div>
      </div>
      {action.shown.ripples.map((line) => <p key={line} className="fy-comicmake__note">{line}</p>)}
    </div>;
  }

  const settings = production.comic ?? DEFAULT_COMIC_SETTINGS;
  const pages = pagesOf(production, action);
  const book = comicBook(production);
  const records = (page: ComicPage) => production.comicPages?.find((entry) => entry.page === page.id)?.record;
  const rows = pages.map((page) => {
    const states = comicPanelStates(page, records(page), settings);
    return { page, number: book.find((entry) => entry.id === page.id)?.number ?? 0, states, made: states.filter((state) => state.shown !== undefined).length, making: states.some((state) => state.making) };
  });
  // While it runs, counted from the takes since Approve; once it ends, what was spent is the receipt's, or later takes would count.
  const spent = rows.reduce((sum, row) => sum + row.states.reduce((all, state) => all + state.takes.reduce((takes, take) => takes + (action.decision && take.at >= action.decision.decidedAt ? Math.round((take.usd ?? 0) * 1_000_000) : 0), 0), 0), 0);
  // The limit is enforced, not estimated, and a plan-paid run has none to show.
  const exact = (microUsd: number) => priceLabel(microUsd).replace("~", "");
  const limit = cap === undefined || cap === 0 ? "" : ` of ${exact(cap)}`;

  if (action.status === "running" || action.status === "approved" || action.status === "queued") {
    const stoppable = action.status === "running";
    return <div className="fy-comicmake">
      <div className="fy-comicmake__steps">
        {rows.map((row) => <div key={row.page.id} className={row.made === row.states.length && !row.making ? "done" : row.making ? "now" : ""}>
          {row.made === row.states.length && !row.making ? <Check size={14} /> : <i />}
          <span>Page {row.number}</span><span className="m">{row.made} of {row.states.length}</span>
        </div>)}
      </div>
      {cap !== undefined && cap > 0 && <div className="fy-comicmake__facts"><div className="price"><span>Spent</span><b>{exact(spent)}{limit}</b></div></div>}
      {stoppable && <div className="fy-actioncard__actions"><Button onClick={() => stopComicMake(world.meta.worldId, action.authority.id)}>Stop</Button></div>}
    </div>;
  }

  const panels = rows.flatMap((row) => row.states);
  const lines = rows.flatMap((row) => row.page.panels.flatMap((panel) => panel.lettering));
  const placed = rows.reduce((sum, row) => sum + (records(row.page)?.placements.length ?? 0), 0);
  const needs = rows.flatMap((row) => row.states.filter((state) => state.accepted === undefined && state.shown?.review !== undefined && !panelTakeClears(state.shown)).map((state) => {
    const review = state.shown?.review;
    const first = review?.status === "compared" ? review.findings[0] : undefined;
    return { page: row.page, number: row.number, panel: state.index + 1, kind: first?.kind ?? "review" };
  }));
  const ready = rows.filter((row) => comicPageFinishable(row.page, records(row.page), settings) && !(records(row.page)?.accepted[settings.language]));
  const accept = async () => {
    setAccepting(true);
    try { for (const row of ready) await acceptPage(world, production, row.page); } finally { setAccepting(false); }
  };
  const open = (page: ComicPage) => {
    const chapter = book.find((entry) => entry.id === page.id)?.chapter;
    void navigate(`/w/${world.meta.worldId}/p/${production.meta.id}/story/pages${chapter ? `?chapter=${encodeURIComponent(chapter)}` : ""}`);
  };
  return <div className="fy-comicmake">
    <div className="fy-comicmake__facts">
      <div><span>Panels</span><b>{panels.filter((state) => state.shown !== undefined).length} of {panels.length}</b></div>
      <div><span>Lines placed</span><b>{placed} of {lines.length}</b></div>
    </div>
    {needs.length > 0 && <div className="fy-comicmake__needs">
      <b>Needs you</b>
      {needs.map((need) => <button key={`${need.page.id}:${need.panel}`} type="button" onClick={() => open(need.page)}>
        <CircleAlert size={14} /><span>Page {need.number} · panel {need.panel}</span><span className="m">{need.kind[0]!.toUpperCase()}{need.kind.slice(1)}</span><ChevronRight size={14} />
      </button>)}
    </div>}
    {ready.length > 0 && <div className="fy-actioncard__actions"><Button variant="primary" disabled={accepting} onClick={() => void accept()}>Accept {ready.length} {ready.length === 1 ? "page" : "pages"}</Button></div>}
  </div>;
}
