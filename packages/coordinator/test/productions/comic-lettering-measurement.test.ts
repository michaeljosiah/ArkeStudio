import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_COMIC_SETTINGS, EMPTY_COMIC_PAGE_RECORD, comicPageHash, compareLettering, type ComicPage, type ComicPageTake } from "@arke-studio/contracts";
import { measureComicLettering, summarizeComicLettering } from "../../../../scripts/measure-comic-lettering.mjs";
import { tempDir } from "../tmp.js";

const id = (n: number) => `01J${String(n).padStart(23, "0")}`;
const settings = DEFAULT_COMIC_SETTINGS;
const page: ComicPage = { id: id(1), layout: "full", status: "draft", panels: [{ id: id(2), description: "A lamp.", characters: [],
  lettering: [{ id: id(3), kind: "caption", text: "The lamp stayed lit." }] }] };
const at = "2026-11-01T00:00:00.000Z";
const check = compareLettering({ page, reading: "ltr", regions: [{ text: "The lamp stayed lit." }], thresholds: settings.thresholds,
  reader: { id: "fixture", version: "1" }, at });
const take = (n: number, over: Partial<ComicPageTake> = {}): ComicPageTake => ({ id: id(10 + n), artifact: `ar_${id(20 + n)}`, hash: comicPageHash(page, settings, "baked"),
  mode: "baked", model: "fixture-image", language: "en", at, verification: check, ...over });
const summary = (takes: ComicPageTake[]) => summarizeComicLettering([{ page, settings, record: { ...EMPTY_COMIC_PAGE_RECORD, takes } }], "fixture-image", "en");

it("does not count unavailable checks or an override as a successful first take", () => {
  const result = summary([take(1, { verification: { status: "unavailable", reason: "reader-failed", at }, override: { at, findings: [] } }), take(2)]);
  assert.equal(result.observed.firstRetainedPasses, 0);
  assert.equal(result.observed.withinThreeRetainedPasses, 1);
  assert.equal(result.qualification, "not-established");
});

it("excludes other scripts, languages and models and never moves a fourth success into three attempts", () => {
  const failed = { status: "unavailable" as const, reason: "no-reader" as const, at };
  const result = summary([take(0, { hash: "old" }), take(1, { model: "other" }), take(2, { language: "fr" }),
    take(3, { verification: failed }), take(4, { verification: failed }), take(5, { verification: failed }), take(6)]);
  assert.equal(result.observed.withinThreeRetainedPasses, 0);
  assert.equal(result.pages[0]!.otherTakes, 3);
  assert.equal(result.pages[0]!.matchingTakes, 4);
});

it("retains ungenerated pages in the denominator and never qualifies an empty or successful historical sample", () => {
  const empty = summarizeComicLettering([], "fixture-image", "en");
  assert.equal(empty.observed.firstRetainedRate, null);
  assert.equal(empty.observed.targetsMet, false);
  const missing = summarizeComicLettering([{ page, settings, record: null }], "fixture-image", "en");
  assert.equal(missing.observed.pages, 1);
  assert.equal(missing.observed.withinThreeRetainedRate, 0);
  assert.equal(summary([take(1)]).qualification, "not-established");
});

it("reads portable records without modifying them and excludes pages outside the proposed lettering range", async () => {
  const directory = await tempDir("comic-measurement-");
  await mkdir(join(directory, "comic"));
  await mkdir(join(directory, "comic-pages"));
  const unlettered = { ...page, id: id(40), panels: [{ ...page.panels[0]!, id: id(41), lettering: [] }] };
  const files = {
    "comic.json": JSON.stringify(settings),
    "comic/chapter.json": JSON.stringify({ version: 1, pages: [page, unlettered] }),
    [`comic-pages/${page.id}.json`]: JSON.stringify({ ...EMPTY_COMIC_PAGE_RECORD, takes: [take(1)] }),
  };
  for (const [file, bytes] of Object.entries(files)) await writeFile(join(directory, file), bytes);
  const result = await measureComicLettering([directory, directory], "fixture-image");
  assert.equal(result.observed.pages, 1);
  assert.equal(result.observed.excludedPages, 1);
  assert.equal(result.observed.firstRetainedPasses, 1);
  assert.equal(result.sourceDigest.length, 64);
  for (const [file, bytes] of Object.entries(files)) assert.equal(await readFile(join(directory, file), "utf8"), bytes);
});
