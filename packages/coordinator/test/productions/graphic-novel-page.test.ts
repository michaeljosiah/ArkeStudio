import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { comicPageHash, ulid, type ComicPage, type DomainEvent, type ManifestModel } from "@arke-studio/contracts";
import { createChapter, createProduction } from "../../src/productions/ops.js";
import { changeComicPage, saveComicScript } from "../../src/productions/graphic-novel.js";
import { IMAGE, WORLD_ID, withHarness, type Harness } from "./picture-harness.js";

/**
 * A comic page made (SPEC-064 slice 2): one generation through the Bench, priced before the press,
 * its brief the page's own — never the audiobook's "no text" lines — and filed as a take beside any
 * accepted one. A page admitted before a restart is filed from its session, not asked again.
 */
type Quote = Extract<DomainEvent, { type: "comic.page-quote" }>;
type Made = Extract<DomainEvent, { type: "comic.page-made" }>;

const LETTERER: ManifestModel = { ...IMAGE, id: "letterer", displayName: "Letterer", limits: { aspects: ["2:3", "1:1"], maxPromptChars: 8000, lettering: true } };
let n = 0;
const rid = () => `01J0000000000000000002${String((n += 1)).padStart(4, "0")}`;

async function book(h: Harness): Promise<{ production: string; page: ComicPage }> {
  const store = h.store()!;
  const production = await createProduction(store, { title: "Low Water, drawn", medium: "story", productionKind: "graphic-novel" });
  const chapter = await createChapter(store, production, { title: "The tide", order: 1 });
  const page: ComicPage = {
    id: ulid(), layout: "grid-2x2", status: "ready",
    panels: [{ id: ulid(), description: "Maren on the rail at dawn.", characters: ["maren-kest"], lettering: [{ id: ulid(), kind: "speech", speaker: "maren-kest", text: "Where are you?" }] }],
  };
  await saveComicScript(store, production, { chapter, pages: [page], baseHash: null });
  return { production, page };
}
const last = <T extends DomainEvent["type"]>(events: DomainEvent[], type: T) => events.filter((event): event is Extract<DomainEvent, { type: T }> => event.type === type).at(-1);

describe("a comic page made (SPEC-064 R-22 – R-27)", () => {
  it("quotes the page with its brief, then makes it on that price as a take", () =>
    withHarness(async (h) => {
      const { production, page } = await book(h);
      await h.send({ kind: "quote-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id });
      const quote = last(h.events, "comic.page-quote") as Quote;
      assert.ok(quote.quote.ok, !quote.quote.ok ? quote.quote.reason : "");
      assert.equal(quote.quote.aspect, "2:3");
      assert.match(quote.quote.brief, /lettered exactly: "Where are you\?"/);
      assert.equal(h.enqueued.length, 0, "a quote spends nothing");

      await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, confirmedMicroUsd: quote.quote.microUsd });
      const made = last(h.events, "comic.page-made") as Made;
      assert.equal(made.state, "made", made.reason);
      const job = h.enqueued.at(-1)!.params as { prompt?: string; output?: { aspect?: string } };
      assert.match(String(job.prompt), /Where are you\?/);
      assert.doesNotMatch(String(job.prompt), /No added captions/, "never the audiobook's no-text line");
      assert.equal(job.output?.aspect, "2:3");
      const record = h.store()!.getBundle().productions.find((p) => p.meta.id === production)!.comicPages![0]!.record;
      assert.equal(record.takes.length, 1);
      assert.equal(record.takes[0]!.id, made.take);
      assert.equal(record.making.length, 0);
      assert.deepEqual(record.accepted, {}, "made is not accepted");
    }, { model: LETTERER }));

  it("briefs the world's look in words, then the book's style, which a change only moves forward (R-18, R-21a)", () =>
    withHarness(async (h) => {
      const { production, page } = await book(h);
      const brief = async () => {
        await h.send({ kind: "quote-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id });
        const quote = last(h.events, "comic.page-quote") as Quote;
        assert.ok(quote.quote.ok, !quote.quote.ok ? quote.quote.reason : "");
        return quote.quote;
      };
      const before = await brief();
      const look = h.store()!.getBundle().artDirection.description;
      assert.ok(before.brief.includes(`Look: ${look.replace(/\s+/g, " ").trim()}`), "the look's words, not its picture's path");
      assert.doesNotMatch(before.brief, /\.png|Style:/);
      await h.send({ kind: "set-comic-settings", worldId: WORLD_ID, productionId: production, settings: { style: { words: "Crime noir comic: solid black shapes and stark white.", preset: "noir" } } });
      const after = await brief();
      assert.match(after.brief, /Look: [^\n]+\n\nStyle: Crime noir comic: solid black shapes and stark white\./);
      // A style is not the page's picture: a take made before it is still the page's (R-21a).
      const settings = h.store()!.getBundle().productions.find((p) => p.meta.id === production)!.comic!;
      const { style: _style, ...unstyled } = settings;
      assert.equal(comicPageHash(page, settings, "baked"), comicPageHash(page, unstyled, "baked"));
    }, { model: LETTERER }));

  it("refuses baked lettering on a model that does not letter, and a price that moved", () =>
    withHarness(async (h) => {
      const { production, page } = await book(h);
      await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, confirmedMicroUsd: 1_000_000 });
      assert.match((last(h.events, "comic.page-made") as Made).reason ?? "", /does not letter/);
      assert.equal(h.enqueued.length, 0);
    }, { model: { ...LETTERER, limits: { aspects: ["2:3"] } } }));

  it("refuses a confirmed price below the plan", () =>
    withHarness(async (h) => {
      const { production, page } = await book(h);
      await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, confirmedMicroUsd: 1 });
      assert.match((last(h.events, "comic.page-made") as Made).reason ?? "", /price moved/);
      assert.equal(h.enqueued.length, 0);
    }, { model: LETTERER }));

  it("refuses art without lettering: this version letters every page in the picture (turn 247)", () =>
    withHarness(async (h) => {
      const { production, page } = await book(h);
      await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, mode: "overlay", confirmedMicroUsd: 1_000_000 });
      assert.equal((last(h.events, "comic.page-made") as Made).reason, "pages are lettered in the picture");
      assert.equal(h.enqueued.length, 0);
    }, { model: LETTERER }));

  it("files a page that landed while nobody waited, once, when the page is next opened", () =>
    withHarness(async (h) => {
      const { production, page } = await book(h);
      await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, confirmedMicroUsd: 1_000_000 });
      const store = h.store()!;
      const made = store.getBundle().productions.find((p) => p.meta.id === production)!.comicPages![0]!.record.takes[0]!;
      // As if the app had closed after the session opened: the take is gone from the record and the
      // admission is still written, naming its session.
      const done = last(h.events, "comic.page-made") as Made;
      const session = done.sessionId!;
      await changeComicPage(store, production, page.id, (record) => ({ ...record, takes: [],
        making: [{ requestId: done.requestId, hash: made.hash, mode: made.mode, model: made.model, language: made.language, at: made.at, session }] }));
      await h.send({ kind: "quote-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id });
      await h.send({ kind: "quote-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id });
      const record = store.getBundle().productions.find((p) => p.meta.id === production)!.comicPages![0]!.record;
      assert.equal(record.making.length, 0);
      assert.equal(record.takes.length, 1, "filed once");
      assert.equal(record.takes[0]!.artifact, made.artifact, "the same picture, not a new one");
      assert.equal(h.enqueued.length, 1, "nothing asked again");
      // And read, as a made take is: filed with no verdict, Pages said Checking over a take nothing
      // was reading (2026-10-30).
      const filed = record.takes[0]!.id;
      for (let i = 0; i < 100 && !h.events.some((event) => event.type === "comic.page-made" && event.take === filed && event.state === "made"); i++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(store.getBundle().productions.find((p) => p.meta.id === production)!.comicPages![0]!.record.takes[0]!.verification?.status, "unavailable", "no reader here: not checked, never a pass");
      const said = h.events.filter((event): event is Made => event.type === "comic.page-made" && event.take === filed).map((event) => event.state);
      assert.deepEqual(said, ["checking", "made"]);
    }, { model: LETTERER }));

  it("files a page that lands after its press stopped waiting, with nobody opening it", () =>
    withHarness(async (h) => {
      const { production, page } = await book(h);
      const store = h.store()!;
      const record = () => store.getBundle().productions.find((p) => p.meta.id === production)!.comicPages![0]!.record;
      await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, confirmedMicroUsd: 1_000_000 });
      assert.equal((last(h.events, "comic.page-made") as Made).reason, "the picture took too long");
      assert.equal(record().making.length, 1, "still queued: the admission stays");
      // Codex answers long after the wait: no quote, no page opened.
      await h.landHeld(0);
      for (let i = 0; i < 150 && record().takes.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(record().takes.length, 1, "filed by the late look");
      assert.equal(record().making.length, 0);
      assert.equal(h.enqueued.length, 1, "nothing asked again");
      const filed = record().takes[0]!.id;
      for (let i = 0; i < 100 && !h.events.some((event) => event.type === "comic.page-made" && event.take === filed && event.state === "made"); i++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(h.events.filter((event): event is Made => event.type === "comic.page-made" && event.take === filed).map((event) => event.state), ["checking", "made"], "and read, as an opened page's is");
    }, { model: LETTERER, land: false, pictureWait: { waitMs: 50, lateLookMs: 20 } }));
});
