import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  COMIC_PROMPT_MAX, ComicPageRecordSchema, ComicScriptSchema, ComicSettingsSchema, DEFAULT_COMIC_SETTINGS, EMPTY_COMIC_PAGE_RECORD,
  comicPageHash, comicPagePrompt, makesShape, pageAspect, pictureQuote, productionShape,
  type ComicCited, type ComicMode, type ComicPage, type ComicPageRecord, type ComicSettings, type ManifestModel, type PictureWho, type ProductionBundle,
} from "@arke-studio/contracts";
import { pictureWho } from "./audiobook-picture-suggest.js";
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
  const record = ComicScriptSchema.parse({ version: 1, pages: input.pages });
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
export async function setComicSettings(store: WorldStore, productionId: string, change: Partial<Omit<ComicSettings, "version">>): Promise<ComicSettings> {
  graphicNovel(store, productionId);
  const path = `productions/${productionId}/comic.json`;
  return oneAtATime(`${store.dir}/${path}`, async () => {
    const live = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8").catch(() => null);
    const current = live === null ? DEFAULT_COMIC_SETTINGS : ComicSettingsSchema.parse(JSON.parse(live));
    const next = ComicSettingsSchema.parse({ ...current, ...change });
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
  const { page } = found;
  if (page.panels.length === 0) return { ok: false, reason: "the page has no panels" };
  // Baked lettering only on a model whose vendor says it letters (R-24); overlay art takes any.
  if (mode === "baked" && model.limits.lettering !== true) return { ok: false, reason: `${model.displayName} does not letter pages; make it without lettering` };
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
  const look = bundle.artDirection?.masterLook;
  const prompt = (cited: readonly ComicCited[]) => comicPagePrompt({ page, settings, mode, ...(look ? { look } : {}), names, cited });
  const longest = prompt(who.filter((entry) => entry.carried && entry.reference !== null).map((entry, index) => ({ name: entry.name, kind: entry.kind, token: `ref${index + 1}` })));
  const bound = Math.min(COMIC_PROMPT_MAX, model.limits.maxPromptChars ?? COMIC_PROMPT_MAX);
  if (longest.length > bound) return { ok: false, reason: `the page brief is ${longest.length} characters; ${model.displayName} takes ${bound}` };
  const riding = who.filter((entry) => entry.carried && entry.reference !== null).length;
  return { ok: true, page, number: found.number, settings, mode, hash: comicPageHash(page, settings, mode), aspect, who, prompt, microUsd: pictureQuote(model, riding, aspect), missing };
}
