import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  BLOCKING_FINDINGS,
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
  type LetteringFinding,
  type LetteringItem,
  type LetteringKind,
  type ProductionBundle,
  type WorldBundle,
} from "@arke-studio/contracts";
import { EditorDialog } from "../components/editor-dialog.js";
import { Check, ChevronLeft, ChevronRight, CircleAlert, Plus, Sparkle, TriangleAlert, X } from "../components/icons.js";
import { EmptyState, Screen } from "../components/layout.js";
import { Button, cx } from "../components/ui.js";
import { mediaUrl } from "../lib/media.js";
import { useProduction } from "../lib/selectors.js";
import {
  acceptComicTake,
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
  const [pages, setPages] = useState<ComicPage[]>(stored?.script.pages ?? []);
  const scripts = useRef(production.comicScripts);
  scripts.current = production.comicScripts;
  const bases = useRef(new Map<string, string | null>());
  const draft = useRef<{ chapter: string; pages: ComicPage[] } | null>(null);
  const pending = useRef<{ requestId: string; chapter: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [unsaved, setUnsaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const baseFor = (id: string) => bases.current.has(id) ? bases.current.get(id)! : scripts.current?.find((entry) => entry.chapter === id)?.hash ?? null;
  const send = () => {
    clearTimeout(timer.current);
    const next = draft.current;
    if (next === null) return;
    if (pending.current !== null) { timer.current = setTimeout(send, 150); return; }
    draft.current = null;
    const requestId = saveComicScript(worldId, productionId, next.chapter, next.pages, baseFor(next.chapter));
    if (requestId === null) { draft.current = next; setProblem("not connected"); return; }
    pending.current = { requestId, chapter: next.chapter };
  };
  useEffect(() => {
    // Another window's save, or a chapter change: the stored script wins when nothing is unsaved here.
    if (draft.current === null && pending.current === null && chapter) {
      setPages(stored?.script.pages ?? []);
      bases.current.set(chapter.id, stored?.hash ?? null);
    }
  }, [stored?.hash, chapter?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => subscribeComicScriptSaveResults((result) => {
    if (result.requestId !== pending.current?.requestId) return;
    const saved = pending.current.chapter;
    pending.current = null;
    // The base is that chapter's own: a late answer never moves another chapter's base.
    if (result.disposition === "saved" && result.hash) { bases.current.set(saved, result.hash); setProblem(null); }
    else setProblem(result.reason ?? "not saved");
    if (draft.current === null) setUnsaved(false);
  }), []);
  const edit = (next: ComicPage[]) => {
    if (!chapter) return;
    draft.current = { chapter: chapter.id, pages: next };
    setUnsaved(true);
    setPages(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(send, SAVE_AFTER_MS);
  };
  useEffect(() => () => send(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const [pageId, setPageId] = useState<string | null>(pages[0]?.id ?? null);
  const page = pages.find((candidate) => candidate.id === pageId) ?? pages[0];
  const setPage = (change: (page: ComicPage) => ComicPage) => page && edit(pages.map((candidate) => (candidate.id === page.id ? change(structuredClone(candidate)) : candidate)));
  const book = useMemo(() => comicBook(production), [production]);
  const firstNumber = book.find((entry) => entry.chapter === chapter?.id)?.number ?? 1;
  const record = (id: string) => production.comicPages?.find((entry) => entry.page === id)?.record;

  const [reading, setReading] = useState(false);
  const [exporting, setExporting] = useState(false);

  if (chapters.length === 0) {
    return <Screen id="comic-pages"><EmptyState title="No chapters yet" action={<Button onClick={() => navigate(`${base}/story/chapters`)}>Chapters</Button>} /></Screen>;
  }
  return (
    <Screen id="comic-pages">
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
          <label className="fy-comic__sel"><b>Reading</b>
            <select aria-label="Reading" value={settings.reading} onChange={(event) => setComicSettings(worldId, productionId, { reading: event.target.value as ComicReading })}>
              {READING.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <Button onClick={() => setReading(true)}>Read</Button>
          <Button onClick={() => setExporting(true)}>Export</Button>
        </div>
        <div className="fy-comic__body">
          <div className="fy-comic__strip">
            {pages.map((candidate, index) => {
              const held = record(candidate.id);
              const accepted = held?.accepted[settings.language];
              const shown = held?.takes.find((take) => take.id === accepted) ?? held?.takes.at(-1);
              const url = takeFile(world, shown);
              const entry = book.find((item) => item.id === candidate.id);
              return (
                <button key={candidate.id} type="button" className={cx("fy-comic__thumb", candidate.id === page?.id && "on")} aria-label={`Page ${firstNumber + index}`} onClick={() => setPageId(candidate.id)}>
                  {url !== null && <img src={url} alt="" />}
                  {entry?.take !== undefined && <span className={cx("s", (!entry.cleared || entry.overridden || entry.outOfDate) && "w")}>{entry.cleared && !entry.overridden && !entry.outOfDate ? <Check size={10} /> : <TriangleAlert size={10} />}</span>}
                  <span className="n">{firstNumber + index}</span>
                </button>
              );
            })}
            <button type="button" className="fy-comic__add" onClick={() => { const next = newPage(); edit([...pages, next]); setPageId(next.id); }}>+ Page</button>
          </div>
          {page === undefined ? (
            <div className="fy-comic__edit"><EmptyState title="No pages yet" /></div>
          ) : (
            <PageEditor world={world} page={page} number={firstNumber + pages.indexOf(page)} change={setPage}
              remove={() => { edit(pages.filter((candidate) => candidate.id !== page.id)); setPageId(null); }} />
          )}
          {page === undefined ? <div className="fy-comic__side" /> : (
            <PageSide key={page.id} world={world} production={production} page={page} saving={unsaved} connected={connection === "open"}
              problem={problem} onSettings={() => navigate("/settings")} />
          )}
        </div>
      </div>
      {reading && <ComicReader world={world} production={production} onClose={() => setReading(false)} />}
      {exporting && <ComicExport world={world} production={production} onClose={() => setExporting(false)}
        goTo={(id) => { const entry = book.find((item) => item.id === id); if (entry) { setChapterId(entry.chapter); setPageId(id); } setExporting(false); }} />}
    </Screen>
  );
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

function PageSide({ world, production, page, saving, connected, problem, onSettings }: {
  world: WorldBundle; production: ProductionBundle; page: ComicPage; saving: boolean; connected: boolean; problem: string | null; onSettings: () => void;
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
  const [making, setMaking] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const asked = useRef<{ requestId: string; hash: string } | null>(null);
  const hash = comicPageHash(page, settings, "baked");
  const quote = quoted !== null && quoted.hash === hash && !saving ? quoted.quote : null;

  useEffect(() => subscribeComicPages((event) => {
    if (event.type === "comic.page-quote" && event.requestId === asked.current?.requestId) setQuoted({ hash: asked.current.hash, quote: event.quote });
    if (event.type === "comic.page-made" && event.page === page.id) {
      if (event.state === "making") setMaking(event.requestId);
      else { setMaking(null); setShownId(event.take ?? null); setSaid(event.state === "failed" ? event.reason ?? "not made" : null); }
    }
    if (event.type === "comic.take-result" && event.page === page.id) setSaid(event.disposition === "refused" ? event.reason ?? "refused" : null);
  }), [page.id]);
  // The price follows the page's words: asked again once an edit has saved (R-23, R-27).
  useEffect(() => {
    if (!connected || saving) return;
    const requestId = quoteComicPage(worldId, productionId, page.id);
    asked.current = requestId === null ? null : { requestId, hash };
  }, [connected, saving, worldId, productionId, page.id, hash]);

  const rects = panelRects(page, pageReading(page, settings));
  const url = takeFile(world, shown);
  const verification = shown?.verification;
  const blocking = verification?.status === "compared" ? verification.findings.filter((finding) => BLOCKING_FINDINGS.has(finding.kind)) : [];
  const passed = takePasses(verification);
  const outOfDate = shown !== undefined && shown.hash !== comicPageHash(page, settings, shown.mode);
  const lines = page.panels.reduce((count, panel) => count + panel.lettering.length, 0);
  const cap = settings.cap.attempts;
  const total = quote?.ok ? quote.microUsd * (until ? cap : 1) : 0;
  const make = () => {
    if (!quote?.ok) return;
    setSaid(null);
    // The book's dollar cap bounds the retries only; one attempt confirms its own price (codex on PR 2226).
    makeComicPage(worldId, productionId, page.id, until ? Math.max(quote.microUsd, Math.min(total, Math.round(settings.cap.usd * 1_000_000))) : quote.microUsd, undefined, until);
  };
  const press = making !== null ? "Making…" : takes.length ? "Make again" : "Make page";

  return (
    <div className="fy-comic__side">
      <div className="fy-comic__page" style={{ aspectRatio: pageAspect(page, settings).replace(":", " / ") }}>
        {url !== null ? <img src={url} alt={`Page take ${takes.indexOf(shown!) + 1}`} /> : rects.map((rect, index) => (
          <div key={index} className="fy-comic__wire" style={{ left: `calc(${rect.x * 100}% + 6px)`, top: `calc(${rect.y * 100}% + 6px)`, width: `calc(${rect.w * 100}% - 12px)`, height: `calc(${rect.h * 100}% - 12px)` }}>{index + 1}</div>
        ))}
        {url !== null && verification?.status === "compared" && verification.findings.filter((finding) => finding.box).map((finding) => (
          <div key={finding.id} className={cx("fy-comic__hit", !BLOCKING_FINDINGS.has(finding.kind) && "w")}
            style={{ left: `${finding.box!.x * 100}%`, top: `${finding.box!.y * 100}%`, width: `${finding.box!.w * 100}%`, height: `${finding.box!.h * 100}%` }}>
            <span>{FINDING[finding.kind]}</span>
          </div>
        ))}
      </div>
      {shown !== undefined && (outOfDate ? (
        <div className="fy-comic__verdict warn"><TriangleAlert size={15} /><b>Out of date</b><span className="grow" /><span className="m">the script changed</span></div>
      ) : verification?.status === "compared" ? (
        <div className={cx("fy-comic__verdict", passed ? "ok" : "bad")}>
          {passed ? <Check size={15} /> : <CircleAlert size={15} />}
          <b>{passed ? "Lettering" : `${blocking.length} to fix`}</b>
          {passed && <span>{lines} of {lines}</span>}
          <span className="grow" />
          <span className="m">{passed ? "" : `${lines - new Set(blocking.map((finding) => finding.item)).size} of ${lines} lines · `}read by {verification.reader.version.split(":")[1] ?? verification.reader.id}</span>
        </div>
      ) : (
        <div className="fy-comic__verdict warn"><TriangleAlert size={15} /><b>Not checked</b><span>{unavailableReason(verification)}</span><span className="grow" />
          {verification?.status === "unavailable" && verification.reason === "no-reader" && <Button variant="ghost" size="sm" onClick={onSettings}>Settings</Button>}
        </div>
      ))}
      {verification?.status === "compared" && verification.findings.length > 0 && !outOfDate && (
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
      {takes.length > 0 && (
        <div className="fy-comic__takes">
          {takes.map((take, index) => (
            <button key={take.id} type="button" className={cx("fy-comic__take", take.id === shown?.id && "on")} aria-label={`Take ${index + 1}`} onClick={() => setShownId(take.id)}>
              {takeFile(world, take) !== null && <img src={takeFile(world, take)!} alt="" />}
              <span className={cx("k", takePasses(take.verification) && "ok")} />
            </button>
          ))}
          <span className="m">{shown?.id === accepted ? "Accepted · " : ""}Take {takes.indexOf(shown!) + 1} of {takes.length}</span>
        </div>
      )}
      <div className="fy-comic__acts">
        {shown !== undefined && shown.id !== accepted && !outOfDate && passed && <Button variant="primary" onClick={() => acceptComicTake(worldId, productionId, page.id, shown.id)}>Accept</Button>}
        <Button variant={shown !== undefined && passed && shown.id !== accepted && !outOfDate ? "secondary" : "primary"} disabled={!quote?.ok || making !== null || !connected} onClick={make}
          title={quote && !quote.ok ? quote.reason : undefined}><Sparkle size={13} />{press}</Button>
        {shown !== undefined && shown.id !== accepted && !outOfDate && !passed && (
          <Button title="Keeps this take with what was found on the record" onClick={() => acceptComicTake(worldId, productionId, page.id, shown.id, { findings: blocking.map((finding) => finding.id) })}>Accept anyway</Button>
        )}
        <span className="grow" />
        {shown !== undefined && !outOfDate && <Button variant="ghost" size="sm" onClick={() => checkComicTake(worldId, productionId, page.id, shown.id)}>Check again</Button>}
      </div>
      <div className="fy-comic__make">
        <label className="fy-comic__check"><input type="checkbox" checked={until} onChange={(event) => setUntil(event.target.checked)} />Until it passes</label>
        <span className="grow" />
        <Button variant="ghost" size="sm" aria-expanded={brief} onClick={() => setBrief(!brief)}>Brief</Button>
        <span className="m">{quote === null ? "…" : !quote.ok ? quote.reason : `${quote.modelName} · ${quote.aspect}${quote.riding.length ? ` · ${quote.riding.join(", ")} ride` : ""}${quote.missing.length ? ` · no picture: ${quote.missing.join(", ")}` : ""} · ${priceLabel(quote.microUsd)}${until ? ` · up to ${cap} · ${priceLabel(total)}` : ""}`}</span>
      </div>
      {brief && quote?.ok && <pre className="fy-comic__brief">{quote.brief}</pre>}
      {(said ?? problem) !== null && <div className="fy-comic__verdict bad"><CircleAlert size={15} /><span>{said ?? problem}</span></div>}
    </div>
  );
}

function unavailableReason(verification: ComicPageTake["verification"]): string {
  if (verification?.status !== "unavailable") return "not yet";
  return { "no-reader": "no image reader", "reader-failed": "the read failed", unreadable: "picture unreadable", language: "language not read", "no-lettering": "no lettering" }[verification.reason];
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

