import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ComicPageRecordSchema, ComicScriptSchema, ComicSettingsSchema, comicPageHash, takePasses,
  type ComicPage, type ComicPageRecord, type ComicSettings,
} from "../packages/contracts/src/index.js";

type PageCase = { page: ComicPage; settings: ComicSettings; record: ComicPageRecord | null };
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

/** Existing receipts are observations, not proof of a model's first-generation success rate. */
export function summarizeComicLettering(cases: readonly PageCase[], model: string, language: string) {
  const readers = new Set<string>();
  const rules = new Set<string>();
  const pages = cases.map(({ page, settings, record }) => {
    const letteringItems = page.panels.reduce((count, panel) => count + panel.lettering.length, 0);
    const scriptHash = comicPageHash(page, settings, "baked");
    const matching = (record?.takes ?? []).filter(take => take.hash === scriptHash && take.mode === "baked" && take.model === model && take.language === language);
    // Keep durable order. Sorting by time or accepted status can move a later success first.
    const attempts = matching.slice(0, 3).map(take => {
      const check = take.verification;
      if (check?.status === "compared") {
        readers.add(`${check.reader.id}/${check.reader.version}`);
        rules.add(JSON.stringify({ normalization: check.normalizationVersion, thresholds: check.thresholds }));
      }
      return { take: take.id, artifact: take.artifact, checkedAt: check?.at ?? null,
        status: check?.status ?? "not-checked", passes: takePasses(check), override: take.override !== undefined };
    });
    const eligible = letteringItems >= 1 && letteringItems <= 8;
    return { page: page.id, scriptHash, letteringItems, eligible, attempts,
      firstRetainedPass: eligible && attempts[0]?.passes === true,
      withinThreeRetainedPass: eligible && attempts.some(attempt => attempt.passes),
      matchingTakes: matching.length, otherTakes: (record?.takes.length ?? 0) - matching.length,
      pending: (record?.making ?? []).filter(run => run.hash === scriptHash && run.mode === "baked" && run.model === model && run.language === language).length };
  });
  const eligible = pages.filter(page => page.eligible);
  const first = eligible.filter(page => page.firstRetainedPass).length;
  const withinThree = eligible.filter(page => page.withinThreeRetainedPass).length;
  return { version: 1, model, language, qualification: "not-established" as const,
    basis: "Saved lettering-check receipts for current scripts; not a prospective generation trial or an independent image assessment.",
    limitations: ["Failed or removed generations may be absent; retained takes do not prove first-generation success.",
      "A check may have been replaced by a later recheck. Model aliases may change upstream.",
      "Image integrity, speaker attribution, visual quality and reader accuracy are not measured here.",
      "Overrides do not turn failed or unavailable checks into passes. No model default is qualified by this report."],
    targets: { firstTake: .85, withinThree: .95, maximumLetteringItems: 8 },
    observed: { pages: eligible.length, excludedPages: pages.length - eligible.length,
      firstRetainedPasses: first, withinThreeRetainedPasses: withinThree,
      firstRetainedRate: eligible.length ? first / eligible.length : null,
      withinThreeRetainedRate: eligible.length ? withinThree / eligible.length : null,
      targetsMet: eligible.length > 0 && first / eligible.length >= .85 && withinThree / eligible.length >= .95 },
    readers: [...readers].sort(), comparisonRules: [...rules].sort(), pages };
}

/** Read only the comic documents. No WorldStore, ownership claim, repair, model call or write. */
export async function measureComicLettering(directories: readonly string[], model: string, language = "en") {
  if (!directories.length || !model.trim() || !language.trim()) throw new Error("A model, language and at least one production folder are required.");
  const cases: PageCase[] = [];
  const sources: Array<{ file: string; digest: string | null }> = [];
  const collections: Array<{ folder: string; files: string[] }> = [];
  const read = async (file: string, optional = false): Promise<string | null> => {
    let text: string | null;
    try { text = await readFile(file, "utf8"); }
    catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") text = null; else throw error; }
    sources.push({ file, digest: text === null ? null : hash(text) });
    return text;
  };
  for (const directory of new Set(directories.map(directory => resolve(directory)))) {
    const settings = ComicSettingsSchema.parse(JSON.parse((await read(join(directory, "comic.json")))!));
    const folder = join(directory, "comic");
    const files = (await readdir(folder)).filter(file => file.endsWith(".json")).sort();
    collections.push({ folder, files });
    const ids = new Set<string>();
    for (const file of files) {
      const script = ComicScriptSchema.parse(JSON.parse((await read(join(folder, file)))!));
      for (const page of script.pages) {
        if (ids.has(page.id)) throw new Error("A page appears in more than one chapter; resolve it before measuring.");
        ids.add(page.id);
        const record = await read(join(directory, "comic-pages", `${page.id}.json`), true);
        cases.push({ page, settings, record: record === null ? null : ComicPageRecordSchema.parse(JSON.parse(record)) });
      }
    }
  }
  for (const source of sources) {
    const current = await readFile(source.file, "utf8").then(hash).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (current !== source.digest) throw new Error("Comic documents changed during measurement. Run the read-only report again.");
  }
  for (const { folder, files } of collections) {
    if (JSON.stringify((await readdir(folder)).filter(file => file.endsWith(".json")).sort()) !== JSON.stringify(files)) throw new Error("The comic chapter list changed during measurement.");
  }
  return { ...summarizeComicLettering(cases, model, language), measuredAt: new Date().toISOString(),
    sourceDigest: hash(JSON.stringify(sources.map(source => source.digest))) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [model, language, ...directories] = process.argv.slice(2);
  if (!model || !language || !directories.length) throw new Error("Usage: node --import tsx scripts/measure-comic-lettering.mts <model> <language> <production-folder> [...]");
  process.stdout.write(JSON.stringify(await measureComicLettering(directories, model, language), null, 2) + "\n");
}
