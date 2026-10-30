import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  BLOCKING_FINDINGS,
  chapterParagraphs,
  ComicScriptSchema,
  DEFAULT_COMIC_SETTINGS,
  LAYOUT_TEMPLATES,
  comicBook,
  comicPageHash,
  pageAspect,
  pageReading,
  panelRects,
  priceLabel,
  takePasses,
  ulid,
  type ComicPage,
  type ComicPageTake,
  type ComicPanel,
  type ComicReading,
  type ComicSettings,
  type ComicSource,
  type ComicStyle,
  type LetteringFinding,
  type LetteringItem,
  type LetteringKind,
  type ProductionBundle,
  type WorldBundle,
} from "@arke-studio/contracts";
import { EditorDialog } from "../components/editor-dialog.js";
import { Check, ChevronLeft, ChevronRight, CircleAlert, LoaderCircle, Plus, Sparkle, TriangleAlert, X } from "../components/icons.js";
import { EmptyState, Screen } from "../components/layout.js";
import { Button, cx } from "../components/ui.js";
import { mediaUrl } from "../lib/media.js";
import { ComicStylePicker } from "../components/comic-style-picker.js";
import { useGlobalChat } from "../components/global-chat-context.js";
import { paragraphLabel } from "../lib/episode-script.js";
import { comicStylePicture, comicStylePreset, draftFromStyle, styleFromDraft, type ComicStyleDraft } from "../lib/comic-styles.js";
import { useProduction } from "../lib/selectors.js";
import {
  acceptComicTake,
  acceptProposal,
  discardProposal,
  openChapter,
  readChapterVersion,
  subscribeChapterOpenResults,
  checkComicTake,
  exportArkePlayer,
  exportComic,
  makeComicPage,
  quoteComicPage,
  saveComicScript,
  setComicSettings,
  subscribeArkePlayerExported,
  subscribeComicExported,
  subscribeComicPages,
  subscribeComicScriptSaveResults,
  useStore,
  type ComicPageQuote,
} from "../lib/store.js";

/**
 * A graphic novel's Pages (design turn 247, SPEC-064): the chapter's page strip, a page's editor —
 * its layout, its panels and their lines, which together are the script — and the page itself with
 * its takes, each take's lettering findings drawn where they are. Read shows the accepted pages;
 * Export makes the book. Lettering is always the model's (owner, turn 247): there is no overlay.
 */

const KINDS: Array<[LetteringKind, string]> = [["caption", "Caption"], ["speech", "Speech"], ["thought", "Thought"], ["shout", "Shout"], ["whisper", "Whisper"], ["sfx", "Sound"]];
const SPOKEN = new Set<LetteringKind>(["speech", "thought", "shout", "whisper"]);
const FINDING: Record<LetteringFinding["kind"], string> = { missing: "Missing", altered: "Altered", extra: "Extra", clipped: "Cut off", order: "Order", speaker: "Speaker" };
const LAYOUT_LABEL: Record<string, string> = { "grid-2x2": "Grid", "grid-3x3": "Grid 3×3", "strip-3": "Wide", splash: "Splash", feature: "Feature", manga: "Manga", webtoon: "Webtoon" };
const READING: Array<[ComicReading, string]> = [["ltr", "Left to right"], ["rtl", "Right to left"], ["scroll", "Scroll"]];
/** Edits settle into one save this long after the last keystroke. */
const SAVE_AFTER_MS = 700;

const newPanel = (): ComicPanel => ({ id: ulid(), description: "", characters: [], lettering: [] });
const newPage = (): ComicPage => ({ id: ulid(), layout: "grid-2x2", status: "draft", panels: [newPanel()] });

export function ComicPagesScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  if (!world || !production) return <Screen id="comic-pages"><EmptyState title="Opening production…" /></Screen>;
  return <ComicPages key={`${world.meta.worldId}/${production.meta.id}`} world={world} production={production} />;
}

function takeFile(world: WorldBundle, take: ComicPageTake | undefined): string | null {
  const artifact = take === undefined ? undefined : world.artifacts.find((candidate) => candidate.id === take.artifact);
  return artifact === undefined ? null : mediaUrl(world.meta.slug, `artifacts/${artifact.file}`);
}

export function ComicPages({ world, production }: { world: WorldBundle; production: ProductionBundle }) {
  const worldId = world.meta.worldId;
  const productionId = production.meta.id;
  const base = `/w/${worldId}/p/${productionId}`;
  const navigate = useNavigate();
  const connection = useStore().connection;
  const settings = production.comic ?? DEFAULT_COMIC_SETTINGS;
  const chapters = useMemo(() => production.chapters.filter((chapter) => !chapter.retired).sort((a, b) => a.order - b.order), [production.chapters]);
  const [chapterId, setChapterId] = useState<string | null>(chapters[0]?.id ?? null);
  const chapter = chapters.find((candidate) => candidate.id === chapterId) ?? chapters[0];
  const stored = production.comicScripts?.find((entry) => entry.chapter === chapter?.id);

  // The chapter's pages as the editor holds them, saved a moment after the last edit (R-10). A draft
  // is bound to its chapter and saved on that chapter's base, and it is sent at once when the author
  // switches chapter or leaves Pages, so an edit is never dropped or saved over another chapter
  // (codex on PR 2226). One save is in flight at a time; the next waits for its new base.
  // Held with the chapter they are, so a render between choosing a chapter and loading it never
  // shows, or edits, one chapter's pages as another's.
  const [loaded, setLoaded] = useState<{ chapter: string | undefined; pages: ComicPage[] }>({ chapter: chapter?.id, pages: stored?.script.pages ?? [] });
  const setPages = (next: ComicPage[]) => setLoaded({ chapter: chapter?.id, pages: next });
  const scripts = useRef(production.comicScripts);
  scripts.current = production.comicScripts;
  const bases = useRef(new Map<string, string | null>());
  // The hashes this editor's saves have written since the snapshots last caught up, by chapter.
  // Frames are answered concurrently, so the snapshot after one save can arrive after the next
  // save's answer; read as news it would put the base back a save and the next edit would be
  // refused as stale (the Ledger, 30 October 2026). Once a snapshot shows the newest of them, the
  // stream has caught up and every later snapshot is news, even one that repeats an older text
  // (codex on PR 2271).
  const written = useRef(new Map<string, string[]>());
  const mounted = useRef(true);
  // Drafts by chapter: switching chapters never shows or saves one chapter's pages as another's, and a
  // chapter's incomplete draft waits there until it is whole (codex on PR 2226).
  const drafts = useRef(new Map<string, ComicPage[]>());
  const pending = useRef<{ requestId: string; chapter: string; pages: ComicPage[] } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [unsaved, setUnsaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const baseFor = (id: string) => bases.current.has(id) ? bases.current.get(id)! : scripts.current?.find((entry) => entry.chapter === id)?.hash ?? null;
  const settle = () => setUnsaved(drafts.current.size > 0 || pending.current !== null);
  const send = () => {
    clearTimeout(timer.current);
    if (drafts.current.size === 0) return;
    if (pending.current !== null) { timer.current = setTimeout(send, 150); return; }
    // A new panel or line is empty until written: the coordinator would refuse the whole script, and
    // a refused message is never answered. It stays here, unsaved, until it is whole.
    const ready = [...drafts.current].find(([, next]) => ComicScriptSchema.safeParse({ version: 1, pages: next }).success);
    if (ready === undefined) return;
    const [id, next] = ready;
    drafts.current.delete(id);
    const requestId = saveComicScript(worldId, productionId, id, next, baseFor(id));
    if (requestId === null) { drafts.current.set(id, next); setProblem("not connected"); return; }
    pending.current = { requestId, chapter: id, pages: next };
    // A save never answered — a dropped socket — frees the queue rather than holding it for good.
    setTimeout(() => {
      if (pending.current?.requestId !== requestId) return;
      pending.current = null;
      if (!drafts.current.has(id)) drafts.current.set(id, next);
      setProblem("not saved");
      settle();
      // Tried again, rather than left waiting for the author's next keystroke; once Pages has
      // closed, nothing would hear the answer, so it waits for Pages to open again (codex on PR 2271).
      if (!mounted.current) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(send, SAVE_AFTER_MS);
    }, 15_000);
    if (drafts.current.size > 0) timer.current = setTimeout(send, 150);
  };
  useEffect(() => {
    // A chapter change, or another window's save: this chapter's own draft wins, then its save in
    // flight, then the stored script. Another chapter's save never keeps this one from loading.
    if (!chapter) return;
    const held = drafts.current.get(chapter.id) ?? (pending.current?.chapter === chapter.id ? pending.current.pages : undefined);
    if (held !== undefined) { setLoaded({ chapter: chapter.id, pages: held }); return; }
    // A snapshot of one of this editor's own earlier saves is behind what it already knows.
    const ours = written.current.get(chapter.id) ?? [];
    if (stored?.hash !== undefined && ours.includes(stored.hash) && ours.at(-1) !== stored.hash && loaded.chapter === chapter.id) return;
    if (stored?.hash !== undefined && ours.at(-1) === stored.hash) written.current.set(chapter.id, [stored.hash]);
    setLoaded({ chapter: chapter.id, pages: stored?.script.pages ?? [] });
    bases.current.set(chapter.id, stored?.hash ?? null);
  }, [stored?.hash, chapter?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => subscribeComicScriptSaveResults((result) => {
    if (result.requestId !== pending.current?.requestId) return;
    const sent = pending.current;
    pending.current = null;
    // The base is that chapter's own: a late answer never moves another chapter's base.
    if (result.disposition === "saved" && result.hash) {
      bases.current.set(sent.chapter, result.hash);
      written.current.set(sent.chapter, [...(written.current.get(sent.chapter) ?? []), result.hash].slice(-50));
      setProblem(null);
    }
    else {
      // Refused, so not saved: the pages wait again, unsaved, and the next try takes the chapter's
      // current base rather than the one that was refused (codex on PR 2226).
      if (!drafts.current.has(sent.chapter)) drafts.current.set(sent.chapter, sent.pages);
      bases.current.delete(sent.chapter);
      setProblem(result.reason ?? "not saved");
    }
    settle();
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const edit = (next: ComicPage[]) => {
    if (!chapter) return;
    drafts.current.set(chapter.id, next);
    setUnsaved(true);
    setPages(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(send, SAVE_AFTER_MS);
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; send(); }; }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The chapter's own pages: between choosing a chapter and loading it, its draft or stored script.
  const pages = loaded.chapter === chapter?.id ? loaded.pages : (chapter ? drafts.current.get(chapter.id) : undefined) ?? stored?.script.pages ?? [];
  const [pageId, setPageId] = useState<string | null>(pages[0]?.id ?? null);
  const page = pages.find((candidate) => candidate.id === pageId) ?? pages[0];
  const setPage = (change: (page: ComicPage) => ComicPage) => page && edit(pages.map((candidate) => (candidate.id === page.id ? change(structuredClone(candidate)) : candidate)));
  const book = useMemo(() => comicBook(production), [production]);
  const firstNumber = book.find((entry) => entry.chapter === chapter?.id)?.number ?? 1;
  const record = (id: string) => production.comicPages?.find((entry) => entry.page === id)?.record;

  // Arke drafts in the chat beside the page (turn 249c); its pages arrive here as a draft the author
  // keeps or discards whole (249d). While one waits, the chapter shows the draft, not its pages.
  const chat = useGlobalChat();
  const chatSurface = chat?.forPage() ?? null;
  const draftPath = chapter ? `productions/${productionId}/comic/${chapter.id}.json` : null;
  const drafted = draftPath === null ? undefined : world.proposals.find((staged) => staged.proposal.kind === "comic-script" && staged.comicScripts?.[draftPath] !== undefined);
  const draftPages = drafted && draftPath ? drafted.comicScripts![draftPath]!.pages : null;
  const [draftPageId, setDraftPageId] = useState<string | null>(null);
  const draftPage = draftPages?.find((candidate) => candidate.id === draftPageId) ?? draftPages?.[0];
  const [draftPanelId, setDraftPanelId] = useState<string | null>(null);
  const draftPanel = draftPage?.panels.find((candidate) => candidate.id === draftPanelId) ?? draftPage?.panels[0];
  // An adapted book's chapter is drawn from the story's chapter it maps to (turn 249c), not its own empty prose.
  const adaptedFrom = chapter ? settings.adapts?.chapters.find((entry) => entry.chapter === chapter.id) : undefined;
  const sourceStory = adaptedFrom ? world.productions.find((candidate) => candidate.meta.id === settings.adapts!.story) : undefined;
  const sourceChapter = adaptedFrom ? sourceStory?.chapters.find((candidate) => candidate.id === adaptedFrom.from) : undefined;
  const draftWithArke = () => {
    if (!chat || !chatSurface || !chapter) return;
    chat.setValue(chatSurface.key, "draft", sourceStory && sourceChapter
      ? `Turn chapter ${chapter.order}, ${chapter.title}, into pages from chapter ${sourceChapter.order} of ${sourceStory.meta.title}.`
      : `Turn chapter ${chapter.order}, ${chapter.title}, into pages.`);
    chat.open(chatSurface);
  };

  const [reading, setReading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [styling, setStyling] = useState(false);

  // The page stands at full height above its verdict, takes and actions, and the script takes the
  // rest of the width (design turn 251a). Pages sat in the 1,080 column every screen has, so the made
  // page was a 400-pixel thumbnail in a 2,700-pixel window and the script's lines were cut (issue 2260).
  const body = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const element = body.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => entry && setRoom({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, [draftPages === null]); // eslint-disable-line react-hooks/exhaustive-deps
  const shape = pageAspect(page ?? draftPage ?? newPage(), settings).split(":").map(Number) as [number, number];
  // Too narrow for the strip, the script's minimum and a readable page: the stylesheet's columns
  // stand, as before turn 251 (codex on PR 2264).
  const columns = room === null || room.width < 136 + SCRIPT_MIN + 320 ? undefined : `136px minmax(${SCRIPT_MIN}px, 1fr) ${sideWidth(room, shape)}px`;

  if (chapters.length === 0) {
    return <Screen id="comic-pages"><EmptyState title="No chapters yet" action={<Button onClick={() => navigate(`${base}/story/chapters`)}>Chapters</Button>} /></Screen>;
  }
  return (
    <div className="fy-comic-screen" data-screen="comic-pages">
      <div className="fy-comic">
        <div className="fy-comic__head">
          <h2>Pages</h2>
          <span className="fy-comic__tabs" role="tablist">
            {chapters.map((candidate) => (
              <button key={candidate.id} type="button" role="tab" aria-selected={candidate.id === chapter?.id} className={cx(candidate.id === chapter?.id && "on")}
                onClick={() => { send(); setChapterId(candidate.id); setPageId(null); }}>{candidate.order} · {candidate.title}</button>
            ))}
          </span>
          <span className="grow" />
          {/* Style (design turn 248b): the style's page and name, opening the same cards as Tell a story. */}
          <button type="button" className="fy-comic__sel as-button" aria-label={`Style: ${styleName(settings.style)}`} onClick={() => setStyling(true)}>
            <b>Style</b>
            {comicStylePreset(settings.style?.preset) && <img src={comicStylePicture(settings.style!.preset!)} alt="" />}
            {styleName(settings.style)}
          </button>
          <label className="fy-comic__sel"><b>Reading</b>
            <select aria-label="Reading" value={settings.reading} onChange={(event) => setComicSettings(worldId, productionId, { reading: event.target.value as ComicReading })}>
              {READING.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <Button onClick={() => setReading(true)}>Read</Button>
          {/* The book exports as saved: an edit still waiting would ship the words before it (codex on PR 2226). */}
          <Button disabled={unsaved} onClick={() => { send(); setExporting(true); }}>Export</Button>
        </div>
        {draftPages !== null && drafted !== undefined ? (
          <div className="fy-comic__body" ref={body} style={{ gridTemplateColumns: columns }}>
            <div className="fy-comic__strip">
              {draftPages.map((candidate, index) => (
                <button key={candidate.id} type="button" className={cx("fy-comic__thumb fy-comic__thumb--draft", candidate.id === draftPage?.id && "on")} aria-label={`Draft page ${firstNumber + index}`} onClick={() => setDraftPageId(candidate.id)}>
                  <span className="d">draft</span>
                  <span className="n">{firstNumber + index}</span>
                </button>
              ))}
            </div>
            <div className="fy-comic__edit">
              <div className="fy-comic__draftbar">
                <Sparkle size={15} />
                <b>Arke’s draft</b>
                <span>{draftPages.length} {draftPages.length === 1 ? "page" : "pages"} from chapter {chapter?.order}</span>
                <span className="grow" />
                <Button size="sm" onClick={() => discardProposal(worldId, drafted.proposal.id)}>Discard</Button>
                <Button size="sm" variant="primary" onClick={() => acceptProposal(worldId, drafted.proposal.id, undefined, drafted.proposal.draftRevision)}>Keep</Button>
              </div>
              {draftPage !== undefined && <DraftPage world={world} page={draftPage} number={firstNumber + draftPages.indexOf(draftPage)} selected={draftPanel?.id ?? null} pick={setDraftPanelId} />}
            </div>
            {draftPage === undefined ? <div className="fy-comic__side" /> : <DraftSide key={draftPage.id} world={world} page={draftPage} panel={draftPanel} settings={settings} />}
          </div>
        ) : (
        <div className="fy-comic__body" ref={body} style={{ gridTemplateColumns: columns }}>
          <div className="fy-comic__strip">
            {pages.map((candidate, index) => {
              const held = record(candidate.id);
              const accepted = held?.accepted[settings.language];
              const shown = held?.takes.find((take) => take.id === accepted) ?? held?.takes.at(-1);
              const url = takeFile(world, shown);
              const entry = book.find((item) => item.id === candidate.id);
              // Being made, or its newest take still being read: the strip says so too (turn 251b, 251c).
              const busy = (held?.making.length ?? 0) > 0 || beingRead(held?.takes.at(-1));
              return (
                <button key={candidate.id} type="button" className={cx("fy-comic__thumb", candidate.id === page?.id && "on", busy && "busy")} aria-label={`Page ${firstNumber + index}`} aria-busy={busy || undefined} onClick={() => setPageId(candidate.id)}>
                  {url !== null && <img src={url} alt="" />}
                  {busy && <Spin size={20} />}
                  {!busy && entry?.take !== undefined && <span className={cx("s", (!entry.cleared || entry.overridden || entry.outOfDate) && "w")}>{entry.cleared && !entry.overridden && !entry.outOfDate ? <Check size={10} /> : <TriangleAlert size={10} />}</span>}
                  <span className="n">{firstNumber + index}</span>
                </button>
              );
            })}
            <button type="button" className="fy-comic__add" onClick={() => { const next = newPage(); edit([...pages, next]); setPageId(next.id); }}>+ Page</button>
          </div>
          {page === undefined ? (
            // A chapter with no pages (turn 249c): Arke turns its prose into pages, or one is started by hand.
            <div className="fy-comic__empty">
              <h3>{chapter?.order} · {chapter?.title} has no pages</h3>
              {sourceStory && sourceChapter
                ? <span className="m">From {sourceStory.meta.title} · chapter {sourceChapter.order}{sourceChapter.words !== undefined ? ` · ${sourceChapter.words.toLocaleString("en-GB")} words` : ""}</span>
                : chapter?.words !== undefined && <span className="m">{chapter.words.toLocaleString("en-GB")} words</span>}
              <div className="fy-comic__emptyacts">
                {chatSurface && <Button variant="primary" onClick={draftWithArke}><Sparkle size={14} />Draft with Arke</Button>}
                <Button onClick={() => { const next = newPage(); edit([next]); setPageId(next.id); }}>+ Page</Button>
              </div>
            </div>
          ) : (
            <PageEditor world={world} page={page} number={firstNumber + pages.indexOf(page)} change={setPage}
              remove={() => { edit(pages.filter((candidate) => candidate.id !== page.id)); setPageId(null); }} />
          )}
          {page === undefined ? null : (
            <PageSide key={page.id} world={world} production={production} page={page} saving={unsaved} connected={connection === "open"}
              problem={problem} onReader={() => navigate(`/settings/harness?agent=${LETTERING_READER}`)} />
          )}
        </div>
        )}
      </div>
      {styling && <ComicStyleSheet world={world} production={production} made={book.filter((entry) => entry.take !== undefined).length} onClose={() => setStyling(false)} />}
      {reading && <ComicReader world={world} production={production} onClose={() => setReading(false)} />}
      {exporting && <ComicExport world={world} production={production} onClose={() => setExporting(false)}
        goTo={(id) => { const entry = book.find((item) => item.id === id); if (entry) { setChapterId(entry.chapter); setPageId(id); } setExporting(false); }} />}
    </div>
  );
}

/** The script column is never narrower than this; below it, the page gives way (turn 251a). */
const SCRIPT_MIN = 440;
/** The verdict, takes, actions and price line under the page, with the side's padding and gaps. */
const UNDER_PAGE = 272;

/**
 * The side column as wide as the page needs to stand at full height above what sits under it, at
 * the page's own shape, but never so wide the script falls under its minimum, nor narrower than a
 * page anyone could read.
 */
export function sideWidth(room: { width: number; height: number }, [across, down]: [number, number]): number {
  const tall = Math.round((room.height - UNDER_PAGE) * across / down) + 36;
  return Math.max(320, Math.min(tall, room.width - 136 - SCRIPT_MIN));
}

function LayoutTile({ id, on, pick }: { id: string; on: boolean; pick: () => void }) {
  const rects = LAYOUT_TEMPLATES.find((template) => template.id === id)?.panels ?? [];
  return (
    <button type="button" className={cx("fy-comic__lay", on && "on")} aria-pressed={on} onClick={pick}>
      <i>{rects.map((rect, index) => <u key={index} style={{ left: 2 + rect.x * 32, top: 2 + rect.y * 50, width: rect.w * 32 - 2, height: rect.h * 50 - 2 }} />)}</i>
      {LAYOUT_LABEL[id] ?? id}
    </button>
  );
}

function PageEditor({ world, page, number, change, remove }: { world: WorldBundle; page: ComicPage; number: number; change: (edit: (page: ComicPage) => ComicPage) => void; remove: () => void }) {
  const characters = world.sheets.filter((sheet) => sheet.type === "character");
  const places = world.sheets.filter((sheet) => sheet.type === "location");
  const name = (id: string) => world.sheets.find((sheet) => sheet.id === id)?.name ?? id;
  const panel = (index: number, edit: (panel: ComicPanel) => void) => change((current) => { edit(current.panels[index]!); return current; });
  return (
    <div className="fy-comic__edit">
      <h3>Page {number}<span className="grow" /><button type="button" className="fy-comic__link" onClick={remove}>Remove page</button></h3>
      <div className="fy-comic__layouts">
        {["grid-2x2", "feature", "strip-3", "splash", "manga", "webtoon"].map((id) => <LayoutTile key={id} id={id} on={page.layout === id} pick={() => change((current) => ({ ...current, layout: id }))} />)}
      </div>
      {page.panels.map((current, index) => (
        <div key={current.id} className="fy-comic__panel">
          <div className="fy-comic__ph"><b>Panel {index + 1}</b><span className="grow" /><span className="m">{current.lettering.length} {current.lettering.length === 1 ? "line" : "lines"}</span>
            <button type="button" className="fy-comic__link" aria-label={`Remove panel ${index + 1}`} onClick={() => change((p) => ({ ...p, panels: p.panels.filter((_, i) => i !== index) }))}><X size={13} /></button>
          </div>
          <textarea className="fy-comic__desc" aria-label={`Panel ${index + 1}`} value={current.description} rows={2}
            onChange={(event) => panel(index, (p) => { p.description = event.target.value; })} />
          <div className="fy-comic__row"><b>Shows</b>
            {current.characters.map((id) => <span key={id} className="fy-comic__chip">{name(id)}<button type="button" aria-label={`Remove ${name(id)}`} onClick={() => panel(index, (p) => { p.characters = p.characters.filter((c) => c !== id); })}><X size={11} /></button></span>)}
            {current.location !== undefined && <span className="fy-comic__chip">{name(current.location)}<button type="button" aria-label={`Remove ${name(current.location)}`} onClick={() => panel(index, (p) => { delete p.location; })}><X size={11} /></button></span>}
            <select aria-label="Add who or where" value="" onChange={(event) => {
              const id = event.target.value;
              panel(index, (p) => { if (places.some((place) => place.id === id)) p.location = id; else if (!p.characters.includes(id)) p.characters = [...p.characters, id]; });
            }}>
              <option value="">+</option>
              <optgroup label="Who">{characters.filter((c) => !current.characters.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
              <optgroup label="Where">{places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>
            </select>
          </div>
          {current.lettering.map((item, l) => (
            <LetteringRow key={item.id} item={item} characters={characters} change={(edit) => panel(index, (p) => { edit(p.lettering[l]!); })}
              remove={() => panel(index, (p) => { p.lettering = p.lettering.filter((_, i) => i !== l); })} />
          ))}
          <div className="fy-comic__more"><button type="button" className="fy-comic__link" onClick={() => panel(index, (p) => { p.lettering = [...p.lettering, { id: ulid(), kind: "caption", text: "" }]; })}>+ Line</button></div>
        </div>
      ))}
      <Button size="sm" onClick={() => change((p) => ({ ...p, panels: [...p.panels, newPanel()] }))}><Plus size={13} />Panel</Button>
    </div>
  );
}

function LetteringRow({ item, characters, change, remove }: { item: LetteringItem; characters: WorldBundle["sheets"]; change: (edit: (item: LetteringItem) => void) => void; remove: () => void }) {
  return (
    <div className="fy-comic__row">
      <select className="kind" aria-label="Kind" value={item.kind} onChange={(event) => change((current) => {
        current.kind = event.target.value as LetteringKind;
        if (!SPOKEN.has(current.kind)) delete current.speaker;
      })}>{KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      {SPOKEN.has(item.kind) ? (
        <select className="who" aria-label="Speaker" value={item.speaker ?? ""} onChange={(event) => change((current) => { if (event.target.value) current.speaker = event.target.value; else delete current.speaker; })}>
          <option value="">—</option>
          {characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      ) : <span className="who m">—</span>}
      <input className="words" aria-label="Words" value={item.text} onChange={(event) => change((current) => { current.text = event.target.value; })} />
      <button type="button" className="fy-comic__link" aria-label="Remove line" onClick={remove}><X size={13} /></button>
    </div>
  );
}

/** The agent that reads a page's lettering back, as Settings › Harness names it. */
const LETTERING_READER = "page-lettering-reader";
/** A take with no verdict this long after it landed was never read: the app stopped mid-check. */
const READ_WINDOW_MS = 10 * 60_000;

/** A take whose lettering is being read now: landed, no verdict yet, and recently. */
function beingRead(take: ComicPageTake | undefined): boolean {
  return take !== undefined && take.verification === undefined && Date.now() - Date.parse(take.at) < READ_WINDOW_MS;
}

// Pages that went to choose a reader, by page id, with the reader's model when they left: back on the
// page with another model chosen, the take they could not check is read again (turn 251d).
const choosingReader = new Map<string, { take: string; model: string | undefined }>();

function PageSide({ world, production, page, saving, connected, problem, onReader }: {
  world: WorldBundle; production: ProductionBundle; page: ComicPage; saving: boolean; connected: boolean; problem: string | null; onReader: () => void;
}) {
  const worldId = world.meta.worldId;
  const productionId = production.meta.id;
  const settings = production.comic ?? DEFAULT_COMIC_SETTINGS;
  const record = production.comicPages?.find((entry) => entry.page === page.id)?.record;
  const takes = record?.takes ?? [];
  const accepted = record?.accepted[settings.language];
  const [shownId, setShownId] = useState<string | null>(null);
  const shown = takes.find((take) => take.id === shownId) ?? takes.find((take) => take.id === accepted) ?? takes.at(-1);
  // A quote is for the words it was asked about: one asked before an edit prices the old page.
  const [quoted, setQuoted] = useState<{ hash: string; quote: ComicPageQuote["quote"] } | null>(null);
  const [until, setUntil] = useState(true);
  const [brief, setBrief] = useState(false);
  // Pressed and not yet answered: the record says making a moment later, or the press failed.
  const [pressed, setPressed] = useState(false);
  // Which try of this window's own press, once the coordinator has said; a page opened mid-run
  // counts its takes instead (a reopened page read "Take 1 of up to 3" on its second try).
  const [attempt, setAttempt] = useState<number | null>(null);
  // A take picked by hand while another was being made stays shown when that one lands (turn 251c).
  const picked = useRef(false);
  // Check again on a take: reading until that take's verdict is no longer the one it had.
  const [rechecking, setRechecking] = useState<{ take: string; since: string | undefined } | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const asked = useRef<{ requestId: string; hash: string } | null>(null);
  const hash = comicPageHash(page, settings, "baked");
  const quote = quoted !== null && quoted.hash === hash && !saving ? quoted.quote : null;
  const readerModel = useStore().state?.app.agents.find((agent) => agent.name === LETTERING_READER)?.model;

  useEffect(() => subscribeComicPages((event) => {
    if (event.type === "comic.page-quote" && event.requestId === asked.current?.requestId) setQuoted({ hash: asked.current.hash, quote: event.quote });
    if (event.type === "comic.page-made" && event.page === page.id) {
      setPressed(false);
      // The run's last word ends this window's count: a picture still out after its wait is the record's.
      if (event.state === "made" || event.state === "failed") setAttempt(null);
      else if (event.attempt !== undefined) setAttempt(event.attempt);
      // The landed take is the one shown, unless the author picked another meanwhile.
      if ((event.state === "checking" || event.state === "made") && event.take !== undefined && !picked.current) setShownId(event.take);
      setSaid(event.state === "failed" ? event.reason ?? "not made" : null);
    }
    if (event.type === "comic.take-result" && event.page === page.id) {
      if (event.disposition !== "accepted") setRechecking(null);
      setSaid(event.disposition === "refused" ? event.reason ?? "refused" : null);
    }
  }), [page.id]);
  // A picture that outlasts the press's wait is filed by the next quote (R-25): while the record still
  // says making and no press of this window is running, ask again each minute, or a page whose picture
  // landed late said Making until someone happened to reopen it (61 minutes, 2026-10-30).
  const [asking, setAsking] = useState(0);
  const stale = (record?.making.length ?? 0) > 0 && attempt === null && !pressed;
  useEffect(() => {
    if (!stale) return;
    const tick = setInterval(() => setAsking((n) => n + 1), 60_000);
    return () => clearInterval(tick);
  }, [stale]);
  // The price follows the page's words: asked again once an edit has saved (R-23, R-27).
  useEffect(() => {
    if (!connected || saving) return;
    const requestId = quoteComicPage(worldId, productionId, page.id);
    asked.current = requestId === null ? null : { requestId, hash };
  }, [connected, saving, worldId, productionId, page.id, hash, asking]);
  // Checking only once the ask has gone: an unsent one would spin with nothing behind it (codex on PR 2264).
  const recheck = (take: ComicPageTake) => {
    if (checkComicTake(worldId, productionId, page.id, take.id) !== null) setRechecking({ take: take.id, since: take.verification?.at });
  };
  // Back from choosing a reader with another one chosen: read the take again.
  useEffect(() => {
    const left = choosingReader.get(page.id);
    if (left === undefined || !connected || left.model === readerModel) return;
    choosingReader.delete(page.id);
    const take = takes.find((candidate) => candidate.id === left.take);
    if (take === undefined) return;
    recheck(take);
  }, [connected, readerModel, page.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const rects = panelRects(page, pageReading(page, settings));
  const url = takeFile(world, shown);
  const verification = shown?.verification;
  const blocking = verification?.status === "compared" ? verification.findings.filter((finding) => BLOCKING_FINDINGS.has(finding.kind)) : [];
  const passed = takePasses(verification);
  const outOfDate = shown !== undefined && shown.hash !== comicPageHash(page, settings, shown.mode);
  const lines = page.panels.reduce((count, panel) => count + panel.lettering.length, 0);
  const cap = settings.cap.attempts;
  const total = quote?.ok ? quote.microUsd * (until ? cap : 1) : 0;
  // Making is the page record's word, so a window that reconnected still knows (codex on PR 2226);
  // the coordinator now publishes it the moment it is written (issue 2259).
  const making = record?.making ?? [];
  const busy = making.length > 0 || pressed;
  const checking = shown !== undefined && (beingRead(shown) || (rechecking?.take === shown.id && shown.verification?.at === rechecking.since));
  const make = () => {
    if (!quote?.ok) return;
    setSaid(null);
    setPressed(true);
    setAttempt(1);
    picked.current = false;
    // The book's dollar cap bounds the retries only; one attempt confirms its own price (codex on PR 2226).
    makeComicPage(worldId, productionId, page.id, until ? Math.max(quote.microUsd, Math.min(total, Math.round(settings.cap.usd * 1_000_000))) : quote.microUsd, undefined, until);
  };
  const press = busy ? "Making" : takes.length ? "Make again" : "Make page";
  // An accepted take a re-check failed is kept only by covering what it found now.
  const covered = shown?.override !== undefined && blocking.every((finding) => shown.override!.findings.includes(finding.id));
  const reason = notChecked(verification);
  const chooseReader = () => {
    if (shown === undefined) return;
    choosingReader.set(page.id, { take: shown.id, model: readerModel });
    onReader();
  };

  return (
    <div className="fy-comic__side">
      <div className="fy-comic__page" style={{ aspectRatio: pageAspect(page, settings).replace(":", " / ") }}>
        {url !== null ? <img src={url} alt={`Page take ${takes.indexOf(shown!) + 1}`} /> : rects.map((rect, index) => (
          <div key={index} className="fy-comic__wire" style={{ left: `calc(${rect.x * 100}% + 6px)`, top: `calc(${rect.y * 100}% + 6px)`, width: `calc(${rect.w * 100}% - 12px)`, height: `calc(${rect.h * 100}% - 12px)` }}>{index + 1}</div>
        ))}
        {url !== null && !checking && verification?.status === "compared" && verification.findings.filter((finding) => finding.box).map((finding) => (
          <div key={finding.id} className={cx("fy-comic__hit", !BLOCKING_FINDINGS.has(finding.kind) && "w")}
            style={{ left: `${finding.box!.x * 100}%`, top: `${finding.box!.y * 100}%`, width: `${finding.box!.w * 100}%`, height: `${finding.box!.h * 100}%` }}>
            <span>{FINDING[finding.kind]}</span>
          </div>
        ))}
        {/* Making (turn 251b): the take and the time so far, on the page itself. */}
        {busy && (
          <div className="fy-comic__over" role="status">
            <Spin size={22} />
            <b>Making</b>
            <span className="m">{attempt === null ? `Take ${takes.length + 1}` : until ? `Take ${attempt} of up to ${cap}` : "One take"}{making[0] !== undefined && <Since at={making[0].at} />}</span>
          </div>
        )}
        {!busy && checking && <div className="fy-comic__band" role="status"><Spin size={14} />Checking lettering</div>}
      </div>
      {shown !== undefined && (outOfDate ? (
        <div className="fy-comic__verdict warn"><TriangleAlert size={15} /><b>Out of date</b><span className="grow" /><span className="m">the script changed</span></div>
      ) : checking ? (
        <div className="fy-comic__verdict"><Spin size={15} /><b>Checking lettering</b></div>
      ) : verification?.status === "compared" ? (
        <div className={cx("fy-comic__verdict", passed ? "ok" : "bad")}>
          {passed ? <Check size={15} /> : <CircleAlert size={15} />}
          <b>{passed ? "Lettering" : `${blocking.length} to fix`}</b>
          {passed && <span>{lines} of {lines}</span>}
          <span className="grow" />
          <span className="m">{passed ? "" : `${lines - new Set(blocking.map((finding) => finding.item)).size} of ${lines} lines · `}read by {verification.reader.version.split(":")[1] ?? verification.reader.id}</span>
        </div>
      ) : (
        <div className="fy-comic__verdict warn"><TriangleAlert size={15} /><b>Not checked</b><span>{reason.text}</span></div>
      ))}
      {takes.length > 0 && (
        <div className="fy-comic__takes">
          {takes.map((take, index) => (
            <button key={take.id} type="button" className={cx("fy-comic__take", take.id === shown?.id && "on")} aria-label={`Take ${index + 1}`} onClick={() => { picked.current = busy; setShownId(take.id); }}>
              {takeFile(world, take) !== null && <img src={takeFile(world, take)!} alt="" />}
              <span className={cx("k", takePasses(take.verification) && "ok")} />
            </button>
          ))}
          <span className="m">{shown?.id === accepted ? "Accepted · " : ""}Take {takes.indexOf(shown!) + 1} of {takes.length}</span>
        </div>
      )}
      <div className="fy-comic__acts">
        {shown !== undefined && !checking && !outOfDate && !passed && reason.reader && <Button variant="primary" onClick={chooseReader}>Choose reader</Button>}
        {shown !== undefined && !checking && shown.id !== accepted && !outOfDate && passed && <Button variant="primary" onClick={() => acceptComicTake(worldId, productionId, page.id, shown.id)}>Accept</Button>}
        <Button variant={shown !== undefined && !checking && !outOfDate && ((passed && shown.id !== accepted) || (!passed && reason.reader)) ? "secondary" : "primary"} disabled={!quote?.ok || busy || !connected} onClick={make}
          title={quote && !quote.ok ? quote.reason : undefined}>{busy ? <Spin size={13} /> : <Sparkle size={13} />}{press}</Button>
        {shown !== undefined && !checking && !outOfDate && !passed && (shown.id !== accepted || !covered) && (
          <Button title="Keeps this take with what was found on the record" onClick={() => acceptComicTake(worldId, productionId, page.id, shown.id, { findings: blocking.map((finding) => finding.id) })}>Accept anyway</Button>
        )}
        <span className="grow" />
        {shown !== undefined && !checking && !outOfDate && !reason.reader && (
          <Button variant="ghost" size="sm" disabled={!connected} onClick={() => recheck(shown)}>Check again</Button>
        )}
      </div>
      <div className="fy-comic__make">
        <label className="fy-comic__check"><input type="checkbox" checked={until} onChange={(event) => setUntil(event.target.checked)} />Until it passes</label>
        <span className="grow" />
        <Button variant="ghost" size="sm" aria-expanded={brief} onClick={() => setBrief(!brief)}>Brief</Button>
        <span className="m">{quote === null ? "…" : !quote.ok ? quote.reason : `${quote.modelName} · ${quote.aspect}${quote.riding.length ? ` · ${quote.riding.join(", ")} ride` : ""}${quote.missing.length ? ` · no picture: ${quote.missing.join(", ")}` : ""} · ${priceLabel(quote.microUsd)}${until ? ` · up to ${cap} · ${priceLabel(total)}` : ""}`}</span>
      </div>
      {brief && quote?.ok && <pre className="fy-comic__brief">{quote.brief}</pre>}
      {(said ?? problem) !== null && <div className="fy-comic__verdict bad"><CircleAlert size={15} /><span>{said ?? problem}</span></div>}
      {/* The findings follow the actions, so Accept never falls below the window (turn 251a). */}
      {!checking && verification?.status === "compared" && verification.findings.length > 0 && !outOfDate && (
        <div className="fy-comic__finds">
          {verification.findings.map((finding) => (
            <div key={finding.id} className="fy-comic__find">
              <span className={cx("k", !BLOCKING_FINDINGS.has(finding.kind) && "w")}>{FINDING[finding.kind]}</span>
              {finding.expected !== undefined && <span>{finding.expected}</span>}
              {finding.found !== undefined && (finding.expected !== undefined ? <s>{finding.found}</s> : <span>{finding.found}</span>)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A turning wheel for Making and Checking; the icons take no class of their own. */
function Spin({ size }: { size: number }) {
  return <span className="fy-comic__spin" aria-hidden><LoaderCircle size={size} /></span>;
}

/** How long since `at`, as m:ss, ticking. */
function Since({ at }: { at: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const tick = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(tick); }, []);
  const seconds = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  return <> · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</>;
}

/**
 * Why a take is not checked, in one clause, and whether choosing a reader fixes it (turn 251d). The
 * record keeps the reader's own words beside its reason; "the read failed" was all a person saw when
 * the reader's model could not see pictures, and nothing said where to change it.
 */
export function notChecked(verification: ComicPageTake["verification"]): { text: string; reader: boolean } {
  if (verification?.status !== "unavailable") return { text: "not yet", reader: false };
  if (verification.reason === "no-reader") return { text: "no image reader", reader: true };
  if (verification.reason === "reader-failed") {
    const detail = verification.detail ?? "";
    if (/cannot inspect images|cannot read images|no images were sent/i.test(detail)) return { text: "the reader can’t see pictures", reader: true };
    if (/timed out/i.test(detail)) return { text: "the reader timed out", reader: false };
    if (/cloud image inspection is disabled/i.test(detail)) return { text: "cloud reading is off", reader: true };
    return { text: "the read failed", reader: false };
  }
  return { text: { unreadable: "picture unreadable", language: "language not read", "no-lettering": "no lettering" }[verification.reason], reader: false };
}

export function ComicReader({ world, production, onClose }: { world: WorldBundle; production: ProductionBundle; onClose: () => void }) {
  const settings = production.comic ?? DEFAULT_COMIC_SETTINGS;
  const book = comicBook(production);
  const [mode, setMode] = useState<ComicReading>(settings.reading);
  const [at, setAt] = useState(0);
  const entry = book[at];
  const url = (index: number) => takeFile(world, book[index]?.take);
  // Right to left turns the other way: the arrow on the left goes forward.
  const back = () => setAt(Math.max(0, at - 1));
  const on = () => setAt(Math.min(book.length - 1, at + 1));
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight") (mode === "rtl" ? back : on)();
      if (event.key === "ArrowLeft") (mode === "rtl" ? on : back)();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  return (
    <div className="fy-comic-read" role="dialog" aria-label="Read">
      <div className="fy-comic-read__bar">
        <b>{production.meta.title}</b>
        {mode !== "scroll" && book.length > 0 && <span className="m">Page {at + 1} of {book.length}</span>}
        <span className="grow" />
        <span className="fy-comic__tabs">{READING.map(([value, label]) => <button key={value} type="button" className={cx(mode === value && "on")} onClick={() => setMode(value)}>{label}</button>)}</span>
        <button type="button" className="fy-comic-read__close" onClick={onClose}>Close</button>
      </div>
      {mode === "scroll" ? (
        <div className="fy-comic-read__scroll">
          {book.map((item, index) => url(index) !== null ? <img key={item.id} src={url(index)!} alt={item.page.alt ?? `Page ${item.number}`} /> : <div key={item.id} className="fy-comic-read__missing">Page {item.number}</div>)}
        </div>
      ) : (
        <>
          <div className="fy-comic-read__stage">
            <button type="button" className="fy-comic-read__arrow" aria-label={mode === "rtl" ? "Next page" : "Previous page"} onClick={mode === "rtl" ? on : back}><ChevronLeft size={16} /></button>
            {entry === undefined ? <div className="fy-comic-read__missing">No pages</div> : url(at) !== null ? <img src={url(at)!} alt={entry.page.alt ?? `Page ${entry.number}`} /> : <div className="fy-comic-read__missing">Page {entry.number}</div>}
            <button type="button" className="fy-comic-read__arrow" aria-label={mode === "rtl" ? "Previous page" : "Next page"} onClick={mode === "rtl" ? back : on}><ChevronRight size={16} /></button>
          </div>
          <div className="fy-comic-read__scrub"><i style={{ width: `${book.length ? ((at + 1) / book.length) * 100 : 0}%`, ...(mode === "rtl" ? { left: "auto", right: 0 } : {}) }} /></div>
        </>
      )}
    </div>
  );
}

const KIND_LABEL: Record<LetteringKind, string> = { speech: "Speech", thought: "Thought", shout: "Shout", whisper: "Whisper", caption: "Caption", sfx: "Sound" };

/**
 * A page of Arke's draft (turn 249d), read only: nothing in a draft is edited or made until it is
 * kept. Each panel names the passage it was drawn from.
 */
function DraftPage({ world, page, number, selected, pick }: { world: WorldBundle; page: ComicPage; number: number; selected: string | null; pick: (panel: string) => void }) {
  const name = (id: string) => world.sheets.find((sheet) => sheet.id === id)?.name ?? id;
  return (
    <>
      <h3>Page {number} <span className="m">{LAYOUT_LABEL[page.layout] ?? page.layout}</span></h3>
      {page.panels.map((panel, index) => (
        <div key={panel.id} className={cx("fy-comic__panel fy-comic__panel--draft", panel.id === selected && "on")} role="button" tabIndex={0} aria-pressed={panel.id === selected}
          onClick={() => pick(panel.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") pick(panel.id); }}>
          <div className="fy-comic__ph"><b>Panel {index + 1}</b><span className="grow" />{panel.source && <span className="fy-comic__src">{paragraphLabel(panel.source.paragraphs)}</span>}</div>
          <div className="fy-comic__desc">{panel.description}</div>
          {(panel.characters.length > 0 || panel.location) && (
            <div className="fy-comic__row"><b>Shows</b>{[...panel.characters, ...(panel.location ? [panel.location] : [])].map((id) => <span key={id} className="fy-comic__chip">{name(id)}</span>)}</div>
          )}
          {panel.lettering.map((item) => (
            <div key={item.id} className="fy-comic__row"><span className="kind">{KIND_LABEL[item.kind]}</span><span className="who">{item.speaker ? name(item.speaker) : "—"}</span><span className="words">{item.text}</span></div>
          ))}
        </div>
      ))}
    </>
  );
}

/** The draft page's layout and the passage its selected panel came from; Make waits for Keep. */
function DraftSide({ world, page, panel, settings }: { world: WorldBundle; page: ComicPage; panel: ComicPanel | undefined; settings: ComicSettings }) {
  const rects = panelRects(page, pageReading(page, settings));
  const passage = usePassage(world, panel?.source);
  const index = panel ? page.panels.indexOf(panel) : -1;
  const story = panel?.source ? world.productions.find((candidate) => candidate.meta.id === panel.source!.story) : undefined;
  const chapter = panel?.source ? story?.chapters.find((candidate) => candidate.id === panel.source!.chapter) : undefined;
  return (
    <div className="fy-comic__side">
      <div className="fy-comic__page" style={{ aspectRatio: pageAspect(page, settings).replace(":", " / ") }}>
        {rects.map((rect, i) => (
          <div key={i} className={cx("fy-comic__wire", i === index && "on")} style={{ left: `calc(${rect.x * 100}% + 6px)`, top: `calc(${rect.y * 100}% + 6px)`, width: `calc(${rect.w * 100}% - 12px)`, height: `calc(${rect.h * 100}% - 12px)` }}>{i + 1}</div>
        ))}
      </div>
      {panel?.source && (
        <>
          {passage === null ? <span className="m">Reading…</span> : "failure" in passage ? <span className="m" role="alert">{passage.failure}</span> : <blockquote className="fy-comic__quote">{passage.text}</blockquote>}
          <span className="m">Panel {index + 1} · {chapter ? `chapter ${chapter.order}` : panel.source.chapter}, {paragraphLabel(panel.source.paragraphs)}</span>
        </>
      )}
      <div className="fy-comic__make"><Button variant="primary" disabled><Sparkle size={14} />Make page</Button><span className="m">Keep the draft first</span></div>
    </div>
  );
}

/** The cited paragraphs of a pinned chapter version, read as the episode script reads its source. */
function usePassage(world: WorldBundle, source: ComicSource | undefined): { text: string } | { failure: string } | null {
  const story = source ? world.productions.find((candidate) => candidate.meta.id === source.story) : undefined;
  const chapter = source ? story?.chapters.find((candidate) => candidate.id === source.chapter) : undefined;
  const key = source && story && chapter ? `${story.meta.id}:${chapter.id}:${source.version}:${source.paragraphs.join(",")}` : null;
  const [held, setHeld] = useState<{ key: string; value: { text: string } | { failure: string } } | null>(null);
  useEffect(() => {
    if (key === null || !source || !story || !chapter) return;
    let live = true;
    const done = (body: string) => {
      const paragraphs = chapterParagraphs(body);
      if (live) setHeld({ key, value: { text: source.paragraphs.map((n) => paragraphs[n - 1]).filter((paragraph): paragraph is string => paragraph !== undefined).join(" ") } });
    };
    const fail = (failure: string) => { if (live) setHeld({ key, value: { failure } }); };
    readChapterVersion(world.meta.worldId, story.meta.id, chapter.file, source.version).then(done, (error: Error) => {
      // A chapter that never went through a kept save has no snapshot of its current version.
      if ((chapter.version ?? 1) !== source.version) { fail(error.message); return; }
      const requestId = openChapter(world.meta.worldId, story.meta.id, chapter.id);
      if (!requestId) { fail("Not connected."); return; }
      const stop = subscribeChapterOpenResults((result) => {
        if (result.requestId !== requestId) return;
        stop();
        if (result.disposition === "opened") done(result.body ?? ""); else fail("The chapter could not be read.");
      });
    });
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (key === null) return { failure: "That chapter is not in this world." };
  return held && held.key === key ? held.value : null;
}

/** What the head says the style is: World look, a preset's name, or Your own. */
function styleName(style: ComicStyle | undefined): string {
  if (!style) return "World look";
  return comicStylePreset(style.preset)?.name ?? "Your own";
}

/**
 * Style (design turn 248b, SPEC-064 R-21a): the book's style changed for the pages made from now.
 * Pages already made keep theirs — a style is not part of a page's picture hash, so nothing is
 * marked out of date by it.
 */
function ComicStyleSheet({ world, production, made, onClose }: { world: WorldBundle; production: ProductionBundle; made: number; onClose: () => void }) {
  const settings = production.comic ?? DEFAULT_COMIC_SETTINGS;
  const [draft, setDraft] = useState<ComicStyleDraft>(() => draftFromStyle(settings.style));
  const pages = comicBook(production).length;
  const use = () => {
    setComicSettings(world.meta.worldId, production.meta.id, { style: styleFromDraft(draft) });
    onClose();
  };
  return (
    <EditorDialog open onClose={onClose} width={860} title={`Style · ${production.meta.title}`}>
      {/* Scrolls inside the dialog: on a short or narrow window the cards run to four rows, and the
          dialog clips rather than scrolls, which hid Use style (codex on PR 2237). */}
      <div className="fy-comic-sheet fy-comic-style-sheet">
        <div className="sub">Graphic novel · {pages} {pages === 1 ? "page" : "pages"} · {made} made</div>
        <ComicStylePicker draft={draft} onChange={setDraft} worldPicture={world.keyArt ? mediaUrl(world.meta.slug, world.keyArt) : null} />
        <div className="fy-comic-foot">
          <span className="m">Pages made from now</span>
          <span className="grow" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={use}>Use style</Button>
        </div>
      </div>
    </EditorDialog>
  );
}

function ComicExport({ world, production, onClose, goTo }: { world: WorldBundle; production: ProductionBundle; onClose: () => void; goTo: (page: string) => void }) {
  const worldId = world.meta.worldId;
  const settings = production.comic ?? DEFAULT_COMIC_SETTINGS;
  const book = comicBook(production);
  const [formats, setFormats] = useState<Array<"cbz" | "pdf" | "epub">>(["cbz", "pdf"]);
  const [player, setPlayer] = useState(false);
  const [asked, setAsked] = useState<string | null>(null);
  const [packing, setPacking] = useState<string | null>(null);
  const [done, setDone] = useState<string[] | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => subscribeComicExported((event) => {
    if (event.requestId !== asked) return;
    setAsked(null);
    if (event.result.ok) setDone((made) => [...(made ?? []), ...(event.result.ok ? event.result.files.map((file) => file.file) : [])]);
    else setRefused(event.result.reason);
  }), [asked]);
  // Arke Player (Player P20): the book as a package of its own, made by Export → Arke Player's press.
  useEffect(() => subscribeArkePlayerExported((answer) => {
    if (answer.exportId !== packing) return;
    setPacking(null);
    if (answer.result.ok) { const file = answer.result.file; setDone((made) => [...(made ?? []), file]); }
    else setRefused(answer.result.blockers[0] ?? "not made");
  }), [packing]);
  const busy = asked !== null || packing !== null;
  const accepted = book.filter((entry) => entry.take !== undefined && !entry.outOfDate).length;
  const checked = book.filter((entry) => entry.cleared && !entry.overridden).length;
  const anyway = book.filter((entry) => entry.overridden).length;
  const blockers = book.filter((entry) => entry.take === undefined || entry.outOfDate || !entry.cleared);
  const toggle = (format: "cbz" | "pdf" | "epub") => setFormats(formats.includes(format) ? formats.filter((f) => f !== format) : [...formats, format]);
  const chapters = production.chapters.filter((chapter) => !chapter.retired).length;
  return (
    <EditorDialog open onClose={onClose} width={760} title={`Export · ${production.meta.title}`}>
      <div className="fy-comic-sheet">
        <div className="sub">Graphic novel · {chapters} {chapters === 1 ? "chapter" : "chapters"} · {book.length} {book.length === 1 ? "page" : "pages"} · {settings.aspect}</div>
        <div className="fy-comic-kinds">
          {([["cbz", "CBZ", "comic readers"], ["pdf", "PDF", "print · share"], ["epub", "EPUB", "fixed layout"]] as const).map(([id, label, sub]) => (
            <button key={id} type="button" aria-pressed={formats.includes(id)} className={cx("fy-comic-kind", formats.includes(id) && "on")} onClick={() => toggle(id)}>
              <input type="checkbox" readOnly checked={formats.includes(id)} tabIndex={-1} aria-hidden="true" /><div><b>{label}</b><span>{sub}</span></div>
            </button>
          ))}
          <button type="button" aria-pressed={player} className={cx("fy-comic-kind", player && "on")} onClick={() => setPlayer(!player)}>
            <input type="checkbox" readOnly checked={player} tabIndex={-1} aria-hidden="true" /><div><b>Arke Player</b><span>phone · offline</span></div>
          </button>
        </div>
        <div className="fy-comic-opts">
          <div className="fy-comic-opt"><b>Pages</b><span>{accepted} of {book.length} accepted</span><span className="grow" />{blockers.length > 0 && <i>{blockers.length} to clear</i>}</div>
          <div className="fy-comic-opt"><b>Lettering</b><span>{checked} checked</span><span className="grow" />{anyway > 0 && <i>{anyway} accepted anyway</i>}</div>
          <div className="fy-comic-opt"><b>Reading</b><span>{READING.find(([value]) => value === settings.reading)?.[1]}</span></div>
          <div className="fy-comic-opt"><b>Edition</b><span>{new Date().toISOString().slice(0, 10)}</span></div>
        </div>
        {blockers.slice(0, 5).map((entry) => (
          <div key={entry.id} className="fy-comic-block"><TriangleAlert size={15} />
            <span className="c">Page {entry.number} · {entry.take === undefined ? "no accepted take" : entry.outOfDate ? "out of date" : "lettering not cleared"}</span>
            <Button size="sm" onClick={() => goTo(entry.id)}>Go to</Button>
          </div>
        ))}
        {done !== null && done.map((file) => <div key={file} className="fy-comic-opt"><Check size={14} /><span className="m">{file}</span></div>)}
        {refused !== null && <div className="fy-comic-block"><CircleAlert size={15} /><span className="c">{refused}</span></div>}
        <div className="fy-comic-foot">
          <span className="grow" />
          <Button onClick={onClose}>{done !== null ? "Done" : "Cancel"}</Button>
          <Button variant="primary" disabled={blockers.length > 0 || (formats.length === 0 && !player) || busy}
            onClick={() => {
              setRefused(null); setDone(null);
              if (formats.length > 0) setAsked(exportComic(worldId, production.meta.id, formats));
              if (player) {
                const id = `ap_${ulid()}`;
                if (exportArkePlayer(worldId, production.meta.id, id, { book: false, motion: false }) !== null) setPacking(id);
              }
            }}>{busy ? "Exporting…" : "Export"}</Button>
        </div>
      </div>
    </EditorDialog>
  );
}

