import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  COMIC_STYLE_REFERENCE, SPOKEN_KINDS, balloonBox, panelInset, comicPageFinishable, comicPanelPrompt, comicPanelStates, compareLettering, comicBook, panelTakeClears, ulid, type ComicPageTake, type ComicPanelState, type LetteringPlacement, type PageBox, type DraftComicPage, type WorldChatCheckReceipt, pageReading, sheetReferencePicture, takeBlocking, takeClears, type LetteringVerification, type PageReview, type ReviewWarning,
  COMIC_LIMITS, COMIC_PROMPT_MAX, ComicPageRecordSchema, ComicScriptSchema, ComicSettingsSchema, DEFAULT_COMIC_SETTINGS, EMPTY_COMIC_PAGE_RECORD,
  comicPageHash, comicPagePrompt, makesShape, pageAspect, pictureQuote, productionShape,
  type ComicCited, type ComicMode, type ComicPage, type ComicPageRecord, type ComicSettings, type ManifestModel, type PictureWho, type ProductionBundle,
} from "@arke-studio/contracts";
import { fileArtifact } from "../artifacts/filing.js";
import { referenceBudgetFor } from "../references/generate.js";
import { pictureWho } from "./audiobook-picture-suggest.js";
import { artDirectionFor } from "./audiobook-look.js";
import type { PageReader } from "./graphic-novel-reader.js";
import { clearOfFaces, tailClearOfFaces, type PagePlacer } from "./graphic-novel-placer.js";
import { PANEL_REVIEW_PROMPT, type PageReviewer } from "./graphic-novel-reviewer.js";
import { pagesForReading, type ScriptReader } from "./graphic-novel-script-reader.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";
import type { WorldStore } from "../world/store.js";
import { oneAtATime } from "./audio-drama.js";

/**
 * The graphic novel's writes (SPEC-064). Every write here is fenced on the bytes it was read from:
 * a page picture is keyed to its script's fingerprint, so a lost edit would make a take look
 * current against words nobody wrote.
 */

function graphicNovel(store: WorldStore, productionId: string) {
  const production = store.getBundle().productions.find((candidate) => candidate.meta.id === productionId);
  if (!production) throw new Error(`production ${productionId} is not in this world`);
  if (!productionShape(production.meta).hasPages) throw new Error(`${production.meta.title} is not a graphic novel.`);
  return production;
}

export const comicScriptPath = (productionId: string, chapter: string) => `productions/${productionId}/comic/${chapter}.json`;

/**
 * A chapter's comic script saved whole (R-10). The base hash is the file the editor read, null for
 * a chapter with no script yet; a save against a moved base is refused by the committer rather than
 * merged. A direct save keeps the version, as an episode script's does.
 */
export async function saveComicScript(
  store: WorldStore,
  productionId: string,
  input: { chapter: string; pages: readonly ComicPage[]; baseHash: string | null },
  options: { source?: string; requestId?: string } = {},
): Promise<{ version: number; hash: string }> {
  const production = graphicNovel(store, productionId);
  // A script for a chapter the book does not have would be read by nothing and exported by nothing.
  if (!production.chapters?.some((chapter) => chapter.id === input.chapter)) throw new Error(`${production.meta.title} has no chapter ${input.chapter}.`);
  const path = comicScriptPath(productionId, input.chapter);
  // The editor writes pages; the kept plan they were drawn from stays (SPEC-064 R-60). The cold read
  // described Arke's draft, not the author's edit of it, so it goes.
  const plan = production.comicScripts?.find((entry) => entry.chapter === input.chapter)?.script.plan;
  const record = ComicScriptSchema.parse({ version: 1, pages: input.pages, ...(plan ? { plan } : {}) });
  const result = await store.commit({
    kind: "comic-script-save",
    source: options.source ?? "editor",
    ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
    files: [{
      path,
      action: input.baseHash === null ? "create" : "replace",
      content: `${JSON.stringify(record, null, 2)}\n`,
      baseHash: input.baseHash,
      preserveVersion: true,
    }],
  });
  const hash = result.hashes?.[path];
  if (hash === undefined) throw new Error("The script was saved without a hash to save against next.");
  return { version: result.versions[path]!, hash };
}

/** `comic.json` changed in one write fenced on the file it was read from (R-12). */
export async function setComicSettings(
  store: WorldStore,
  productionId: string,
  change: Partial<Omit<ComicSettings, "version" | "style">> & { style?: ComicSettings["style"] | null | undefined },
): Promise<ComicSettings> {
  graphicNovel(store, productionId);
  const path = `productions/${productionId}/comic.json`;
  return oneAtATime(`${store.dir}/${path}`, async () => {
    const live = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8").catch(() => null);
    const current = live === null ? DEFAULT_COMIC_SETTINGS : ComicSettingsSchema.parse(JSON.parse(live));
    // A null style is World look, written as no style at all, so the file reads as one made before
    // there was a style (R-21a).
    const { style, ...rest } = change;
    const merged: Record<string, unknown> = { ...current, ...rest };
    if (style === null) delete merged.style;
    else if (style !== undefined) merged.style = style;
    const next = ComicSettingsSchema.parse(merged);
    await store.commit({
      kind: "comic-settings",
      source: "comic-settings",
      files: [{ path, action: live === null ? "create" : "replace", content: `${JSON.stringify(next, null, 2)}\n`, baseHash: live === null ? null : sha256(live) }],
    });
    return next;
  });
}

// ---------------------------------------------------------------------------
// Pages and their takes (R-22 – R-27)
// ---------------------------------------------------------------------------

/** The take a page's admission reserved in its Bench session, by the request the Bench planned it under. */
export function comicPageTake<T extends { requestId: string }>(bench: { session: { takes: readonly T[] } } | null, requestId: string): T | undefined {
  return bench?.session.takes.find((take) => take.requestId === `pic:${requestId}` || take.requestId.startsWith(`pic:${requestId}/`));
}

export const comicPagePath = (productionId: string, pageId: string) => `productions/${productionId}/comic-pages/${pageId}.json`;

/** Where a page stands in the book (D-2): its chapter, and its number counted through every chapter. */
export function findComicPage(production: ProductionBundle, pageId: string): { chapter: string; page: ComicPage; number: number } | null {
  // A retired chapter keeps its script on disk; its pages are in no book and count toward no number (codex on PR 2220).
  const order = new Map(production.chapters.filter((chapter) => !chapter.retired).map((chapter) => [chapter.id, chapter.order]));
  const scripts = [...(production.comicScripts ?? [])].filter((entry) => order.has(entry.chapter))
    .sort((a, b) => order.get(a.chapter)! - order.get(b.chapter)!);
  let number = 0;
  for (const entry of scripts) {
    for (const page of entry.script.pages) {
      number += 1;
      if (page.id === pageId) return { chapter: entry.chapter, page, number };
    }
  }
  return null;
}

export function comicPageRecord(production: ProductionBundle, pageId: string): ComicPageRecord {
  return production.comicPages?.find((entry) => entry.page === pageId)?.record ?? EMPTY_COMIC_PAGE_RECORD;
}

/** A page's record changed in one write fenced on the bytes it was read from. */
export async function changeComicPage(store: WorldStore, productionId: string, pageId: string, change: (record: ComicPageRecord) => ComicPageRecord): Promise<ComicPageRecord> {
  graphicNovel(store, productionId);
  const path = comicPagePath(productionId, pageId);
  return oneAtATime(`${store.dir}/${path}`, async () => {
    const live = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8").catch(() => null);
    const current = live === null ? EMPTY_COMIC_PAGE_RECORD : ComicPageRecordSchema.parse(JSON.parse(live));
    const next = ComicPageRecordSchema.parse(change(structuredClone(current)));
    await store.commit({
      kind: "comic-page",
      source: "comic-page",
      files: [{ path, action: live === null ? "create" : "replace", content: `${JSON.stringify(next, null, 2)}\n`, baseHash: live === null ? null : sha256(live) }],
    });
    return next;
  });
}

/**
 * Anything the finished image was flattened from has moved, so it no longer says what the page does
 * (R-48a): the acceptance goes and the page asks for Accept page again. The take stays until the next one replaces it.
 */
function withdrawFinished(record: ComicPageRecord): ComicPageRecord {
  const finished = new Set(record.takes.filter((take) => take.mode === "overlay").map((take) => take.id));
  return { ...record, accepted: Object.fromEntries(Object.entries(record.accepted).filter(([, take]) => !finished.has(take))) };
}

/** Everything a page's generation needs, or the one reason it cannot be made (R-19, R-23, R-24). */
export type ComicPageRequest =
  | { ok: true; page: ComicPage; number: number; settings: ComicSettings; mode: ComicMode; hash: string; aspect: string; who: PictureWho[];
      prompt: (cited: readonly ComicCited[]) => string; microUsd: number; missing: string[] }
  | { ok: false; reason: string };

export function comicPageRequest(store: WorldStore, productionId: string, pageId: string, model: ManifestModel, wanted?: ComicMode): ComicPageRequest {
  const production = graphicNovel(store, productionId);
  const found = findComicPage(production, pageId);
  if (!found) return { ok: false, reason: "that page is no longer in the script" };
  const settings = production.comic ?? DEFAULT_COMIC_SETTINGS;
  const mode = wanted ?? settings.mode;
  // Panel by panel has no one page to draw: comicPanelRequest draws each panel.
  if (mode === "overlay") return { ok: false, reason: "this book makes its pages panel by panel" };
  const { page } = found;
  if (page.panels.length === 0) return { ok: false, reason: "the page has no panels" };
  // Refused before anything is spent: a take the record cannot hold would be paid for and lost (codex on PR 2222).
  const held = comicPageRecord(production, pageId);
  if (held.takes.length + held.making.length >= COMIC_LIMITS.takesPerPage) return { ok: false, reason: `this page has ${COMIC_LIMITS.takesPerPage} takes, the most it keeps` };
  // Baked lettering only on a model whose vendor says it letters (R-24); overlay art takes any.
  if (mode === "baked" && model.limits.lettering !== true) return { ok: false, reason: `${model.displayName} does not letter pages · choose a model that letters` };
  const aspect = pageAspect(page, settings);
  if (!makesShape(model, aspect)) return { ok: false, reason: `${model.displayName} makes no ${aspect} page` };
  const bundle = store.getBundle();
  const sheet = (id: string) => bundle.sheets.find((candidate) => candidate.id === id);
  const names = (id: string) => sheet(id)?.name ?? id;
  // Each person and place once, in the order the page shows them; the model's limit cuts the rest (R-20).
  const people = [...new Set(page.panels.flatMap((panel) => panel.characters))];
  const places = [...new Set(page.panels.flatMap((panel) => panel.location ? [panel.location] : []))];
  const who = pictureWho(store, model, [
    ...people.map((id) => ({ key: id, name: names(id), ...(sheet(id) ? { sheet: id } : {}), kind: "character" as const })),
    ...places.map((id) => ({ key: id, name: names(id), ...(sheet(id) ? { sheet: id } : {}), kind: "place" as const })),
  ]);
  // Named without a picture that rides: listed, never quietly drawn from the words alone (R-19).
  const missing = who.filter((entry) => !entry.carried || entry.reference === null).map((entry) => entry.name);
  // The look in words, as an audiobook picture carries it (R-18). `masterLook` is the art direction's
  // picture, a path: sent as words it told the model nothing.
  const look = artDirectionFor(store, productionId);
  const style = settings.style?.words;
  const prompt = (cited: readonly ComicCited[]) => comicPagePrompt({ page, settings, mode, ...(look ? { look } : {}), ...(style ? { style } : {}), names, cited });
  const longest = prompt(who.filter((entry) => entry.carried && entry.reference !== null).map((entry, index) => ({ name: entry.name, kind: entry.kind, token: `ref${index + 1}` })));
  const bound = Math.min(COMIC_PROMPT_MAX, model.limits.maxPromptChars ?? COMIC_PROMPT_MAX);
  if (longest.length > bound) return { ok: false, reason: `the page brief is ${longest.length} characters; ${model.displayName} takes ${bound}` };
  const riding = who.filter((entry) => entry.carried && entry.reference !== null).length;
  return { ok: true, page, number: found.number, settings, mode, hash: comicPageHash(page, settings, mode), aspect, who, prompt, microUsd: pictureQuote(model, riding, aspect), missing };
}

// ---------------------------------------------------------------------------
// Lettering verification, accept and override (R-29 – R-35)
// ---------------------------------------------------------------------------

/**
 * Languages the reader and the normalisation do not cover yet (R-35, D-8): Latin scripts first.
 * A page in one of these is `unavailable`, never passing (R-32).
 */
const UNREAD_LANGUAGES = new Set(["ja", "zh", "ko", "ar", "he", "fa", "ur", "th", "hi", "bn", "ta", "te", "ru", "uk", "bg", "sr", "el", "ka", "hy", "am"]);

/**
 * Reads a take back and compares it with the script (R-29 – R-32), and writes what was found on
 * the take. Overlay art is compared with no lettering at all, so any words in it are extra. Every
 * way the check cannot run is recorded as `unavailable` with its reason, and that is not a pass.
 */
export async function verifyComicTake(store: WorldStore, productionId: string, pageId: string, takeId: string, reader: PageReader | null, signal: AbortSignal, at: () => string): Promise<LetteringVerification> {
  const production = graphicNovel(store, productionId);
  const found = findComicPage(production, pageId);
  const take = comicPageRecord(production, pageId).takes.find((candidate) => candidate.id === takeId);
  if (!found || !take) throw new Error("that take is no longer on the page");
  const settings = production.comic ?? DEFAULT_COMIC_SETTINGS;
  const page = take.mode === "overlay" ? { ...found.page, panels: found.page.panels.map((panel) => ({ ...panel, lettering: [] })) } : found.page;
  const unavailable = (reason: "no-reader" | "reader-failed" | "unreadable" | "language", detail?: string): LetteringVerification =>
    ({ status: "unavailable", reason, ...(detail ? { detail: detail.slice(0, 400) } : {}), at: at() });
  let verification: LetteringVerification;
  const artifact = store.getBundle().artifacts.find((candidate) => candidate.id === take.artifact);
  if (UNREAD_LANGUAGES.has(take.language.split("-")[0]!.toLowerCase())) verification = unavailable("language", `${take.language} is not read yet`);
  else if (reader === null) verification = unavailable("no-reader", "no harness that inspects images is ready");
  else if (!artifact) verification = unavailable("unreadable", "the page picture is not in the world");
  else {
    const bytes = await readFile(toExtendedLength(join(store.dir, "artifacts", fromPortable(artifact.file)))).catch(() => null);
    if (bytes === null) verification = unavailable("unreadable", "the page picture could not be read");
    else {
      try {
        const read = await reader.read(bytes, artifact.file.split(".").at(-1) ?? "png", signal);
        verification = compareLettering({ page, reading: pageReading(found.page, settings), regions: read.regions, thresholds: settings.thresholds,
          reader: read.reader, at: at(), precise: reader.precise });
      } catch (err) {
        if (signal.aborted) throw err;
        verification = unavailable("reader-failed", err instanceof Error ? err.message : String(err));
      }
    }
  }
  await changeComicPage(store, productionId, pageId, (record) => ({ ...record,
    // A new read is a new verdict: an override the author gave the old one does not carry to it.
    takes: record.takes.map((candidate) => {
      if (candidate.id !== takeId) return candidate;
      const { override: _old, ...rest } = candidate;
      return { ...rest, verification };
    }) }));
  return verification;
}

/**
 * The author's choice of take (R-26, R-33). A take made from words the script no longer says is
 * out of date and is never accepted. One with a blocking finding, or whose check did not complete,
 * is accepted only with an override naming every finding it covers, kept on the take.
 */
export async function acceptComicTake(store: WorldStore, productionId: string, pageId: string, takeId: string,
  override: { findings: readonly string[]; reason?: string } | undefined, at: string): Promise<void> {
  const production = graphicNovel(store, productionId);
  const found = findComicPage(production, pageId);
  if (!found) throw new Error("that page is no longer in the script");
  const settings = production.comic ?? DEFAULT_COMIC_SETTINGS;
  await changeComicPage(store, productionId, pageId, (record) => {
    const panelTake = record.panelTakes.find((candidate) => candidate.id === takeId);
    if (panelTake) return acceptComicPanelTake(record, panelTake, override, at, comicPanelStates(found.page, record, settings).find((state) => state.panel.id === panelTake.panel)?.hash ?? "");
    const take = record.takes.find((candidate) => candidate.id === takeId);
    if (!take) throw new Error("that take is no longer on the page");
    if (take.hash !== comicPageHash(found.page, settings, take.mode)) throw new Error("the script changed since this take was made; make the page again");
    // Its words' and its picture's findings together (R-69): an override names every one it covers.
    const blocking = takeBlocking(take);
    const clears = takeClears(take);
    if (!clears) {
      if (override === undefined) throw new Error(take.verification?.status === "compared" ? "this take has findings; accept it anyway to keep it" : "this take's lettering was not checked; accept it anyway to keep it");
      const uncovered = blocking.filter((id) => !override.findings.includes(id));
      if (uncovered.length) throw new Error(`the override does not cover ${uncovered.join(", ")}`);
    }
    return {
      ...record,
      accepted: { ...record.accepted, [take.language]: take.id },
      takes: record.takes.map((candidate) => candidate.id !== takeId || clears ? candidate
        : { ...candidate, override: { at, findings: blocking, ...(override?.reason ? { reason: override.reason } : {}) } }),
    };
  });
}

/** The page's script as the reviewer reads it (R-67): what each panel shows and says, never the prose. */
function scriptForReview(store: WorldStore, page: ComicPage): string {
  const bundle = store.getBundle();
  const name = (id: string) => bundle.sheets.find((sheet) => sheet.id === id)?.name ?? id;
  return [`Layout: ${page.layout}, ${page.panels.length} panel${page.panels.length === 1 ? "" : "s"}.`, ...page.panels.map((panel, index) => [
    `Panel ${index + 1}: ${panel.description}`,
    ...(panel.characters.length ? [`  Shows: ${panel.characters.map(name).join(", ")}`] : []),
    ...(panel.location ? [`  Place: ${name(panel.location)}`] : []),
    ...panel.lettering.map((item) => `  ${item.kind}${item.speaker ? ` (${name(item.speaker)})` : ""}: "${item.text}"`),
  ].join("\n"))].join("\n");
}

async function pictureBytes(store: WorldStore, file: string): Promise<{ bytes: Uint8Array; extension: string } | null> {
  const bytes = await readFile(toExtendedLength(join(store.dir, fromPortable(file)))).catch(() => null);
  return bytes === null ? null : { bytes, extension: file.split(".").at(-1)?.toLowerCase() ?? "png" };
}

/**
 * Looks at a take as a picture, after its lettering is read (R-67 – R-72): against its script, the
 * references of the people and places it names, and the accepted page before it. Every way the
 * review cannot run is `unavailable` with its reason, and that is not a pass.
 */
export async function reviewComicTake(store: WorldStore, productionId: string, pageId: string, takeId: string, reviewer: PageReviewer | null, signal: AbortSignal, at: () => string): Promise<PageReview> {
  const production = graphicNovel(store, productionId);
  const found = findComicPage(production, pageId);
  const take = comicPageRecord(production, pageId).takes.find((candidate) => candidate.id === takeId);
  if (!found || !take) throw new Error("that take is no longer on the page");
  const unavailable = (reason: "no-reviewer" | "reviewer-failed" | "unreadable", detail?: string): PageReview =>
    ({ status: "unavailable", reason, ...(detail ? { detail: detail.slice(0, 400) } : {}), at: at() });
  const bundle = store.getBundle();
  const artifact = (id: string) => bundle.artifacts.find((candidate) => candidate.id === id);
  let review: PageReview;
  const own = artifact(take.artifact);
  const picture = own ? await pictureBytes(store, `artifacts/${own.file}`) : null;
  if (reviewer === null) review = unavailable("no-reviewer", "no harness that inspects images is ready");
  else if (picture === null) review = unavailable("unreadable", "the page picture could not be read");
  else {
    // The page before it in the book, as it was accepted (R-21).
    const book = comicBook(production);
    const index = book.findIndex((entry) => entry.id === pageId);
    const before = index > 0 ? book[index - 1]!.take : undefined;
    const beforeArtifact = before ? artifact(before.artifact) : undefined;
    const previous = beforeArtifact ? await pictureBytes(store, `artifacts/${beforeArtifact.file}`) : null;
    const named = [...new Set(found.page.panels.flatMap((panel) => [...panel.characters, ...(panel.location ? [panel.location] : [])]))];
    const references: Array<{ name: string; bytes: Uint8Array; extension: string }> = [];
    // The reviewer's image budget goes to the page and the page before it first; references fill what is left (R-67).
    for (const sheet of named.slice(0, 6)) {
      const file = sheetReferencePicture(bundle, sheet);
      const bytes = file ? await pictureBytes(store, file) : null;
      if (bytes) references.push({ name: bundle.sheets.find((candidate) => candidate.id === sheet)?.name ?? sheet, ...bytes });
    }
    const extras = take.verification?.status === "compared"
      ? take.verification.findings.filter((entry) => entry.kind === "extra" && entry.found).map((entry) => ({ id: entry.id, text: entry.found! })) : [];
    try {
      const answer = await reviewer.review({ script: scriptForReview(store, found.page), extras, page: picture, ...(previous ? { previous } : {}), references }, signal);
      review = { status: "compared", reviewer: answer.reviewer, references: references.map((entry) => entry.name),
        ...(before && previous ? { previous: before.id } : {}), findings: answer.findings, cleared: answer.cleared, at: at() };
    } catch (err) {
      if (signal.aborted) throw err;
      review = unavailable("reviewer-failed", err instanceof Error ? err.message : String(err));
    }
  }
  await changeComicPage(store, productionId, pageId, (record) => ({ ...record,
    // A new review is a new verdict: an override the author gave the old one does not carry to it,
    // and nor does a warning they saw on it.
    acknowledged: Object.fromEntries(Object.entries(record.acknowledged).filter(([id]) => id !== takeId)),
    takes: record.takes.map((candidate) => {
      if (candidate.id !== takeId) return candidate;
      const { override: _old, ...rest } = candidate;
      return { ...rest, review };
    }) }));
  return review;
}

/** A review warning on a take marked Seen (R-69, turn 253c): looked at, kept on the page record. */
export async function seeComicWarning(store: WorldStore, productionId: string, pageId: string, takeId: string, warning: ReviewWarning): Promise<void> {
  await changeComicPage(store, productionId, pageId, (record) => {
    if (!record.takes.some((candidate) => candidate.id === takeId) && !record.panelTakes.some((candidate) => candidate.id === takeId)) throw new Error("that take is no longer on the page");
    const seen = new Set(record.acknowledged[takeId] ?? []);
    seen.add(warning);
    return { ...record, acknowledged: { ...record.acknowledged, [takeId]: [...seen] } };
  });
}

// ---------------------------------------------------------------------------
// Panel by panel (R-36a – R-48a, design turn 269)
// ---------------------------------------------------------------------------

/** The shape nearest the panel's that this model makes; compiling centre-crops the difference (R-37a). */
export function nearestPanelShape(model: ManifestModel, shape: string): string | null {
  if (makesShape(model, shape)) return shape;
  const ratio = (text: string) => { const [a, b] = text.split(":").map(Number) as [number, number]; return Math.log(a / b); };
  const offered = (model.limits.aspects?.length ? model.limits.aspects : ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"]).filter((candidate) => makesShape(model, candidate));
  return [...offered].sort((a, b) => Math.abs(ratio(a) - ratio(shape)) - Math.abs(ratio(b) - ratio(shape)))[0] ?? null;
}

/** The accepted panel nearest before this one in the book, whose drawing rides as style only (R-37b). */
function styleAnchor(store: WorldStore, production: ProductionBundle, pageId: string, panelId: string): string | null {
  const settings = production.comic ?? DEFAULT_COMIC_SETTINGS;
  const artifacts = store.getBundle().artifacts;
  const book = comicBook(production);
  const at = book.findIndex((entry) => entry.id === pageId);
  for (let index = at; index >= 0; index--) {
    const entry = book[index]!;
    const states = comicPanelStates(entry.page, comicPageRecord(production, entry.id), settings).filter((state) => state.panel.id !== panelId && state.accepted !== undefined);
    const take = states.at(-1)?.accepted;
    const artifact = take && artifacts.find((candidate) => candidate.id === take.artifact);
    if (artifact) return `artifacts/${artifact.file}`;
  }
  return null;
}

export type ComicPanelRequest =
  | { ok: true; state: ComicPanelState; number: number; aspect: string; who: PictureWho[]; prompt: (cited: readonly ComicCited[]) => string; microUsd: number; missing: string[] }
  | { ok: false; reason: string };

/** One panel's generation: its people and place riding, and no line of its script (R-37a). */
export function comicPanelRequest(store: WorldStore, productionId: string, pageId: string, panelId: string, model: ManifestModel, options: { noStyleReference?: boolean } = {}): ComicPanelRequest {
  const production = graphicNovel(store, productionId);
  const found = findComicPage(production, pageId);
  if (!found) return { ok: false, reason: "that page is no longer in the script" };
  const settings = production.comic ?? DEFAULT_COMIC_SETTINGS;
  const state = comicPanelStates(found.page, comicPageRecord(production, pageId), settings).find((candidate) => candidate.panel.id === panelId);
  if (!state) return { ok: false, reason: "that panel is no longer on the page" };
  if (state.takes.length >= COMIC_LIMITS.takesPerPanel) return { ok: false, reason: `panel ${state.index + 1} has ${COMIC_LIMITS.takesPerPanel} takes, the most it keeps` };
  const aspect = nearestPanelShape(model, state.shape);
  if (aspect === null) return { ok: false, reason: `${model.displayName} makes no ${state.shape} panel` };
  const bundle = store.getBundle();
  const sheet = (id: string) => bundle.sheets.find((candidate) => candidate.id === id);
  const names = (id: string) => sheet(id)?.name ?? id;
  const { panel } = state;
  const cast = pictureWho(store, model, [
    ...panel.characters.map((id) => ({ key: id, name: names(id), ...(sheet(id) ? { sheet: id } : {}), kind: "character" as const })),
    ...(panel.location ? [{ key: panel.location, name: names(panel.location), ...(sheet(panel.location) ? { sheet: panel.location } : {}), kind: "place" as const }] : []),
  ]);
  const missing = cast.filter((entry) => !entry.carried || entry.reference === null).map((entry) => entry.name);
  const riding = cast.filter((entry) => entry.carried && entry.reference !== null).length;
  // The cast's pictures first; the drawing's reference takes a place only if one is left over.
  const anchor = options.noStyleReference !== true && riding < referenceBudgetFor(model) ? styleAnchor(store, production, pageId, panelId) : null;
  const who: PictureWho[] = anchor === null ? cast : [...cast, { key: "comic-style-reference", name: COMIC_STYLE_REFERENCE, kind: "place", reference: anchor, carried: true }];
  const look = artDirectionFor(store, productionId);
  const style = settings.style?.words;
  // The exact shape is asked in words even when the route is sent a near one, so it comes as close as it can.
  const prompt = (cited: readonly ComicCited[]) => comicPanelPrompt({ panel, shape: state.shape, ...(look ? { look } : {}), ...(style ? { style } : {}), names, cited });
  const longest = prompt(who.filter((entry) => entry.carried && entry.reference !== null).map((entry, index) => ({ name: entry.name, kind: entry.kind, token: `ref${index + 1}` })));
  const bound = Math.min(COMIC_PROMPT_MAX, model.limits.maxPromptChars ?? COMIC_PROMPT_MAX);
  if (longest.length > bound) return { ok: false, reason: `panel ${state.index + 1}'s brief is ${longest.length} characters; ${model.displayName} takes ${bound}` };
  return { ok: true, state, number: found.number, aspect, who, prompt, microUsd: pictureQuote(model, riding + (anchor === null ? 0 : 1), aspect), missing };
}

/**
 * The panels a press makes (R-37a): the one asked for, or every panel with no current take that is
 * not on its way. A panel holding a fault or still being read is not made again unasked: one press
 * never spends twice on a fault the author has not seen.
 */
export function comicPanelsToMake(store: WorldStore, productionId: string, pageId: string, only?: string): string[] {
  const production = graphicNovel(store, productionId);
  const found = findComicPage(production, pageId);
  if (!found) return [];
  if (only !== undefined) return found.page.panels.some((panel) => panel.id === only) ? [only] : [];
  const settings = production.comic ?? DEFAULT_COMIC_SETTINGS;
  return comicPanelStates(found.page, comicPageRecord(production, pageId), settings).filter((state) => state.shown === undefined && !state.making).map((state) => state.panel.id);
}

/** The price and brief a page's press shows (R-37a): the panels it would make, at one price. */
export function comicPanelsQuote(store: WorldStore, productionId: string, pageId: string, model: ManifestModel, only?: string):
  { ok: true; aspect: string; microUsd: number; brief: string; riding: string[]; missing: string[] } | { ok: false; reason: string } {
  const panels = comicPanelsToMake(store, productionId, pageId, only);
  let microUsd = 0;
  const briefs: string[] = [];
  const riding = new Set<string>();
  const missing = new Set<string>();
  let aspect = "";
  for (const panel of panels) {
    const request = comicPanelRequest(store, productionId, pageId, panel, model);
    if (!request.ok) return request;
    microUsd += request.microUsd;
    aspect = aspect === "" || aspect === request.aspect ? request.aspect : "panels";
    const rides = request.who.filter((entry) => entry.carried && entry.reference !== null);
    briefs.push(`Panel ${request.state.index + 1}\n${request.prompt(rides.map((entry, index) => ({ name: entry.name, kind: entry.kind, token: `ref${index + 1}` })))}`);
    for (const entry of rides) if (entry.name !== COMIC_STYLE_REFERENCE) riding.add(entry.name);
    for (const name of request.missing) missing.add(name);
  }
  return { ok: true, aspect: aspect || "panels", microUsd, brief: briefs.join("\n\n---\n\n"), riding: [...riding], missing: [...missing] };
}

/**
 * A panel's picture looked at (R-37b), then, with nothing blocking and its take still of what the
 * panel shows, accepted. A change to one of the page's accepted panels withdraws the finished image
 * made from it (R-48a).
 */
export async function reviewComicPanel(store: WorldStore, productionId: string, pageId: string, takeId: string, reviewer: PageReviewer | null, signal: AbortSignal, at: () => string): Promise<PageReview> {
  const production = graphicNovel(store, productionId);
  const found = findComicPage(production, pageId);
  const take = comicPageRecord(production, pageId).panelTakes.find((candidate) => candidate.id === takeId);
  const panel = found?.page.panels.find((candidate) => candidate.id === take?.panel);
  if (!found || !take || !panel) throw new Error("that take is no longer on the page");
  const unavailable = (reason: "no-reviewer" | "reviewer-failed" | "unreadable", detail?: string): PageReview =>
    ({ status: "unavailable", reason, ...(detail ? { detail: detail.slice(0, 400) } : {}), at: at() });
  const bundle = store.getBundle();
  const own = bundle.artifacts.find((candidate) => candidate.id === take.artifact);
  const picture = own ? await pictureBytes(store, `artifacts/${own.file}`) : null;
  let review: PageReview;
  if (reviewer === null) review = unavailable("no-reviewer", "no harness that inspects images is ready");
  else if (picture === null) review = unavailable("unreadable", "the panel picture could not be read");
  else {
    const references: Array<{ name: string; bytes: Uint8Array; extension: string }> = [];
    for (const sheet of [...panel.characters, ...(panel.location ? [panel.location] : [])].slice(0, 6)) {
      const file = sheetReferencePicture(bundle, sheet);
      const bytes = file ? await pictureBytes(store, file) : null;
      if (bytes) references.push({ name: bundle.sheets.find((candidate) => candidate.id === sheet)?.name ?? sheet, ...bytes });
    }
    const name = (id: string) => bundle.sheets.find((sheet) => sheet.id === id)?.name ?? id;
    const script = [`The panel: ${panel.description}`, ...(panel.characters.length ? [`Shows: ${panel.characters.map(name).join(", ")}`] : []), ...(panel.location ? [`Place: ${name(panel.location)}`] : [])].join("\n");
    try {
      const answer = await reviewer.review({ script, extras: [], page: picture, references, prompt: PANEL_REVIEW_PROMPT }, signal);
      review = { status: "compared", reviewer: answer.reviewer, references: references.map((entry) => entry.name), findings: answer.findings, cleared: [], at: at() };
    } catch (err) {
      if (signal.aborted) throw err;
      review = unavailable("reviewer-failed", err instanceof Error ? err.message : String(err));
    }
  }
  await changeComicPage(store, productionId, pageId, (record) => {
    const live = graphicNovel(store, productionId);
    const page = findComicPage(live, pageId)?.page;
    const settings = live.comic ?? DEFAULT_COMIC_SETTINGS;
    const next = { ...record,
      acknowledged: Object.fromEntries(Object.entries(record.acknowledged).filter(([id]) => id !== takeId)),
      panelTakes: record.panelTakes.map((candidate) => {
        if (candidate.id !== takeId) return candidate;
        const { override: _old, ...rest } = candidate;
        return { ...rest, review };
      }) };
    const state = page && comicPanelStates(page, record, settings).find((candidate) => candidate.panel.id === take.panel);
    if (state?.hash === take.hash && panelTakeClears({ review })) return withdrawFinished({ ...next, panelAccepted: { ...next.panelAccepted, [take.panel]: takeId } });
    // A take already accepted that now reads worse is no longer accepted: its override went with the old verdict.
    if (next.panelAccepted[take.panel] === takeId) {
      const { [take.panel]: _gone, ...rest } = next.panelAccepted;
      return withdrawFinished({ ...next, panelAccepted: rest });
    }
    return next;
  });
  return review;
}

/** Accept anyway on a panel (R-37b): its findings kept on its take, as R-33 keeps a page's. */
function acceptComicPanelTake(record: ComicPageRecord, take: ComicPageRecord["panelTakes"][number], override: { findings: readonly string[]; reason?: string } | undefined, at: string, current: string): ComicPageRecord {
  if (take.hash !== current) throw new Error("the panel changed since this take was made; make it again");
  const blocking = takeBlocking(take);
  const clears = panelTakeClears(take);
  if (!clears) {
    if (override === undefined) throw new Error("this panel has findings; accept it anyway to keep it");
    const uncovered = blocking.filter((id) => !override.findings.includes(id));
    if (uncovered.length) throw new Error(`the override does not cover ${uncovered.join(", ")}`);
  }
  return withdrawFinished({ ...record,
    panelAccepted: { ...record.panelAccepted, [take.panel]: take.id },
    panelTakes: record.panelTakes.map((candidate) => candidate.id !== take.id || clears ? candidate
      : { ...candidate, override: { at, findings: blocking, ...(override?.reason ? { reason: override.reason } : {}) } }) });
}

/** The words where the author put them (R-38a). A line the page no longer has cannot be placed. */
export async function setComicLettering(store: WorldStore, productionId: string, pageId: string, placements: readonly LetteringPlacement[], undoesPlacing: boolean): Promise<void> {
  const found = findComicPage(graphicNovel(store, productionId), pageId);
  if (!found) throw new Error("that page is no longer in the script");
  const lines = new Set(found.page.panels.flatMap((panel) => panel.lettering.map((item) => item.id)));
  const stray = placements.find((entry) => !lines.has(entry.item));
  if (stray) throw new Error("that line is no longer on the page");
  if (new Set(placements.map((entry) => entry.item)).size !== placements.length) throw new Error("a line is placed twice");
  await changeComicPage(store, productionId, pageId, (record) => {
    const { placedByArke, ...rest } = record;
    return withdrawFinished({ ...rest, placements: [...placements], ...(placedByArke !== undefined && !undoesPlacing ? { placedByArke } : {}) });
  });
}

/**
 * Accept page (R-48a): the one image Pages flattened, filed and made the page, in place of any
 * finished image before it. Refused unless it is of the page as it stands now.
 */
export async function finishComicPage(store: WorldStore, productionId: string, pageId: string, input: { hash: string; jpeg: Uint8Array; requestId: string }, at: string): Promise<void> {
  const production = graphicNovel(store, productionId);
  const found = findComicPage(production, pageId);
  if (!found) throw new Error("that page is no longer in the script");
  const settings = production.comic ?? DEFAULT_COMIC_SETTINGS;
  if (input.hash !== comicPageHash(found.page, settings, "overlay")) throw new Error("the script changed while the page was being finished; accept it again");
  if (input.jpeg[0] !== 0xff || input.jpeg[1] !== 0xd8) throw new Error("that is not a finished page");
  if (!comicPageFinishable(found.page, comicPageRecord(production, pageId), settings)) throw new Error("a panel is not accepted or a line is not placed");
  const staging = join(store.dir, ".staging", "comic-finish");
  await mkdir(toExtendedLength(staging), { recursive: true });
  const source = join(staging, `${productionId}-page-${found.number}-${input.requestId}.jpg`);
  await writeFile(toExtendedLength(source), input.jpeg);
  try {
    const filed = await fileArtifact(store, { sourcePath: source, production: productionId });
    if (filed.outcome !== "filed" && filed.outcome !== "deduplicated") throw new Error(filed.reason);
    await changeComicPage(store, productionId, pageId, (record) => {
      const page = findComicPage(graphicNovel(store, productionId), pageId)?.page;
      if (!page || !comicPageFinishable(page, record, settings)) throw new Error("a panel is not accepted or a line is not placed");
      const take: ComicPageTake = { id: ulid(), artifact: filed.artifact.id, hash: input.hash, mode: "overlay", model: "arke-compile", language: settings.language, at };
      const kept = withdrawFinished(record);
      return { ...kept, takes: [...kept.takes.filter((entry) => entry.mode !== "overlay"), take], accepted: { ...kept.accepted, [settings.language]: take.id } };
    });
  } finally {
    await rm(toExtendedLength(source), { force: true }).catch(() => {});
  }
}

/**
 * Arke's placing of one page (R-39a): it looks at each panel holding unplaced lines and says where
 * they go. Kept beside what the author placed, with what stood before it, for one Undo. Lines it
 * gave no place stay unplaced rather than being put anywhere.
 */
export async function placeComicPage(store: WorldStore, productionId: string, pageId: string, placer: PagePlacer, signal: AbortSignal, at: () => string): Promise<number> {
  const production = graphicNovel(store, productionId);
  const found = findComicPage(production, pageId);
  if (!found) return 0;
  const settings = production.comic ?? DEFAULT_COMIC_SETTINGS;
  const record = comicPageRecord(production, pageId);
  const bundle = store.getBundle();
  const aspect = pageAspect(found.page, settings);
  const taken = new Set(record.placements.map((entry) => entry.item));
  const name = (id: string) => bundle.sheets.find((sheet) => sheet.id === id)?.name ?? id;
  const placed: LetteringPlacement[] = [];
  for (const state of comicPanelStates(found.page, record, settings)) {
    const lines = state.panel.lettering.filter((item) => !taken.has(item.id));
    if (lines.length === 0) continue;
    const own = state.accepted && bundle.artifacts.find((candidate) => candidate.id === state.accepted!.artifact);
    const picture = own ? await pictureBytes(store, `artifacts/${own.file}`) : null;
    if (picture === null) throw new Error(`panel ${state.index + 1} is not accepted yet`);
    const answer = await placer.place({ picture, description: state.panel.description, lines: lines.map((item) => ({ id: item.id, kind: item.kind, ...(item.speaker ? { speaker: name(item.speaker) } : {}), text: item.text })) }, signal);
    // The art's own edge, not the layout's: a box held to the layout's rect sat across the gutter in round 95.
    const art = panelInset(state.rect, aspect);
    const faces = answer.faces.map((face) => ({ x: art.x + face.x * art.w, y: art.y + face.y * art.h, w: face.w * art.w, h: face.h * art.h }));
    const boxes: PageBox[] = [];
    for (const item of lines) {
      const spot = answer.lines.find((entry) => entry.item === item.id);
      if (!spot) continue;
      const box = clearOfFaces(balloonBox(item, art, aspect, spot, boxes), faces, boxes, art);
      boxes.push(box);
      const tail = SPOKEN_KINDS.has(item.kind) && spot.tail ? tailClearOfFaces(box, { x: art.x + spot.tail.x * art.w, y: art.y + spot.tail.y * art.h }, faces, art) : undefined;
      placed.push({ item: item.id, box, ...(tail ? { tail } : {}) });
    }
  }
  if (placed.length === 0) return 0;
  let kept = 0;
  await changeComicPage(store, productionId, pageId, (current) => {
    // A line the author placed while Arke was looking stays where they put it.
    const held = new Set(current.placements.map((entry) => entry.item));
    const fresh = placed.filter((entry) => !held.has(entry.item));
    kept = fresh.length;
    return fresh.length === 0 ? current : withdrawFinished({ ...current, placements: [...current.placements, ...fresh], placedByArke: { at: at(), lines: fresh.length, before: current.placements } });
  });
  return kept;
}

/**
 * The cold read of Arke's drafted pages (R-64 – R-66, turn 254d): the draft is offered with the
 * reader's questions on it, and the author judges them. It used to be refused once, telling Arke to
 * answer every question on the page. A reader who has only the pages cannot tell a gap from what the
 * book holds back, so Dumah's chapter 1 (4 November 2026) was given a caption naming Brackus a Celestial,
 * a chapter 6 reveal, and the refusal's one pass was spent whenever a later check lost the redraft.
 * Anything Arke wrote in `read` is replaced: the read is the studio's.
 */
export async function readComicDrafts(
  store: WorldStore,
  turn: { actions: readonly unknown[]; receipts?: readonly WorldChatCheckReceipt[] },
  reader: ScriptReader | null,
  signal: AbortSignal,
  at: () => string,
): Promise<void> {
  for (const raw of turn.actions) {
    const action = raw as { kind?: string; productionId?: string; chapter?: string; pages?: DraftComicPage[]; plan?: unknown; read?: unknown; checkReceiptIds?: string[] };
    if (action.kind !== "production-comic-script") continue;
    delete action.read;
    repairCitedReads(action, turn.receipts ?? []);
    if (action.plan !== undefined || !action.pages?.length || !action.productionId || !action.chapter) continue;
    const production = store.getBundle().productions.find((candidate) => candidate.meta.id === action.productionId);
    const chapter = production?.chapters.find((candidate) => candidate.id === action.chapter);
    if (!production || !chapter) continue;
    if (reader === null) { action.read = { status: "not-read", reason: "no-reader", detail: "no harness is ready to read", at: at() }; continue; }
    const bundle = store.getBundle();
    const name = (id: string) => bundle.sheets.find((sheet) => sheet.id === id)?.name ?? id;
    // The pages before it as the reader met them: the kept pages of every earlier chapter, never the prose.
    const before = production.chapters.filter((candidate) => candidate.retired !== true && candidate.order < chapter.order).sort((a, b) => a.order - b.order)
      .flatMap((candidate) => {
        const pages = production.comicScripts?.find((entry) => entry.chapter === candidate.id)?.script.pages ?? [];
        return pages.length ? [pagesForReading(pages, name, (index) => `${candidate.title}, page ${index + 1}`)] : [];
      }).join("\n");
    let answer: Awaited<ReturnType<ScriptReader["read"]>>;
    try {
      // The plan's kept mysteries go to the reader, so it does not count them as faults (turn 256c).
      const mysteries = production.comicScripts?.find((entry) => entry.chapter === chapter.id)?.script.plan?.mysteries ?? [];
      answer = await reader.read({ before, draft: pagesForReading(action.pages, name, (index) => `Page ${index + 1}`), mysteries }, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      action.read = { status: "not-read", reason: "reader-failed", detail: (err instanceof Error ? err.message : String(err)).slice(0, 400), at: at() };
      continue;
    }
    action.read = { status: "read", reader: answer.reader, findings: answer.findings, redrafts: 0, at: at() };
  }
}

/**
 * Repair before reporting (design turn 256): a comic draft that cites a search where its read of the
 * production belongs is given the turn's own complete read instead. Arke cited a search receipt twice
 * in the owner's runs of 1 November 2026, and the corrective attempt cited it again, so the plan and
 * the draft were lost. Only a read this turn really made is cited; with none, the refusal stands.
 */
function repairCitedReads(action: { productionId?: string; checkReceiptIds?: string[] }, receipts: readonly WorldChatCheckReceipt[]): void {
  const reads = receipts.filter((receipt) => receipt.tool === "target-read" && receipt.complete === true && receipt.nextCursor === null
    && (receipt.status === "complete" || receipt.status === "empty") && receipt.target?.requirement === "production-metadata" && receipt.target.id === action.productionId);
  const cited = action.checkReceiptIds ?? [];
  if (reads.length === 0 || cited.some((id) => reads.some((read) => read.id === id))) return;
  const kept = cited.filter((id) => receipts.some((receipt) => receipt.id === id && receipt.tool === "target-read"));
  action.checkReceiptIds = [...kept, reads.at(-1)!.id];
}
