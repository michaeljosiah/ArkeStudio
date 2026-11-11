import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type { AudiobookListening, ClientMessage, ClientState, ProductionBundle, StoryExportState } from "@arke-studio/contracts";
import { seedStoryPictureTimeline } from "@arke-studio/contracts";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { ProductionPublishScreen, publishOutputs } from "../src/screens/production-publish.js";
import { publishReadiness } from "../src/lib/publish-readiness.js";
import { ulidTime } from "../src/components/production-made.js";
import { productionPages } from "../src/lib/production-navigation.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { productionsLayoutFixture } from "./productions-layout-fixture.js";

/**
 * Publish (design turn 276): one page per production, the strip's last pill, its outputs by kind as
 * cards that open the sheets that make them — over the page, or on the screen that holds the work.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1360, innerHeight: 850, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {}, showModal() {}, close() {} });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const BASE = "/w/w/p/p";
const kinded = (meta: Partial<ProductionBundle["meta"]>, chapters: ProductionBundle["chapters"] = []) =>
  ({ ...productionsLayoutFixture().world!.productions[1]!, meta: { ...productionsLayoutFixture().world!.productions[1]!.meta, ...meta }, chapters }) as ProductionBundle;
const names = (production: ProductionBundle, desktop = false) => publishOutputs(production, BASE, desktop).map((output) => output.name);

describe("Publish's outputs by kind (turn 276 rule 4)", () => {
  it("gives a book its edition, audiobook, Arke Player package and manuscript", () => {
    const book = productionsLayoutFixture().world!.productions[0]!;
    assert.deepEqual(names(book), ["Edition", "Audiobook", "Arke Player", "Manuscript"]);
  });

  it("gives a graphic novel its files and package, and the edition only once its chapters hold prose", () => {
    const comic = kinded({ format: "story", medium: "story", kind: "graphic-novel" });
    assert.deepEqual(names(comic), ["Comic files", "Arke Player"]);
    const prose = kinded({ format: "story", medium: "story", kind: "graphic-novel" }, [{ id: "c1", file: "c1", order: 1, title: "One", status: "draft", version: 1, words: 900 }] as ProductionBundle["chapters"]);
    assert.deepEqual(names(prose), ["Comic files", "Arke Player", "Edition"]);
  });

  it("sends an album's and an audio drama's cards to the screen that opens their sheet", () => {
    const album = publishOutputs(kinded({ medium: "music", kind: "album" }), BASE, false);
    assert.deepEqual(album.map((output) => [output.name, output.opens]), [["Arke Player", { to: `${BASE}?export=1` }]]);
    const drama = publishOutputs(kinded({ format: "story", medium: "story", kind: "audio-drama" }), BASE, false);
    assert.deepEqual(drama.map((output) => [output.name, output.opens]), [["Edition", { to: `${BASE}?publish=1` }]]);
  });

  it("gives a story its package and web package, and a film from the Cut only where it plays as one", () => {
    assert.deepEqual(names(kinded({ medium: "video", kind: "interactive" })), ["Arke Player", "Web package", "Film"]);
    assert.deepEqual(names(kinded({ medium: "video", kind: "visual-novel" })), ["Arke Player", "Web package"]);
    const film = publishOutputs(kinded({ medium: "video", kind: "film" }), BASE, true);
    assert.deepEqual(film.map((output) => [output.name, output.opens]), [["Film", { to: `${BASE}/cut?export=1` }], ["Playable edition", { to: `${BASE}/cut?export=1` }]]);
    assert.deepEqual(names(kinded({ medium: "video", kind: "film" }), false), ["Film"], "a playable edition is made in the desktop app only");
  });

  it("is the last page on every kind's strip", () => {
    for (const shape of [{ hasChapters: true }, { hasChapters: true, hasPages: true }, { isMusic: true }, { isAudioDrama: true }, { isEpisodic: true }, { isBranching: true }, { isBranching: true, playsAsBeats: true }, {}]) {
      const pages = productionPages({ hasChapters: false, isEpisodic: false, isBranching: false, ...shape });
      assert.deepEqual(pages.at(-1), ["publish", "Publish"]);
    }
  });
});

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  __setBridgeForTest(null);
  dom.document.body.innerHTML = "";
});

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

async function mount(state: ClientState, prodId: string) {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() { return () => {}; }, send: (json: string) => { sent.push(JSON.parse(json)); } } as unknown as ArkeBridge);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    __setStateForTest(state, { connection: "open" });
    root!.render(<MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/p/${prodId}/publish`]}>
      <Routes><Route path="*" element={<><ProductionPublishScreen /><Where /></>} />
        <Route path="/w/:worldId/p/:prodId/publish" element={<><ProductionPublishScreen /><Where /></>} /></Routes>
    </MemoryRouter>);
  });
  return { container, sent };
}

const press = async (node: Element | null | undefined) => {
  assert.ok(node);
  await act(async () => (node as unknown as HTMLButtonElement).click());
};

describe("The Publish page (276a)", () => {
  it("shows a book's four outputs on their plates, and opens its Arke Player package over the page", async () => {
    const m = await mount(productionsLayoutFixture(), "ledger");
    assert.equal(dom.document.querySelector("h1")?.textContent, "Publish");
    const cards = [...dom.document.querySelectorAll(".fy-publish-out")];
    assert.deepEqual(cards.map((card) => card.querySelector("h2")?.textContent), ["Edition", "Audiobook", "Arke Player", "Manuscript"]);
    assert.deepEqual(cards.map((card) => card.querySelector("img")?.getAttribute("src")), ["./publish/edition.webp", "./publish/audiobook.webp", "./publish/player.webp", "./publish/manuscript.webp"]);
    await press(cards[2]!.querySelector("button"));
    assert.ok(dom.document.querySelector('[data-testid="arke-player-sheet"]'), "the Arke Player sheet opens, a sheet of its own");
    assert.equal(dom.document.querySelector(".fy-abv-kinds"), null, "not Export audiobook's kinds");
    assert.equal(dom.document.querySelector('[data-testid="where"]')?.textContent, `/w/${FIXTURE_WORLD_ID}/p/ledger/publish`, "over the page, not elsewhere");
    assert.ok(m.sent.some((message) => message.kind === "open-audiobook-listening"), "it reads the listening plan, as from the Audiobook page");
  });

  it("opens a film's Cut with its export sheet up", async () => {
    await mount(productionsLayoutFixture(), "saltlight");
    const cards = [...dom.document.querySelectorAll(".fy-publish-out")];
    assert.equal(cards[0]!.querySelector("h2")?.textContent, "Film");
    await press([...cards[0]!.querySelectorAll("button")].find((button) => button.textContent === "Export"));
    assert.equal(dom.document.querySelector('[data-testid="where"]')?.textContent, `/w/${FIXTURE_WORLD_ID}/p/saltlight/cut?export=1`);
  });
});

describe("Each card's readiness (turn 276 rule 5, 276b)", () => {
  const state = productionsLayoutFixture();
  const world = state.world!;
  const book = world.productions[0]!;
  const film = world.productions[1]!;
  const listening = (states: Array<"read" | "unread">) => ({ chapters: states.map((read, i) => ({ chapterId: `chapter-${i + 1}`, state: read, blocks: read === "read" ? [{}] : [] })) }) as unknown as AudiobookListening;

  it("reads a book from its chapters, and its narration from the listening plan", () => {
    assert.deepEqual(publishReadiness("edition", world, book, {}), { ready: true, fact: "4 chapters" });
    assert.deepEqual(publishReadiness("manuscript", world, book, {}), { ready: true, fact: "8,000 words" });
    assert.equal(publishReadiness("audiobook", world, book, {}), null, "still asked for");
    assert.deepEqual(publishReadiness("audiobook", world, book, { listening: listening(["unread", "unread"]) }), { ready: false, count: 1, first: "no chapter read whole", go: { path: "story/audiobook" } });
    assert.deepEqual(publishReadiness("audiobook", world, book, { listening: listening(["read", "read", "unread"]) }), { ready: true, fact: "2 of 4 read whole" });
    assert.deepEqual(publishReadiness("book-player", world, book, { listening: listening(["unread"]) }), { ready: true, fact: "4 chapters · 0 read whole" }, "the book goes without narration");
  });

  it("holds a story's package and web package on its export state's blockers, the first with its scene", () => {
    assert.equal(publishReadiness("story-player", world, film, {}), null);
    const blocked = { scenes: 3, endings: 1, blockers: [{ detail: "Scene 2 · no clip", row: "media", sceneId: "sc_2" }, { detail: "A dead end", row: "story" }] } as unknown as StoryExportState;
    assert.deepEqual(publishReadiness("story-player", world, film, { story: blocked }), { ready: false, count: 2, first: "Scene 2 · no clip", go: { scene: "sc_2" } });
    assert.deepEqual(publishReadiness("web", world, film, { story: blocked }), { ready: false, count: 2, first: "Scene 2 · no clip", go: { scene: "sc_2" } }, "a web package ships the footage too");
    assert.deepEqual(publishReadiness("story-player", world, film, { story: { ...blocked, blockers: [] } }), { ready: true, fact: "3 scenes · 1 ending" });
  });

  it("says what is missing for a comic, an album and a film, with where it is cleared", () => {
    const comic = { ...film, meta: { ...film.meta, kind: "graphic-novel" }, comicScripts: [] } as ProductionBundle;
    assert.deepEqual(publishReadiness("comic", world, comic, {}), { ready: false, count: 1, first: "no pages yet", go: { path: "story/pages" } });
    assert.deepEqual(publishReadiness("music-player", world, film, {}), { ready: false, count: 1, first: "no tracks yet", go: { path: "" } });
    assert.deepEqual(publishReadiness("film", world, { ...film, timeline: undefined } as ProductionBundle, {}), { ready: false, count: 1, first: "nothing in the cut", go: { path: "cut" } });
  });

  it("holds a playable edition where its own planner refuses, though the film exports (codex on PR 2981)", () => {
    const cut = { ...film, timeline: { status: "ready", timeline: seedStoryPictureTimeline(film) } } as ProductionBundle;
    assert.deepEqual(publishReadiness("film", world, cut, {}), { ready: true, fact: "2 clips in the cut" }, "the film exports a slate where a picture is missing");
    assert.deepEqual(publishReadiness("playable", world, cut, {}), { ready: false, count: 1, first: "missing picture: SHOT 13 · The lamps answer · 6.0s", go: { path: "cut" } });
  });
});

describe("Readiness on the page (276a, 276b)", () => {
  it("asks for the book's listening plan, shows each card's line, and Go to opens where it is cleared", async () => {
    const m = await mount(productionsLayoutFixture(), "ledger");
    const line = (name: string) => [...dom.document.querySelectorAll(".fy-publish-out")].find((card) => card.querySelector("h2")?.textContent === name)!;
    assert.match(line("Edition").textContent ?? "", /Ready4 chapters/);
    assert.match(line("Audiobook").textContent ?? "", /…/, "asked for, not yet answered");
    const asked = m.sent.filter((message) => message.kind === "open-audiobook-listening").at(-1) as Extract<ClientMessage, { kind: "open-audiobook-listening" }>;
    assert.ok(asked);
    await act(async () => __applyEventForTest({ at: "2026-11-11T12:00:00.000Z", type: "audiobook.listening", requestId: asked.requestId, worldId: FIXTURE_WORLD_ID, productionId: "ledger", listening: null }));
    assert.match(line("Audiobook").textContent ?? "", /Blocked · 1no chapter read wholeGo to/);
    await press([...line("Audiobook").querySelectorAll("button")].find((button) => button.textContent === "Go to"));
    assert.equal(dom.document.querySelector('[data-testid="where"]')?.textContent, `/w/${FIXTURE_WORLD_ID}/p/ledger/story/audiobook`);
  });
});

describe("Made (turn 276 rule 6, 276a)", () => {
  it("reads an export's date from its id's ULID", () => {
    assert.equal(ulidTime("ms_01J8F3K2QW9VZX4N7M0RTYB6HC"), new Date(ulidMs("01J8F3K2QW")).toISOString());
    assert.equal(ulidTime("ms_nope"), null);
  });

  it("lists every file the production made, newest first, and says when there is none", async () => {
    const m = await mount(productionsLayoutFixture(), "ledger");
    assert.match(dom.document.querySelector(".fy-publish-made")?.textContent ?? "", /…/, "asked for, not yet answered");
    const asked = m.sent.filter((message) => message.kind === "list-web-packages").at(-1) as Extract<ClientMessage, { kind: "list-web-packages" }>;
    assert.ok(asked, "it lists the world's packages");
    assert.ok(m.sent.some((message) => message.kind === "list-story-publications"), "and the story editions");
    assert.ok(m.sent.some((message) => message.kind === "list-drama-editions"), "and the drama editions");
    await act(async () => __applyEventForTest({ at: "2026-11-11T12:00:00.000Z", type: "web-packages.listed", requestId: asked.requestId, worldId: FIXTURE_WORLD_ID, packages: [] }));
    assert.match(dom.document.querySelector(".fy-publish-made")?.textContent ?? "", /Nothing made yet\./);
    assert.match(dom.document.querySelector(".fy-h1row")?.textContent ?? "", /4 outputs · nothing made/);
    await act(async () => __applyEventForTest({ at: "2026-11-11T12:00:00.000Z", type: "web-packages.listed", requestId: asked.requestId, worldId: FIXTURE_WORLD_ID, packages: [
      { kind: "audiobook", productionId: "ledger", title: "The Ledger of Nights", dir: "exports/ledger-player", exportedAt: "2026-10-19T09:00:00.000Z" },
      { kind: "arke-player", productionId: "ledger", title: "The Undersong", dir: "exports/the-undersong-player-2026-11-11.zip", file: "exports/the-undersong-player-2026-11-11.zip", exportedAt: "2026-11-11T09:00:00.000Z", bytes: 263 * 1024 ** 2, sha256: "a".repeat(64), holds: "16 chapters · the book" },
      { kind: "arke-player", productionId: "saltlight", title: "Another production", dir: "exports/salt.zip", exportedAt: "2026-11-11T10:00:00.000Z" },
      { kind: "comic", productionId: "ledger", title: "The Ledger of Nights", dir: "exports/ledger-comic-2026-11-10.cbz", file: "exports/ledger-comic-2026-11-10.cbz", exportedAt: "2026-11-10T09:00:00.000Z", bytes: 12 * 1024 ** 2, holds: "CBZ" },
    ] }));
    const rows = [...dom.document.querySelectorAll('[data-testid="made-row"]')].map((row) => row.textContent);
    assert.equal(rows.length, 3, "this production's alone");
    assert.match(rows[0]!, /^Arke PlayerPackage16 chapters · the book11 Nov263 MB11 Nov · 263 MBSHA-256Show$/);
    // A comic file says its format and its name (turn 276 rule 6): listed nowhere before.
    assert.match(rows[1]!, /^Comic filesCBZledger-comic-2026-11-10\.cbz10 Nov12 MB10 Nov · 12 MBShow$/);
    assert.match(rows[2]!, /^AudiobookPlayer19 Oct19 OctShow$/);
    assert.match(dom.document.querySelector(".fy-h1row")?.textContent ?? "", /4 outputs · 3 made/);
    const before = m.sent.filter((message) => message.kind === "list-web-packages").length;
    const card = [...dom.document.querySelectorAll(".fy-publish-out")].find((each) => each.querySelector("h2")?.textContent === "Manuscript")!;
    await press([...card.querySelectorAll("button")].find((button) => button.textContent === "Export"));
    await press([...dom.document.querySelectorAll("button")].find((button) => button.textContent === "Cancel"));
    assert.equal(m.sent.filter((message) => message.kind === "list-web-packages").length, before + 1, "listed again once the sheet closes");
  });

  it("lists this world's finished exports, never another world's with the same production", async () => {
    await mount(productionsLayoutFixture(), "ledger");
    await act(async () => __applyEventForTest({ at: "2026-11-11T12:00:00.000Z", type: "export.progress", worldId: "01J8F3K2QW9VZX4N7M0RTYB6HD", productionId: "ledger", exportId: "ms_01J8F3K2QW9VZX4N7M0RTYB6HC", status: "done", percent: 100, output: "exports/other.docx", error: null, deliveryKind: "manuscript" }));
    await act(async () => __applyEventForTest({ at: "2026-11-11T12:00:00.000Z", type: "export.progress", worldId: FIXTURE_WORLD_ID, productionId: "ledger", exportId: "ms_01J8F3K2QW9VZX4N7M0RTYB6HE", status: "done", percent: 100, output: "exports/ledger.docx", error: null, deliveryKind: "manuscript" }));
    await act(async () => __applyEventForTest({ at: "2026-11-11T12:00:00.000Z", type: "web-packages.listed", requestId: "01J8F3K2QW9VZX4N7M0RTYB6HF", worldId: FIXTURE_WORLD_ID, packages: [] }));
    const rows = [...dom.document.querySelectorAll('[data-testid="made-row"]')].map((row) => row.textContent ?? "");
    assert.equal(rows.length, 1);
    assert.match(rows[0]!, /^ManuscriptWordledger\.docx/);
  });
});

function ulidMs(time: string): number {
  return [...time].reduce((ms, char) => ms * 32 + "0123456789ABCDEFGHJKMNPQRSTVWXYZ".indexOf(char), 0);
}
