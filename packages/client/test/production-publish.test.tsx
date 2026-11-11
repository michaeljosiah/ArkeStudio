import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type { ClientMessage, ClientState, ProductionBundle } from "@arke-studio/contracts";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { ProductionPublishScreen, publishOutputs } from "../src/screens/production-publish.js";
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
    const kind = dom.document.querySelector('.fy-abv-kind[aria-checked="true"], .fy-abv-kind.on');
    assert.match(kind?.textContent ?? "", /Arke Player/, "the export sheet opens on Arke Player");
    assert.equal(dom.document.querySelector('[data-testid="where"]')?.textContent, `/w/${FIXTURE_WORLD_ID}/p/ledger/publish`, "over the page, not elsewhere");
    assert.ok(m.sent.some((message) => message.kind === "open-audiobook-listening"), "it reads the listening plan, as from the Audiobook page");
  });

  it("opens a film's Cut with its export sheet up", async () => {
    await mount(productionsLayoutFixture(), "saltlight");
    const cards = [...dom.document.querySelectorAll(".fy-publish-out")];
    assert.equal(cards[0]!.querySelector("h2")?.textContent, "Film");
    await press(cards[0]!.querySelector("button"));
    assert.equal(dom.document.querySelector('[data-testid="where"]')?.textContent, `/w/${FIXTURE_WORLD_ID}/p/saltlight/cut?export=1`);
  });
});
