import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  DEFAULT_COMIC_SETTINGS,
  REVIEW_BLOCKING,
  balanceFaulted,
  balloonBox,
  comicBook,
  comicInk,
  comicPageFinishable,
  comicPageHash,
  comicPanelStates,
  harnessModelReference,
  pageAspect,
  panelTakeClears,
  priceLabel,
  takeBlocking,
  unplacedLines,
  type ComicMode,
  type ComicPage,
  type ComicPanelState,
  type ComicPanelTake,
  type ComicTypeface,
  type LetteringItem,
  type LetteringKind,
  type LetteringPlacement,
  type ProductionBundle,
  type WorldBundle,
} from "@arke-studio/contracts";
import { ComicModelChoice, comicModelRefused } from "../components/comic-model-choice.js";
import { Check, ChevronRight, CircleAlert, RotateCcw, Sparkle, TriangleAlert } from "../components/icons.js";
import { Button, cx } from "../components/ui.js";
import { COMIC_TYPEFACES, clampBox, flattenComicPage, paintStage, panelInset, type PlacedBalloon } from "../lib/comic-balloons.js";
import { comicStylePicture } from "../lib/comic-styles.js";
import { mediaUrl } from "../lib/media.js";
import {
  acceptComicTake,
  checkComicTake,
  finishComicPage,
  makeComicPanels,
  placeComicLettering,
  quoteComicPage,
  seeComicWarning,
  setComicLettering,
  setComicSettings,
  setProductionModel,
  subscribeComicPages,
  useStore,
  type ComicPageQuote,
} from "../lib/store.js";
import { KINDS, REVIEW_FINDING, SPOKEN, Since, Spin, notReviewed } from "./comic-pages.js";

/**
 * Panel by panel (design turn 269, SPEC-064 R-36a – R-48a): the panels made and looked at one by one,
 * then the words placed over them, by hand or by Arke, and one image accepted as the page.
 */

const artUrl = (world: WorldBundle, take: ComicPanelTake | undefined): string | null => {
  const artifact = take && world.artifacts.find((candidate) => candidate.id === take.artifact);
  return artifact ? mediaUrl(world.meta.slug, `artifacts/${artifact.file}`) : null;
};
const percent = (value: number) => `${value * 100}%`;

/** A panel's fault, for the strip and the script's marks (turn 269c). */
export function panelFaulted(state: ComicPanelState): boolean {
  if (state.making) return false;
  if (state.failed !== undefined) return true;
  const take = state.shown;
  return take !== undefined && take.review !== undefined && state.accepted === undefined && !panelTakeClears(take);
}

/** A panel accepted with a fault still on it: settled, but not clean (turn 271b). */
export function panelHeldFault(state: ComicPanelState): boolean {
  return state.accepted !== undefined && !panelTakeClears(state.accepted);
}

/** The mark beside a panel in the script: made, being made, at fault or not yet (turn 269b). */
export function PanelMark({ state }: { state: ComicPanelState }) {
  if (state.making || (state.shown !== undefined && state.shown.review === undefined)) return <span className="fy-comic269__mark" aria-label="Making"><Spin size={12} /></span>;
  if (panelFaulted(state)) return <span className="fy-comic269__mark bad" aria-label="To fix"><CircleAlert size={14} /></span>;
  if (panelHeldFault(state)) return <span className="fy-comic269__mark held" aria-label="Accepted with a fault"><TriangleAlert size={14} /></span>;
  if (state.accepted !== undefined) return <span className="fy-comic269__mark ok" aria-label="Accepted"><Check size={14} /></span>;
  return <span className="fy-comic269__mark none" aria-label="Not made" />;
}

export function PanelTabs({ tab, pick }: { tab: "panels" | "words"; pick: (tab: "panels" | "words") => void }) {
  return (
    <span className="fy-comic269__tabs" role="tablist" aria-label="Panel by panel">
      <button type="button" role="tab" aria-selected={tab === "panels"} className={cx(tab === "panels" && "on")} onClick={() => pick("panels")}>Panels</button>
      <button type="button" role="tab" aria-selected={tab === "words"} className={cx(tab === "words" && "on")} onClick={() => pick("words")}>Words</button>
    </span>
  );
}

export function PanelSide({ world, production, page, selected, select, saving, connected, tab, pickTab, onReviewer, changeWithArke }: {
  world: WorldBundle; production: ProductionBundle; page: ComicPage; selected: string | null; select: (panel: string) => void; saving: boolean; connected: boolean;
  tab: "panels" | "words"; pickTab: (tab: "panels" | "words") => void; onReviewer: () => void; changeWithArke: ((panel: number, finding: string | null) => void) | null;
}) {
  const worldId = world.meta.worldId;
  const productionId = production.meta.id;
  const settings = production.comic ?? DEFAULT_COMIC_SETTINGS;
  const record = production.comicPages?.find((entry) => entry.page === page.id)?.record;
  const states = useMemo(() => comicPanelStates(page, record, settings), [page, record, settings]);
  const current = states.find((state) => state.panel.id === selected) ?? states.find(panelFaulted) ?? states[0];
  const [shownId, setShownId] = useState<string | null>(null);
  const shown = current?.takes.find((take) => take.id === shownId) ?? current?.shown;
  const toMake = states.filter((state) => state.shown === undefined && !state.making);
  const making = states.filter((state) => state.making);
  const made = states.filter((state) => state.shown !== undefined).length;
  const aspect = pageAspect(page, settings);
  // The press covers the panels with nothing on them; once all have a picture, the panel in hand.
  const only = toMake.length > 0 ? undefined : current?.panel.id;
  const [quoted, setQuoted] = useState<{ key: string; quote: ComicPageQuote["quote"] } | null>(null);
  const [pressed, setPressed] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [brief, setBrief] = useState(false);
  const state = useStore().state;
  const modelChoice = JSON.stringify([production.meta.models?.image, state?.app.routing, state?.app.models.disabled]);
  const [asking, setAsking] = useState(0);
  const key = JSON.stringify([page.id, only ?? null, toMake.map((entry) => entry.hash), current?.hash, modelChoice, asking]);
  const asked = useRef<{ requestId: string; key: string } | null>(null);
  const quote = quoted !== null && quoted.key === key && !saving ? quoted.quote : null;
  const usable = quote?.ok === true && !comicModelRefused(state, quote.model);
  const busy = making.length > 0 || pressed;

  useEffect(() => subscribeComicPages((event) => {
    if (event.type === "comic.page-quote" && event.requestId === asked.current?.requestId) setQuoted({ key: asked.current.key, quote: event.quote });
    if (event.type === "comic.page-made" && event.page === page.id) {
      setPressed(false);
      if (event.state === "failed") setSaid(balanceFaulted({ fault: event.reason ?? null }) ? "Out of credit. Choose another model or add credit." : event.panel === undefined ? event.reason ?? "not made" : null);
    }
    if (event.type === "comic.take-result" && event.page === page.id) setSaid(event.disposition === "refused" ? event.reason ?? "refused" : null);
  }), [page.id]);
  useEffect(() => {
    if (!connected || saving) return;
    const requestId = quoteComicPage(worldId, productionId, page.id, undefined, only);
    asked.current = requestId === null ? null : { requestId, key };
  }, [connected, saving, key]); // eslint-disable-line react-hooks/exhaustive-deps
  // A picture that outlasts the press's wait is filed by the next quote, as a whole page's is (R-25).
  useEffect(() => {
    if (making.length === 0 || pressed) return;
    const tick = setInterval(() => setAsking((n) => n + 1), 60_000);
    return () => clearInterval(tick);
  }, [making.length, pressed]);
  useEffect(() => setShownId(null), [current?.panel.id]);

  const make = () => {
    if (!usable || !quote?.ok) return;
    setSaid(null);
    setPressed(true);
    if (makeComicPanels(worldId, productionId, page.id, quote.microUsd, only) === null) setPressed(false);
  };
  const faulted = states.filter(panelFaulted);
  const faultAt = current === undefined ? -1 : faulted.findIndex((entry) => entry.panel.id === current.panel.id);
  const nextFault = faulted.length > (faultAt >= 0 ? 1 : 0) ? faulted[(faultAt + 1) % faulted.length] : undefined;
  // Accepting goes on to the next fault (turn 271b): three flagged panels were three hunts through the page.
  const accept = (take: ComicPanelTake, overrides?: { findings: string[] }) => {
    acceptComicTake(worldId, productionId, page.id, take.id, overrides);
    if (nextFault !== undefined && nextFault.panel.id !== current?.panel.id) select(nextFault.panel.id);
  };
  const review = shown?.review;
  const seen = new Set(shown ? record?.acknowledged[shown.id] ?? [] : []);
  const faults = review?.status === "compared" ? review.findings.filter((finding) => REVIEW_BLOCKING.has(finding.kind)) : [];
  const unreviewed = notReviewed(review);
  const reading = shown !== undefined && review === undefined;
  const modelLabel = (reference: string) => state?.app.harnessModels.find((model) => harnessModelReference(model) === reference)?.displayName ?? reference.split("/").at(-1)!;
  const press = busy ? "Making" : toMake.length > 0 && made === 0 && !states.some((entry) => entry.failed) ? "Make panels" : "Make again";
  const cost = quote?.ok !== true ? "" : quote.model === "codex-image" ? priceLabel(0, "included-plan") : priceLabel(quote.microUsd);
  const accepted = record?.accepted[settings.language];
  const standing = record?.takes.find((take) => take.id === accepted);
  const standingUrl = standing && (() => { const file = world.artifacts.find((candidate) => candidate.id === standing.artifact)?.file; return file ? mediaUrl(world.meta.slug, `artifacts/${file}`) : null; })();
  // A page made before the book changed mode stays until its panels are made (R-36a).
  const keptWhole = standing?.mode === "baked" && states.every((entry) => entry.shown === undefined && !entry.making);
  const allAccepted = states.every((entry) => entry.accepted !== undefined);
  const held = current !== undefined && panelHeldFault(current) && shown?.id === current.accepted?.id;

  return (
    <div className="fy-comic__side">
      <PanelTabs tab={tab} pick={pickTab} />
      {/* The page gives up height so the verdict, takes and actions stay on screen (turn 271a). */}
      <div className="fy-comic__page fy-comic271__page" style={{ aspectRatio: aspect.replace(":", " / "), "--page-ratio": aspect.replace(":", " / ") } as CSSProperties}>
        {keptWhole && standingUrl ? <img src={standingUrl} alt="Page as made" /> : states.map((entry) => {
          const url = artUrl(world, entry.panel.id === current?.panel.id ? shown : entry.shown);
          const box = panelInset(entry.rect, aspect);
          return (
            <button key={entry.panel.id} type="button" aria-label={`Panel ${entry.index + 1}`} aria-pressed={entry.panel.id === current?.panel.id}
              className={cx("fy-comic269__cell", entry.panel.id === current?.panel.id && "on", url === null && "empty")} onClick={() => select(entry.panel.id)}
              style={{ left: percent(box.x), top: percent(box.y), width: percent(box.w), height: percent(box.h) }}>
              {url !== null ? <img src={url} alt="" /> : entry.making ? (
                <span className="fy-comic269__state"><Spin size={16} /><b>Making</b><span className="m">{record?.making.find((held) => held.panel === entry.panel.id) && <Since at={record.making.find((held) => held.panel === entry.panel.id)!.at} />}</span></span>
              ) : entry.failed ? <span className="fy-comic269__state bad"><CircleAlert size={16} /><b>Not made</b></span> : <span className="fy-comic269__num">{entry.index + 1}</span>}
              {entry.panel.id === current?.panel.id && review?.status === "compared" && review.findings.filter((finding) => finding.box).map((finding) => (
                <span key={finding.id} className={cx("fy-comic__hit", !REVIEW_BLOCKING.has(finding.kind) && "w")} style={{ left: percent(finding.box!.x), top: percent(finding.box!.y), width: percent(finding.box!.w), height: percent(finding.box!.h) }}>
                  <span>{REVIEW_FINDING[finding.kind]}</span>
                </span>
              ))}
            </button>
          );
        })}
      </div>
      {current !== undefined && (
        <div className="fy-comic__verdicts fy-comic271__review">
          {current.failed && shown === undefined ? (
            <div className="fy-comic__verdict bad" title={current.failed}><CircleAlert size={15} /><b>Panel {current.index + 1}</b><span>{/refus|moderat|safety|policy/i.test(current.failed) ? "refused" : "not made"}</span></div>
          ) : shown === undefined ? null : reading ? (
            <div className="fy-comic__verdict"><Spin size={15} /><b>Panel {current.index + 1}</b><span>checking</span></div>
          ) : review?.status === "compared" ? (
            <div className={cx("fy-comic__verdict", held ? "warn" : faults.length ? "bad" : "ok")}>
              {held ? <TriangleAlert size={15} /> : faults.length ? <CircleAlert size={15} /> : <Check size={15} />}
              <b>Panel {current.index + 1}</b><span>{held ? `Accepted · ${faults.length} ${faults.length === 1 ? "fault" : "faults"}` : faults.length ? `${faults.length} to fix` : "as written"}</span>
              <span className="grow" />
              {allAccepted ? <Button size="sm" onClick={() => pickTab("words")}>Words</Button> : null}
              {faultAt >= 0 && <span className="m">{faultAt + 1} of {faulted.length}</span>}
              {faultAt >= 0 && nextFault !== undefined && nextFault.panel.id !== current.panel.id && <button type="button" className="fy-comic271__next" aria-label="Next fault" onClick={() => select(nextFault.panel.id)}><ChevronRight size={13} /></button>}
              {faultAt < 0 && !allAccepted && <span className="m">{modelLabel(review.reviewer.version.split(":")[1] ?? review.reviewer.id)}</span>}
            </div>
          ) : (
            <div className="fy-comic__verdict warn"><TriangleAlert size={15} /><b>Panel {current.index + 1}</b><span>not checked</span><span className="grow" /><span className="m">{unreviewed.text}</span></div>
          )}
          {review?.status === "compared" && review.findings.length > 0 && (
            <div className="fy-comic__finds">
              {review.findings.map((finding) => {
                const warning = !REVIEW_BLOCKING.has(finding.kind);
                const looked = warning && seen.has(finding.kind as "layout" | "continuity" | "likeness");
                return (
                  <div key={finding.id} className={cx("fy-comic__find", looked && "clear")}>
                    <span className={cx("k", warning && "w")}>{REVIEW_FINDING[finding.kind]}</span>
                    <span className="what">{finding.note}</span>
                    {warning && !looked && shown !== undefined && <Button size="sm" disabled={!connected} onClick={() => seeComicWarning(worldId, productionId, page.id, shown.id, finding.kind as "layout" | "continuity" | "likeness")}>Seen</Button>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {current !== undefined && current.takes.length > 0 && (
        <div className="fy-comic__takes">
          {current.takes.map((take, index) => (
            <button key={take.id} type="button" className={cx("fy-comic__take", take.id === shown?.id && "on")} aria-label={`Take ${index + 1}`} onClick={() => setShownId(take.id)}>
              {artUrl(world, take) !== null && <img src={artUrl(world, take)!} alt="" />}
              <span className={cx("k", panelTakeClears(take) && "ok")} />
            </button>
          ))}
          <span className="m">{shown?.id === current.accepted?.id ? "Accepted · " : ""}Take {current.takes.indexOf(shown!) + 1} of {current.takes.length}</span>
        </div>
      )}
      <div className="fy-comic__acts">
        {shown !== undefined && !reading && shown.id !== current?.accepted?.id && panelTakeClears(shown) && shown.hash === current?.hash && <Button variant="primary" onClick={() => accept(shown)}>Accept</Button>}
        {unreviewed.reviewer && shown !== undefined && !reading && <Button variant="primary" onClick={onReviewer}>Choose reviewer</Button>}
        <Button variant={shown !== undefined && !reading && shown.id !== current?.accepted?.id && panelTakeClears(shown) ? "secondary" : "primary"} disabled={!usable || busy || !connected || (only !== undefined && quote?.ok === true && quote.microUsd === 0 && quote.model !== "codex-image" && current === undefined)} onClick={make}
          title={quote && !quote.ok ? quote.reason : undefined}>{busy ? <Spin size={13} /> : <Sparkle size={13} />}{press}</Button>
        {usable && !busy && <span className="fy-comic__price">{cost}</span>}
        {shown !== undefined && !reading && !panelTakeClears(shown) && shown.id !== current?.accepted?.id && shown.hash === current?.hash && (
          <Button title="Keeps this take with what was found on the record" onClick={() => accept(shown, { findings: takeBlocking(shown) })}>Accept anyway</Button>
        )}
        {changeWithArke !== null && current !== undefined && (faults.length > 0 || current.failed !== undefined) && <Button onClick={() => { const first = review?.status === "compared" ? review.findings.find((finding) => REVIEW_BLOCKING.has(finding.kind)) : undefined; changeWithArke(current.index + 1, first ? `${REVIEW_FINDING[first.kind]}: ${first.note}` : null); }}>Change with Arke</Button>}
        <span className="grow" />
        {shown !== undefined && !reading && review?.status === "unavailable" && <Button variant="ghost" size="sm" disabled={!connected} onClick={() => checkComicTake(worldId, productionId, page.id, shown.id)}>Check again</Button>}
      </div>
      {said !== null && <div className="fy-comic__verdict bad"><CircleAlert size={15} /><span>{said}</span></div>}
      {quote && !quote.ok && <div className="fy-comic__verdict warn"><TriangleAlert size={15} /><span>{quote.reason}</span></div>}
      {usable && quote?.ok && quote.missing.length > 0 && <div className="fy-comic__verdict warn"><TriangleAlert size={15} /><span>No picture of {quote.missing.join(", ")}</span></div>}
      {brief && quote?.ok && <pre className="fy-comic__brief">{quote.brief}</pre>}
      <div className="fy-comic271__foot">
        <span className="m" title={usable && quote?.ok && quote.riding.length ? `${quote.riding.join(", ")} ride` : undefined}>{made} of {states.length}</span>
        <ComicModelChoice wordless state={state} choices={production.meta.models} disabled={!connected || busy}
          onChange={(model) => { setQuoted(null); asked.current = null; setProductionModel(worldId, productionId, "image", model); }} />
        <span className="grow" />
        <Button variant="ghost" size="sm" aria-expanded={brief} onClick={() => setBrief(!brief)}>Brief</Button>
      </div>
    </div>
  );
}

/** Every line of the page, in reading order, with the panel holding it. */
function pageLines(page: ComicPage): Array<{ item: LetteringItem; panel: number }> {
  return page.panels.flatMap((panel, index) => panel.lettering.map((item) => ({ item, panel: index })));
}

type Handle = "move" | "a" | "b" | "c" | "d" | "tail";

/**
 * The Words tab (turn 269d, 269e): the page's lines from the script beside the page large. A line's
 * words are the script's, edited here as anywhere, and redraw no panel; dragging only moves its box.
 */
export function PageWords({ world, production, page, chapter, saving, connected, tab, pickTab, change }: {
  world: WorldBundle; production: ProductionBundle; page: ComicPage; chapter: string; saving: boolean; connected: boolean;
  tab: "panels" | "words"; pickTab: (tab: "panels" | "words") => void; change: (edit: (page: ComicPage) => ComicPage) => void;
}) {
  const worldId = world.meta.worldId;
  const productionId = production.meta.id;
  const settings = production.comic ?? DEFAULT_COMIC_SETTINGS;
  const record = production.comicPages?.find((entry) => entry.page === page.id)?.record;
  const states = useMemo(() => comicPanelStates(page, record, settings), [page, record, settings]);
  const aspect = pageAspect(page, settings);
  const lines = useMemo(() => pageLines(page), [page]);
  const stored = record?.placements;
  const storedKey = JSON.stringify(stored ?? []);
  // A line deleted in the script leaves its placement on the record; sent back, it would refuse every later save (codex on PR 2582).
  const known = (list: readonly LetteringPlacement[]) => list.filter((entry) => lines.some((line) => line.item.id === entry.item));
  const [placements, setPlacements] = useState<LetteringPlacement[]>(() => known(stored ?? []));
  const undo = useRef<LetteringPlacement[][]>([]);
  const dragging = useRef(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [, setUndoDepth] = useState(0);
  const asked = useRef<string | null>(null);
  // One save in flight and the newest waiting. Each replaces the whole layer, and frames are answered
  // concurrently: sent together, or with an older snapshot read as news, a line just placed vanished
  // and the next press saved the list without it.
  const inFlight = useRef<{ requestId: string; key: string } | null>(null);
  const queued = useRef<{ next: LetteringPlacement[]; undoesPlacing: boolean } | null>(null);
  const answeredAt = useRef(0);
  const [sending, setSending] = useState(false);
  const flush = () => {
    const wanted = queued.current;
    if (inFlight.current !== null || wanted === null) { setSending(inFlight.current !== null || wanted !== null); return; }
    queued.current = null;
    const requestId = setComicLettering(worldId, productionId, page.id, wanted.next, wanted.undoesPlacing);
    if (requestId === null) { setSaid("not connected"); setSending(false); return; }
    inFlight.current = { requestId, key: JSON.stringify(wanted.next) };
    setSending(true);
  };
  const save = (next: LetteringPlacement[], undoesPlacing = false) => {
    queued.current = { next: known(next), undoesPlacing: undoesPlacing || queued.current?.undoesPlacing === true };
    flush();
  };
  // Leaving with an edit still waiting sends it: nothing here would hear the answer it waits for (codex on PR 2582).
  useEffect(() => () => {
    if (queued.current !== null) setComicLettering(worldId, productionId, page.id, queued.current.next, queued.current.undoesPlacing);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (dragging.current || inFlight.current !== null || queued.current !== null) return;
    // Just after a save, only the snapshot of that save is news; anything else is older and on its way past.
    if (Date.now() - answeredAt.current < 1500 && storedKey !== lastSaved.current) return;
    setPlacements(known(stored ?? []));
  }, [storedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastSaved = useRef<string | null>(null);
  useEffect(() => subscribeComicPages((event) => {
    if (event.type === "comic.page-lettered" && event.page === page.id) {
      if (event.requestId === asked.current) setFinishing(false);
      if (event.requestId === inFlight.current?.requestId) {
        answeredAt.current = event.disposition === "refused" ? 0 : Date.now();
        lastSaved.current = inFlight.current.key;
        inFlight.current = null;
        flush();
      }
      setSaid(event.disposition === "refused" ? event.reason ?? "refused" : null);
    }
    if (event.type === "comic.lettering-placed" && event.requestId === asked.current) {
      // Edits from before the placing would step back over it: from here Undo takes the placing back first.
      if (event.state === "placed") { undo.current = []; setUndoDepth(0); }
      setPlacing(event.state === "placing");
      setSaid(event.state === "failed" ? event.reason ?? "not placed" : null);
    }
  }), [page.id]);

  const placedIds = new Set(placements.map((entry) => entry.item));
  const left = unplacedLines(page, { ...(record ?? EMPTY), placements });
  const balloons: PlacedBalloon[] = placements.flatMap((placement) => {
    const line = lines.find((entry) => entry.item.id === placement.item);
    return line ? [{ placement, text: line.item.text, shape: placement.shape ?? line.item.kind }] : [];
  });
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const element = stage.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => entry && setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const ink = comicInk(settings);
  const paint = () => { if (canvas.current && size) paintStage(canvas.current, balloons, size, settings.typeface, ink); };
  useEffect(paint);
  // A typeface not yet used on screen arrives after the first paint.
  useEffect(() => { void document.fonts?.ready.then(paint); }, [settings.typeface]); // eslint-disable-line react-hooks/exhaustive-deps

  // The newest list, read at the press: two presses before a render must not each build on the old one.
  const latest = useRef(placements);
  latest.current = placements;
  const commit = (next: LetteringPlacement[], before: LetteringPlacement[] = latest.current) => {
    undo.current = [...undo.current.slice(-49), before];
    setUndoDepth(undo.current.length);
    latest.current = next;
    setPlacements(next);
    save(next);
  };
  /** One Undo (turn 271d): the last change, whether the author's or a placing by Arke, which counts as one. */
  const stepBack = () => {
    const previous = undo.current.at(-1);
    if (previous !== undefined) {
      undo.current = undo.current.slice(0, -1);
      setUndoDepth(undo.current.length);
      setPlacements(previous);
      save(previous);
    } else if (record?.placedByArke) {
      setPlacements(known(record.placedByArke.before));
      save(record.placedByArke.before, true);
    }
  };
  const undoButton = undo.current.length > 0 || record?.placedByArke ? <Button size="sm" disabled={!connected} onClick={stepBack}><RotateCcw size={13} />Undo</Button> : null;
  /** A line placed where its panel has room; dragging puts it where the author wants it. */
  const place = (item: LetteringItem, panelIndex: number) => {
    const rect = states[panelIndex]?.rect;
    if (!rect) return;
    const others = latest.current.map((entry) => entry.box);
    const box = balloonBox(item, panelInset(rect, aspect), aspect, { x: 0.04, y: 0.04 }, others);
    const tail = SPOKEN.has(item.kind) ? { x: Math.min(1, box.x + box.w * 0.6), y: Math.min(1, box.y + box.h + 0.03) } : undefined;
    commit([...latest.current, { item: item.id, box, ...(tail ? { tail } : {}) }]);
    setPicked(item.id);
  };
  const edit = (id: string, patch: Partial<LetteringPlacement>) => commit(latest.current.map((entry) => entry.item === id ? { ...entry, ...patch } : entry));
  const drag = (event: ReactPointerEvent<HTMLElement>, id: string, handle: Handle) => {
    event.preventDefault();
    event.stopPropagation();
    setPicked(id);
    const start = placements.find((entry) => entry.item === id);
    const frame = stage.current?.getBoundingClientRect();
    if (!start || !frame) return;
    const before = placements;
    const from = { x: event.clientX, y: event.clientY };
    dragging.current = true;
    const at = (move: { clientX: number; clientY: number }) => ({ dx: (move.clientX - from.x) / frame.width, dy: (move.clientY - from.y) / frame.height });
    const moved = (move: { clientX: number; clientY: number }) => {
      const { dx, dy } = at(move);
      const box = start.box;
      if (handle === "tail") return { ...start, tail: { x: Math.max(0, Math.min(1, (move.clientX - frame.left) / frame.width)), y: Math.max(0, Math.min(1, (move.clientY - frame.top) / frame.height)) } };
      if (handle === "move") return { ...start, box: clampBox({ ...box, x: box.x + dx, y: box.y + dy }), ...(start.tail ? { tail: start.tail } : {}) };
      const west = handle === "a" || handle === "c";
      const north = handle === "a" || handle === "b";
      return { ...start, box: clampBox({ x: west ? box.x + dx : box.x, y: north ? box.y + dy : box.y, w: west ? box.w - dx : box.w + dx, h: north ? box.h - dy : box.h + dy }) };
    };
    const onMove = (move: PointerEvent) => setPlacements(before.map((entry) => entry.item === id ? moved(move) : entry));
    const onUp = (up: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      dragging.current = false;
      const { dx, dy } = at(up);
      // A press with no move only picks the line.
      if (Math.abs(dx) + Math.abs(dy) < 0.002) { setPlacements(before); return; }
      commit(before.map((entry) => entry.item === id ? moved(up) : entry), before);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const pickedPlacement = placements.find((entry) => entry.item === picked);
  const pickedLine = lines.find((entry) => entry.item.id === picked)?.item;
  const notAccepted = states.filter((state) => state.accepted === undefined).length;
  const hash = comicPageHash(page, settings, "overlay");
  const finishable = comicPageFinishable(page, record ? { ...record, placements } : undefined, settings);
  const standing = record?.takes.find((take) => take.id === record.accepted[settings.language]);
  const done = standing?.mode === "overlay" && standing.hash === hash;
  const accept = async () => {
    setSaid(null);
    setFinishing(true);
    try {
      const panels = states.map((state) => ({ url: artUrl(world, state.accepted)!, rect: state.rect }));
      const jpeg = await flattenComicPage({ aspect, panels, balloons, typeface: settings.typeface, ink });
      asked.current = finishComicPage(worldId, productionId, page.id, hash, jpeg);
      if (asked.current === null) { setFinishing(false); setSaid("not connected"); }
    } catch (err) {
      setFinishing(false);
      setSaid(err instanceof Error ? err.message : "the page could not be drawn");
    }
  };
  const arke = (target: { kind: "page"; page: string } | { kind: "chapter"; chapter: string }) => {
    setSaid(null);
    setPlacing(true);
    asked.current = placeComicLettering(worldId, productionId, target);
    if (asked.current === null) { setPlacing(false); setSaid("not connected"); }
  };
  const editLine = (id: string, patch: (item: LetteringItem) => void) => change((current) => {
    for (const panel of current.panels) for (const item of panel.lettering) if (item.id === id) patch(item);
    return current;
  });
  const characters = world.sheets.filter((sheet) => sheet.type === "character");
  const number = (comicBook(production).find((entry) => entry.id === page.id)?.number) ?? 1;

  return (
    <>
      <div className="fy-comic__edit fy-comic269__lines">
        <h3>Page {number}<span className="grow" /><span className="m">{lines.length - left.length} of {lines.length} placed</span><PanelTabs tab={tab} pick={pickTab} /></h3>
        {record?.placedByArke ? (
          <div className="fy-comic269__placed"><Sparkle size={14} /><b>Arke placed {record.placedByArke.lines} {record.placedByArke.lines === 1 ? "line" : "lines"}</b><span className="grow" />{undoButton}</div>
        ) : null}
        {notAccepted > 0 ? (
          // What is in the way, and the way to it (turn 271c), in place of a greyed press with no reason.
          <div className="fy-comic271__blocked"><CircleAlert size={15} /><b>{notAccepted} {notAccepted === 1 ? "panel" : "panels"} to accept</b><span className="grow" />{!record?.placedByArke && undoButton}<Button variant="primary" onClick={() => pickTab("panels")}>Panels<ChevronRight size={13} /></Button></div>
        ) : left.length > 0 || (!record?.placedByArke && undoButton !== null) ? (
          <div className="fy-comic269__acts">
            {left.length > 0 && <Button variant="primary" disabled={placing || !connected} onClick={() => arke({ kind: "page", page: page.id })}>{placing ? <Spin size={13} /> : <Sparkle size={13} />}Place with Arke</Button>}
            {left.length > 0 && <Button disabled={placing || !connected} onClick={() => arke({ kind: "chapter", chapter })}>Whole chapter</Button>}
            <span className="grow" />
            {!record?.placedByArke && undoButton}
          </div>
        ) : null}
        <div className="fy-comic271__scroll">
        {lines.map(({ item, panel }, index) => (
          <div key={item.id} role="button" tabIndex={0} className={cx("fy-comic269__line", item.id === picked && "on")} onClick={() => { setPicked(item.id); if (!placedIds.has(item.id) && connected) place(item, panel); }}
            onKeyDown={(event) => { if (event.key === "Enter" && event.target === event.currentTarget) { setPicked(item.id); if (!placedIds.has(item.id)) place(item, panel); } }}>
            <i className="ord">{index + 1}</i>
            <div className="body">
              <div className="top">
                <select aria-label="Kind" value={item.kind} onClick={(event) => event.stopPropagation()} onChange={(event) => editLine(item.id, (current) => { current.kind = event.target.value as LetteringKind; if (!SPOKEN.has(current.kind)) delete current.speaker; })}>
                  {KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                {SPOKEN.has(item.kind) ? (
                  <select aria-label="Speaker" value={item.speaker ?? ""} onClick={(event) => event.stopPropagation()} onChange={(event) => editLine(item.id, (current) => { if (event.target.value) current.speaker = event.target.value; else delete current.speaker; })}>
                    <option value="">—</option>
                    {characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                ) : <span className="m">—</span>}
                <span className="grow" />
                <span className="m">Panel {panel + 1}</span>
                <span className={cx("fy-comic269__mark", placedIds.has(item.id) ? "ok" : "none")} aria-label={placedIds.has(item.id) ? "Placed" : "Not placed"}>{placedIds.has(item.id) && <Check size={14} />}</span>
              </div>
              <textarea aria-label="Words" rows={1} value={item.text} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} onChange={(event) => editLine(item.id, (current) => { current.text = event.target.value; })} />
            </div>
          </div>
        ))}
        </div>
        <div className="fy-comic269__tool">
          {pickedPlacement !== undefined && pickedLine !== undefined && <>
            <label className="fy-comic__sel"><b>Shape</b>
              <select aria-label="Shape" value={pickedPlacement.shape ?? pickedLine.kind} onChange={(event) => edit(pickedPlacement.item, { shape: event.target.value as LetteringKind })}>
                {KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="fy-comic__sel"><b>Size</b>
              <select aria-label="Size" value={pickedPlacement.size ?? "m"} onChange={(event) => edit(pickedPlacement.item, { size: event.target.value as "s" | "m" | "l" })}>
                <option value="s">S</option><option value="m">M</option><option value="l">L</option>
              </select>
            </label>
          </>}
          <span className="grow" />
          <label className="fy-comic__sel"><b>Lettering</b>
            <select aria-label="Lettering" value={settings.typeface ?? "comic"} onChange={(event) => setComicSettings(worldId, productionId, { typeface: event.target.value as ComicTypeface })}>
              {COMIC_TYPEFACES.map((face) => <option key={face.value} value={face.value}>{face.label}</option>)}
            </select>
          </label>
        </div>
        <div className="fy-comic269__verdict">
          <span className={cx("fy-comic269__mark", finishable ? "ok" : "none")}>{finishable && <Check size={14} />}</span>
          <b>{done ? "Page accepted" : notAccepted > 0 ? `${notAccepted} ${notAccepted === 1 ? "panel" : "panels"} to accept` : left.length > 0 ? `${left.length} ${left.length === 1 ? "line" : "lines"} to place` : "Every line placed"}</b>
          <span className="grow" />
          {!done && <Button variant={finishable ? "primary" : "secondary"} disabled={!finishable || finishing || saving || sending || !connected} onClick={() => void accept()}>{finishing && <Spin size={13} />}Accept page</Button>}
        </div>
        {said !== null && <div className="fy-comic__verdict bad"><CircleAlert size={15} /><span>{said}</span></div>}
      </div>
      <div className="fy-comic269__stage">
        <div ref={stage} className="fy-comic269__sheet" style={{ aspectRatio: aspect.replace(":", " / ") }} onPointerDown={() => setPicked(null)}>
          {states.map((state) => {
            const box = panelInset(state.rect, aspect);
            const url = artUrl(world, state.accepted ?? state.shown);
            return <div key={state.panel.id} className={cx("fy-comic269__art", url === null && "empty")} style={{ left: percent(box.x), top: percent(box.y), width: percent(box.w), height: percent(box.h) }}>{url !== null ? <img src={url} alt="" draggable={false} /> : <span className="fy-comic269__num">{state.index + 1}</span>}</div>;
          })}
          <canvas ref={canvas} className="fy-comic269__ink" aria-hidden />
          {placements.map((placement) => {
            const index = lines.findIndex((entry) => entry.item.id === placement.item);
            if (index < 0) return null;
            const on = placement.item === picked;
            return (
              <div key={placement.item} className={cx("fy-comic269__hit", on && "on")} role="button" aria-label={`Line ${index + 1}`} tabIndex={0} onPointerDown={(event) => drag(event, placement.item, "move")}
                style={{ left: percent(placement.box.x), top: percent(placement.box.y), width: percent(placement.box.w), height: percent(placement.box.h) }}>
                <i className="ord">{index + 1}</i>
                {on && (["a", "b", "c", "d"] as const).map((corner) => <u key={corner} className={corner} onPointerDown={(event) => drag(event, placement.item, corner)} />)}
              </div>
            );
          })}
          {pickedPlacement?.tail !== undefined && <span className="fy-comic269__aim" role="button" aria-label="Tail" onPointerDown={(event) => drag(event, pickedPlacement.item, "tail")} style={{ left: percent(pickedPlacement.tail.x), top: percent(pickedPlacement.tail.y) }} />}
        </div>
      </div>
    </>
  );
}

const EMPTY = { version: 1 as const, takes: [], accepted: {}, lettering: {}, acknowledged: {}, making: [], panelTakes: [], panelAccepted: {}, panelFailed: {}, placements: [] };

/** Mode (turn 269a): two cards, the choice the book's, and the pages made kept. */
export function ComicModeSheet({ worldId, productionId, mode, made, onClose }: { worldId: string; productionId: string; mode: ComicMode; made: number; onClose: () => void }) {
  const [choice, setChoice] = useState<ComicMode>(mode);
  const picture = comicStylePicture("painted");
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const card = (value: ComicMode, name: string, facts: string[], drawn: React.ReactNode) => (
    <button type="button" role="radio" aria-checked={choice === value} className={cx("fy-comic269__card", choice === value && "on")} onClick={() => setChoice(value)}>
      <span className="pic">{drawn}</span>
      <span className="txt"><b>{name}</b>{facts.map((fact) => <span key={fact}>{fact}</span>)}</span>
    </button>
  );
  return (
    <div className="fy-comic269__scrim" onClick={onClose}>
      <div className="fy-comic269__modal" role="dialog" aria-label="Mode" onClick={(event) => event.stopPropagation()}>
        <h3>Mode</h3>
        <div className="fy-comic269__cards" role="radiogroup" aria-label="Mode">
          {card("baked", "Whole page", ["One image per page", "Words in the picture", "Redo means the page"], <span className="sheet"><img src={picture} alt="" /></span>)}
          {card("overlay", "Panel by panel", ["One image per panel", "Words placed after", "Redo one panel"], (
            <span className="sheet apart">
              <span className="c a"><img src={picture} alt="" /></span><span className="c b"><img src={picture} alt="" /></span><span className="c d"><img src={picture} alt="" /></span>
              <span className="w one">She stopped.</span><span className="w two">Where are you?</span>
            </span>
          ))}
        </div>
        <div className="fy-comic269__foot">
          {made > 0 && <span className="m">{made} {made === 1 ? "page" : "pages"} made stay as they are</span>}
          <span className="grow" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={choice === mode} onClick={() => { setComicSettings(worldId, productionId, { mode: choice }); onClose(); }}>Use {choice === "baked" ? "Whole page" : "Panel by panel"}</Button>
        </div>
      </div>
    </div>
  );
}
