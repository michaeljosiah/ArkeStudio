import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ulid, type ComicPage, type DomainEvent, type ManifestModel } from "@arke-studio/contracts";
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

  it("makes art without lettering on any model, leaving space for the balloons", () =>
    withHarness(async (h) => {
      const { production, page } = await book(h);
      await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, mode: "overlay", confirmedMicroUsd: 1_000_000 });
      assert.equal((last(h.events, "comic.page-made") as Made).state, "made");
      const prompt = String((h.enqueued.at(-1)!.params as { prompt?: string }).prompt);
      assert.doesNotMatch(prompt, /Where are you/);
      assert.match(prompt, /Draw no lettering/);
    }, { model: { ...LETTERER, limits: { aspects: ["2:3"] } } }));

  it("files a page that landed while nobody waited, once, when the page is next opened", () =>
    withHarness(async (h) => {
      const { production, page } = await book(h);
      await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, confirmedMicroUsd: 1_000_000 });
      const store = h.store()!;
      const made = store.getBundle().productions.find((p) => p.meta.id === production)!.comicPages![0]!.record.takes[0]!;
      // As if the app had closed after the session opened: the take is gone from the record and the
      // admission is still written, naming its session.
      const session = (last(h.events, "comic.page-made") as Made).sessionId!;
      await changeComicPage(store, production, page.id, (record) => ({ ...record, takes: [],
        making: [{ requestId: rid(), hash: made.hash, mode: made.mode, model: made.model, language: made.language, at: made.at, session }] }));
      await h.send({ kind: "quote-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id });
      await h.send({ kind: "quote-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id });
      const record = store.getBundle().productions.find((p) => p.meta.id === production)!.comicPages![0]!.record;
      assert.equal(record.making.length, 0);
      assert.equal(record.takes.length, 1, "filed once");
      assert.equal(record.takes[0]!.artifact, made.artifact, "the same picture, not a new one");
      assert.equal(h.enqueued.length, 1, "nothing asked again");
    }, { model: LETTERER }));
});
