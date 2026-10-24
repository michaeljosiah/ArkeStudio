import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import type { AudiobookListening, ClientMessage, ClientState } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * A world's Guide (design turn 234, SPEC-059 R-1 – R-7): nothing public until it is turned on, only
 * settled canon has a switch, an entry turned on brings its sections, and the Player's page beside
 * an entry says what waits for a chapter.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1360, innerHeight: 850 });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

interface Mounted { container: HTMLElement; root: Root }
const open: Mounted[] = [];

async function mount(state: ClientState): Promise<Mounted> {
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    __setStateForTest(state);
    root.render(<MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/guide`]}><App /></MemoryRouter>);
  });
  const mounted = { container, root };
  open.push(mounted);
  return mounted;
}

afterEach(async () => {
  for (const mounted of open.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  dom.document.body.replaceChildren();
  __setStateForTest(FIXTURE_STATE);
  __setBridgeForTest(null);
});

const capture = (sent: ClientMessage[]): ArkeBridge =>
  ({ appVersion: "test", platform: "test", connect: () => {}, subscribe: () => {}, send: (json: string) => sent.push(JSON.parse(json) as ClientMessage) }) as unknown as ArkeBridge;
const click = async (element: Element | null) => {
  assert.ok(element, "nothing to click");
  await act(async () => (element as HTMLElement).click());
};

/** The fixture with a story whose chapters an entry can wait for. */
function withChapters(): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const production = state.world!.productions[0]!;
  production.chapters = [1, 2, 6].map((order) => ({ id: `chapter-${order}`, file: `0${order}-chapter.md`, order, title: `Chapter ${order}`, status: "drafted", version: 1 }));
  return state;
}

describe("a world's Guide (design turn 234)", () => {
  it("sits after Productions and starts with nothing public (R-1, R-2)", async () => {
    const { container } = await mount(withChapters());
    const pills = [...container.querySelectorAll(".fy-pillnav__item")].map((pill) => pill.textContent);
    assert.equal(pills.at(-1), "Guide");
    assert.equal(pills.at(-2), "Productions");
    assert.equal(container.querySelector("[data-testid=guide-counts]")?.textContent, "0 of 6 teasers · 0 of 1 characters · 0 of 2 places · 0 of 1 lore");
  });

  it("gives an open thread no switch (R-3)", async () => {
    const { container } = await mount(withChapters());
    assert.equal(container.querySelector("[data-testid=guide-row-CANON-044] [role=switch]"), null);
    assert.ok(container.querySelector("[data-testid=guide-row-CANON-002] [role=switch]"));
  });

  it("turns an entry on with no section chosen yet, each being ticked on its own (R-4)", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const { container } = await mount(withChapters());
    await click(container.querySelector("[data-testid=guide-row-maren-kest] [role=switch]"));
    const change = sent.find((message) => message.kind === "set-guide-entry");
    assert.deepEqual(change, {
      kind: "set-guide-entry",
      worldId: FIXTURE_WORLD_ID,
      change: { entryKind: "characters", id: "maren-kest", entry: { public: true } },
    });
    assert.equal(container.querySelector("[data-testid=guide-row-maren-kest] [role=switch]")?.getAttribute("aria-checked"), "true");
  });

  it("draws what waits for a chapter, on the row and on the Player's page (R-4, R-7)", async () => {
    const state = withChapters();
    state.world!.guide = {
      schemaVersion: 1,
      characters: { "maren-kest": { public: true, sections: { Essence: { public: true }, Appearance: { public: true, after: { production: "saltlight", chapter: "chapter-6" } } } } },
      locations: { "the-vigil": { public: true, after: { production: "saltlight", chapter: "chapter-6" }, sections: { Look: { public: true } } } },
      factions: {},
      lore: {},
    };
    const { container } = await mount(state);
    assert.equal(container.querySelector("[data-testid=guide-counts]")?.textContent, "0 of 6 teasers · 1 of 1 characters · 1 of 2 places · 0 of 1 lore · 1 after a chapter");
    assert.match(container.querySelector("[data-testid=guide-row-the-vigil] .fy-guide-col--shows")?.textContent ?? "", /After Chapter 6/);
    await click(container.querySelector("[data-testid=guide-row-maren-kest] .fy-guide-row__open"));
    const panel = container.querySelector("[data-testid=guide-entry]");
    assert.ok(panel);
    const phone = panel.querySelector(".fy-guide-phone")!;
    assert.match(phone.textContent ?? "", /Tide-caller\. She hears the verse/);
    assert.match(phone.textContent ?? "", /After Chapter 6/);
    assert.doesNotMatch(phone.textContent ?? "", /Salt-crusted/);
  });

  it("previews nothing public as nothing (R-7)", async () => {
    const { container } = await mount(withChapters());
    await click(container.querySelector("[data-testid=guide-preview]"));
    assert.match(container.querySelector("[data-testid=guide-preview-sheet]")?.textContent ?? "", /Nothing public/);
  });
});

describe("a world's teasers (design turn 236a - 236c, SPEC-059 R-24 - R-27)", () => {
  it("adds a character public from the start, and never offers one that waits for a chapter", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const state = withChapters();
    state.world!.guide = {
      schemaVersion: 1,
      characters: { "maren-kest": { public: true } },
      locations: { "the-vigil": { public: true, after: { production: "saltlight", chapter: "chapter-6" } } },
      factions: {},
      lore: {},
    };
    const { container } = await mount(state);
    // Teasers come first, six places to fill (236a).
    assert.equal(container.querySelectorAll(".fy-guide-tz--add").length, 6);
    await click(container.querySelector("[data-testid=guide-teaser-add]"));
    const options = () => [...container.querySelectorAll("[data-testid=guide-teaser-options] .fy-guide-tz")];
    const named = (name: string) => options().find((el) => el.querySelector("b")?.textContent === name) ?? null;
    const tab = (label: string) => [...container.querySelectorAll(".fy-guide-pick__tabs button")].find((button) => button.textContent === label) ?? null;
    // A place that waits for a chapter is dimmed and says so in one clause, never offered (236c).
    await click(tab("Places"));
    assert.equal(named("The Vigil")?.hasAttribute("disabled"), true);
    assert.equal(named("The Vigil")?.querySelector(".m")?.textContent, "After Chapter 6");
    await click(tab("Characters"));
    assert.equal(named("Maren Kest")?.hasAttribute("disabled"), false);
    await click(named("Maren Kest"));
    await click(container.querySelector("[data-testid=guide-teaser-confirm]"));
    assert.deepEqual(sent.filter((message) => message.kind === "set-guide-teasers").at(-1), { kind: "set-guide-teasers", worldId: FIXTURE_WORLD_ID, change: { teasers: [{ kind: "character", sheet: "maren-kest" }] } });
    assert.equal(container.querySelector("[data-testid=guide-teaser-1] b")?.textContent, "Maren Kest");
    assert.equal(container.querySelectorAll(".fy-guide-tz--add").length, 5);
  });

  it("offers a mark beside its block's own picture and keeps it by the mark's key, while a bare block key still finds its picture (R-27, design turn 237)", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const state = withChapters();
    // Chosen before marks named themselves: block p80.0's only picture, a mark, under the block's key.
    const napkin = { kind: "picture" as const, production: "saltlight", chapter: "chapter-1", block: "p80.0" };
    state.world!.guide = { schemaVersion: 1, characters: {}, locations: {}, factions: {}, lore: {}, teasers: [napkin] };
    const { container } = await mount(state);
    const ask = sent.filter((message): message is Extract<ClientMessage, { kind: "open-audiobook-listening" }> => message.kind === "open-audiobook-listening").at(-1);
    assert.ok(ask, "the Guide asks where the pictures are");
    const listening: AudiobookListening = {
      productionId: "saltlight",
      title: "Saltlight",
      cover: null,
      chapters: [{
        chapterId: "chapter-1", order: 1, title: "Chapter 1", state: "part", seconds: 60, blocks: [], gaps: [], opening: null,
        pictures: [
          { key: "p75.0", number: 3, file: "artifacts/booth.png", at: 10, seconds: 5 },
          { key: "p75.0", number: 3, file: "artifacts/goat-face.png", at: 15, seconds: 5, word: 12, markKey: "p75.0@0123456789abcdef" },
          { key: "p80.0", number: 4, file: "artifacts/napkin.png", at: 20, seconds: 40, word: 3, markKey: "p80.0@77e6497d69a55639" },
        ],
      }],
    };
    await act(async () => __applyEventForTest({ at: "2026-10-24T09:00:00.000Z", type: "audiobook.listening", requestId: ask.requestId, worldId: FIXTURE_WORLD_ID, productionId: "saltlight", listening }));
    const shows = (selector: string) => container.querySelector(`${selector} img`)?.getAttribute("src") ?? "";
    assert.match(shows("[data-testid=guide-teaser-1]"), /napkin\.png/, "the bare block key finds the block's first picture");
    assert.notEqual(container.querySelector("[data-testid=guide-teaser-1] .m")?.textContent, "Moment removed");

    await click(container.querySelector("[data-testid=guide-teaser-add]"));
    await click([...container.querySelectorAll(".fy-guide-pick__tabs button")].find((button) => button.textContent === "Pictures") ?? null);
    const options = [...container.querySelectorAll("[data-testid=guide-teaser-options] .fy-guide-tz")];
    const option = (file: string) => options.find((element) => element.querySelector("img")?.getAttribute("src")?.includes(file)) ?? null;
    assert.equal(options.length, 3, "a block's own picture and its mark are each a moment");
    assert.equal(option("napkin.png")?.querySelector(".m")?.textContent, "Teaser 1", "already chosen, under its block's key");
    assert.equal(option("booth.png")?.hasAttribute("disabled"), false);
    assert.equal(option("goat-face.png")?.hasAttribute("disabled"), false);
    await click(option("goat-face.png"));
    await click(container.querySelector("[data-testid=guide-teaser-confirm]"));
    assert.deepEqual(sent.filter((message) => message.kind === "set-guide-teasers").at(-1), {
      kind: "set-guide-teasers",
      worldId: FIXTURE_WORLD_ID,
      change: { teasers: [napkin, { kind: "picture", production: "saltlight", chapter: "chapter-1", block: "p75.0@0123456789abcdef" }] },
    });
    assert.match(shows("[data-testid=guide-teaser-2]"), /goat-face\.png/, "the mark, not its block's own picture");
  });

  it("marks a teaser that no longer qualifies, and keeps it (R-27)", async () => {
    const state = withChapters();
    state.world!.guide = { schemaVersion: 1, characters: { "maren-kest": { public: false } }, locations: {}, factions: {}, lore: {}, teasers: [{ kind: "character", sheet: "maren-kest" }] };
    const { container } = await mount(state);
    assert.equal(container.querySelector("[data-testid=guide-teaser-1] .m")?.textContent, "Not public");
    assert.ok(container.querySelector("[data-testid=guide-teaser-1]")?.classList.contains("no"));
    assert.equal(container.querySelector("[data-testid=guide-counts]")?.textContent?.startsWith("1 of 6 teasers"), true);
  });
});