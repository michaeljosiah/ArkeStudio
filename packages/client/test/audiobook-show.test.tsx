import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type { AudiobookDoor, ChapterSummary, ClientMessage, ClientState } from "@arke-studio/contracts";
import { AudiobookScreen, chapterHeading, chapterSeconds, chapterStateWord, formatBookLength, readingWarning } from "../src/screens/audiobook.js";
import { audiobookPlaceKey } from "../src/components/audiobook-player.js";
import { PlayerDock } from "../src/components/player.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { dismissPlayback, playClip, setAudioFactoryForTest } from "../src/lib/audio.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The audiobook page as a show page (design turn 199, SPEC-047): the hero's presses by the book's
 * state, Read the book only while something is left and its one warning word, the cast as
 * portraits with the narrator first, the chapters as episodes that play or open, everything that
 * set the reading up in the Reading sheet, the player docked in the page's flow, and the phone.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
let phone = false;
const store = new Map<string, string>();
Object.assign(dom.window, {
  getComputedStyle: () => ({ direction: "ltr" }),
  innerWidth: 1440,
  innerHeight: 900,
  matchMedia: (query: string) => ({ matches: phone && /max-width:\s*599px/.test(query), media: query }),
  localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) },
});
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {} });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const AT = "2026-10-05T09:00:00.000Z";
const ROUTE = `/w/${FIXTURE_WORLD_ID}/p/inkbound/story/audiobook`;
const stamp = (takes: number) => ({ chapterVersion: 6, hash: "h", updatedAt: AT, takes, flagged: 0 });
const chapters = (takes: number): ChapterSummary[] => [
  { id: "chapter-1", file: "chapter-1", order: 1, title: "Chapter 1", status: "drafted", version: 6, words: 3000, synopsis: "Ade and Tunde's easy friendship opens a night at a club.", ...(takes > 0 ? { audiobook: stamp(takes) } : {}) },
  { id: "neap", file: "02-neap", order: 2, title: "The counting of bells", status: "drafted", version: 2, words: 1500 },
  { id: "untitled", file: "03-untitled", order: 3, title: "Untitled", status: "planned", version: 1, words: 0 },
];

/** The fixture world with a story production, Maren voiced by the narrator's voice and given a look. */
function inkbound(takes: number, options: { narrator?: "maren" | "george"; art?: boolean; reading?: "narrator" | "performed" | "cast" } = {}): ClientState {
  const world = FIXTURE_STATE.world!;
  const salt = world.productions.find((p) => p.meta.id === "saltlight")!;
  const look = { id: "lk_1", file: "takes/tk_1/look.png", kind: "costume" as const, prompt: "an oilskin coat", acceptedAt: AT };
  return {
    ...FIXTURE_STATE,
    app: { ...FIXTURE_STATE.app, ...(options.narrator === "maren" ? { narrator: { provider: "elevenlabs", voiceId: "v_8Kq2", label: "Low tide" } } : {}) },
    world: {
      ...world,
      keyArt: options.art === false ? null : world.keyArt,
      referenceKits: world.referenceKits.map((kit) => (kit.sheetId === "maren-kest" ? { ...kit, looks: [look] } : kit)),
      productions: [
        ...world.productions,
        {
          ...salt,
          meta: { ...salt.meta, id: "inkbound", format: "story" as const, title: "Inkbound" },
          story: { ...(salt.story ?? { version: 1 }), version: 3 },
          chapters: chapters(takes),
          ...(options.reading !== undefined ? { audiobook: { schemaVersion: 1 as const, reading: options.reading, note: "Harbour English, unhurried." } } : {}),
        },
      ],
    },
  };
}

const ROWS = [
  { chapterId: "chapter-1", file: "chapter-1", order: 1, title: "Chapter 1", version: 6, planned: false, total: 171, made: 91, stale: 0, flagged: 0, notMade: 80, seconds: 600, picture: "artifacts/booth.png" },
  { chapterId: "neap", file: "02-neap", order: 2, title: "The counting of bells", version: 2, planned: false, total: 40, made: 0, stale: 0, flagged: 0, notMade: 40, seconds: 0 },
  { chapterId: "untitled", file: "03-untitled", order: 3, title: "Untitled", version: 1, planned: true, total: 0, made: 0, stale: 0, flagged: 0, notMade: 0, seconds: 0 },
];
const PRICE = { chapters: 2, blocks: 120, cloudBlocks: 120, characters: 9000, estimatedMicroUsd: 2_400_000, voices: [{ label: "Low tide", provider: "elevenlabs", narrator: true as const, local: false, characters: 9000, estimatedMicroUsd: 2_400_000 }] };

const door = (extra: Partial<AudiobookDoor> = {}): AudiobookDoor => ({
  reading: "cast",
  voices: [
    { name: "Low tide", voice: { label: "Low tide", provider: "elevenlabs", local: false }, state: "narrator", blocks: 155 },
    { sheet: "odile-sarn", name: "Odile Sarn", state: "no voice", blocks: 31 },
    { sheet: "maren-kest", name: "Maren Kest", voice: { label: "Low tide", provider: "elevenlabs", local: false }, state: "reads", blocks: 16 },
    { sheet: "perrin-tallow", name: "Perrin Tallow", state: "no voice", blocks: 32 },
  ],
  unattributed: 0,
  rows: ROWS,
  price: PRICE,
  // In the order of their first line, whatever the reading.
  cast: [{ sheet: "odile-sarn", name: "Odile Sarn" }, { sheet: "perrin-tallow", name: "Perrin Tallow" }, { sheet: "maren-kest", name: "Maren Kest" }, { name: "the ferryman" }],
  ...extra,
});

type Mounted = { container: HTMLElement; root: Root; sent: ClientMessage[]; where: () => string };
const open: Mounted[] = [];
let location = "";
function Where() {
  location = useLocation().pathname + useLocation().search;
  return null;
}

async function mount(state: ClientState, answer: AudiobookDoor | null = door()): Promise<Mounted> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect: () => {}, subscribe: () => {}, send: (json: string) => sent.push(JSON.parse(json) as ClientMessage) } as unknown as ArkeBridge);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    __setStateForTest(state, { connection: "open" });
    root.render(
      <MemoryRouter initialEntries={[ROUTE]}>
        <Where />
        <PlayerDock />
        <Routes>
          <Route path="/w/:worldId/p/:prodId/story/audiobook" element={<AudiobookScreen />} />
          <Route path="*" element={<div data-testid="elsewhere" />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  const mounted = { container, root, sent, where: () => location };
  open.push(mounted);
  if (answer !== null) {
    const ask = sent.findLast((message) => message.kind === "open-audiobook") as Extract<ClientMessage, { kind: "open-audiobook" }>;
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.door", requestId: ask.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", door: answer }));
  }
  return mounted;
}

afterEach(async () => {
  for (const mounted of open.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  phone = false;
  store.clear();
  dismissPlayback();
});

const body = () => dom.document.body as unknown as HTMLElement;
const q = (selector: string): HTMLElement | null => body().querySelector(selector) as HTMLElement | null;
const all = (selector: string): HTMLElement[] => [...body().querySelectorAll(selector)] as HTMLElement[];
const press = async (element: Element | null) => {
  assert.ok(element, "the thing to press exists");
  await act(async () => (element as HTMLElement).click());
};
const presses = () => all('[data-testid="audiobook-presses"] button').map((button) => button.getAttribute("data-testid"));

describe("what the page says, as data (199)", () => {
  it("lengths: the made takes' time and the rest from the words; minutes, or h m", () => {
    assert.equal(Math.round(chapterSeconds(ROWS[0]!, 3000)), 600 + Math.round((3000 * 80) / 171 / 2.5));
    assert.equal(chapterSeconds(ROWS[1]!, 1500), 600, "a chapter not read is its words at the narrator's rate");
    assert.equal(chapterSeconds(ROWS[2]!, 0), 0);
    assert.equal(chapterSeconds({ ...ROWS[0]!, seconds: null }, 3000), 1200, "unmeasured takes: the words, whole");
    assert.equal(formatBookLength(1380), "23 min");
    assert.equal(formatBookLength(3600 * 6 + 12 * 60), "6 h 12 m");
  });

  it("names a chapter titled with its number once, and says a state word only when the chapter is not simply ready", () => {
    assert.equal(chapterHeading({ order: 1, title: "Chapter 1" }), "Chapter 1");
    assert.equal(chapterHeading({ order: 2, title: "Untitled" }), "2 · Untitled");
    assert.equal(chapterHeading({ order: 3, title: "Chapter 1" }), "3 · Chapter 1");
    assert.equal(chapterStateWord(ROWS[0]!, false), "80 to read");
    assert.equal(chapterStateWord(ROWS[1]!, false), "not read");
    assert.equal(chapterStateWord(ROWS[2]!, false), "planned");
    assert.equal(chapterStateWord({ ...ROWS[0]!, made: 171, notMade: 0 }, false), null, "read whole: nothing");
    assert.equal(chapterStateWord(ROWS[0]!, true), "reading…");
    assert.equal(chapterStateWord({ ...ROWS[1]!, castTrouble: "not cast · cast the lines first" }, false), "not cast");
  });

  it("counts one warning word under Cast, never under the narrator's reading", () => {
    assert.equal(readingWarning(door()), "2 no voice");
    assert.equal(readingWarning(door({ reading: "narrator" })), null);
    assert.equal(readingWarning(door({ voices: [door().voices[0]!, { ...door().voices[2]!, state: "voice unavailable" }] })), "1 unavailable");
    assert.equal(readingWarning(door({ voices: [door().voices[0]!], unattributed: 3 })), "3 unattributed");
    assert.equal(readingWarning(door({ voices: [door().voices[0]!] })), null);
  });
});

describe("the hero (199a, 199b, rule 4)", () => {
  it("until a block is made, Read the book is the primary and Listen and Export are not drawn", async () => {
    await mount(inkbound(0));
    assert.deepEqual(presses(), ["read-book", "audiobook-more"]);
    assert.ok(q('[data-testid="read-book"]')!.classList.contains("fy-abshow__btn--pri"));
  });

  it("once a block is made: Listen, Export, Read the book with its count, price and warning word, ⋯", async () => {
    await mount(inkbound(91));
    assert.deepEqual(presses(), ["audiobook-listen", "audiobook-export-open", "read-book", "audiobook-more"]);
    assert.equal(q('[data-testid="audiobook-listen"]')!.textContent, "Listen");
    assert.equal(q('[data-testid="read-book"]')!.textContent, "Read the book · 2 chapters · up to $2.40 · 2 no voice");
    assert.ok(!q('[data-testid="read-book"]')!.classList.contains("fy-abshow__btn--pri"), "an outline");
    assert.equal(q('[data-testid="audiobook-line"]')!.textContent, "Audiobook · 3 chapters · 29 min · Read by Low tide", "one meta line: every chapter, the length, who reads it");
    assert.equal(q(".fy-abshow__title")!.textContent, "Inkbound");
    assert.doesNotMatch(q('[data-screen="audiobook"]')!.textContent ?? "", /blocks|Kokoro|ElevenLabs|request/, "no counts, providers or requests on the page");
  });

  it("Continue · Chapter N · m:ss when this device keeps a place, and it plays from there", async () => {
    store.set(audiobookPlaceKey(FIXTURE_WORLD_ID, "inkbound"), JSON.stringify({ place: { chapterId: "chapter-1", key: "p3.0", offset: 2, at: 760 } }));
    const m = await mount(inkbound(91));
    assert.equal(q('[data-testid="audiobook-listen"]')!.textContent, "Continue · Chapter 1 · 12:40");
    // The thumbnail's listened bar, from this device's place.
    assert.equal((all('[data-testid="audiobook-row"]')[0]!.querySelector(".fy-abshow__pb i") as HTMLElement).style.width, "100%");
    await press(q('[data-testid="audiobook-listen"]'));
    assert.ok(q('[data-testid="audiobook-player"]'), "the player opens");
    const ask = m.sent.findLast((message) => message.kind === "open-audiobook-listening");
    assert.ok(ask, "on the book's plan");
  });

  it("draws the listened bar where the made takes' time is not measured, against the length the row says", async () => {
    store.set(audiobookPlaceKey(FIXTURE_WORLD_ID, "inkbound"), JSON.stringify({ place: { chapterId: "chapter-1", key: "p3.0", offset: 2, at: 95 } }));
    await mount(inkbound(91), door({ rows: [{ ...ROWS[0]!, seconds: null }, ...ROWS.slice(1)] }));
    const bar = all('[data-testid="audiobook-row"]')[0]!.querySelector(".fy-abshow__pb i") as HTMLElement | null;
    assert.ok(bar, "unmeasured takes still show how far this device got");
    assert.notEqual(bar.style.width, "0%");
  });

  it("Read the book is absent, not disabled, when nothing is left to read", async () => {
    await mount(inkbound(91), door({ price: { ...PRICE, chapters: 0, blocks: 0, estimatedMicroUsd: 0 } }));
    assert.deepEqual(presses(), ["audiobook-listen", "audiobook-export-open", "audiobook-more"]);
  });

  it("while the book reads its place holds the run and Stop; a stopped run is one line with its ×", async () => {
    const m = await mount(inkbound(91));
    const ids = { worldId: FIXTURE_WORLD_ID, productionId: "inkbound" };
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.book-started", ...ids, requestId: "01J8F3K2QW9VZX4N7M0RTYB6H1", chapters: 2, blocks: 120 }));
    assert.equal(q('[data-testid="read-book"]'), null);
    assert.match(q('[data-testid="audiobook-run"]')!.textContent!, /^reading… 0 of 2 chaptersStop$/);
    await press(all('[data-testid="audiobook-run"] button').find((button) => button.textContent === "Stop")!);
    assert.ok(m.sent.some((message) => message.kind === "stop-audiobook-book"));
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.book-finished", ...ids, outcome: "stopped", chaptersRead: 0, chaptersRefused: 0, made: 3, flagged: 0 }));
    assert.match(q('[data-testid="audiobook-note"]')!.textContent!, /^stopped · the takes made stand×$/);
    assert.ok(q('[data-testid="audiobook-hero"] [data-testid="audiobook-note"]'), "under the presses, in the hero");
  });

  it("the ⋯ holds Reading with its reading and warning word, and Narrator; a world with no art adds Make a cover", async () => {
    await mount(inkbound(91, { art: false }));
    await press(q('[data-testid="audiobook-more"]'));
    assert.deepEqual(all('[role="menu"] [role="menuitem"]').map((item) => item.textContent), ["ReadingCast2 no voice", "NarratorLow tide", "Make a cover"]);
    assert.equal(q('[data-testid="audiobook-hero"]')!.getAttribute("data-art"), "false", "the hero on the overlay colour alone");
    await press(q('[data-testid="menu-narrator"]'));
    assert.ok(dom.document.querySelector('[data-testid="narrator-dialog"]'), "Narrator opens 165c");
  });
});

describe("the cast as pictures (rule 6)", () => {
  it("puts the narrator first, labelled, then the speakers in the order of their first line, name only", async () => {
    const m = await mount(inkbound(91, { narrator: "maren" }));
    const cards = all('[data-testid="audiobook-card"]');
    assert.deepEqual(cards.map((card) => [...card.querySelectorAll(".fy-abshow__card-nm, .fy-abshow__card-rl")].map((part) => part.textContent).join("")), ["Low tideNarrator", "Odile Sarn", "Perrin Tallow", "Maren Kest", "the ferryman"]);
    // A voice designed from a sheet shows that sheet's look: not the same picture twice.
    assert.match(cards[0]!.querySelector("img")!.getAttribute("src")!, /references\/maren-kest\/takes\/tk_1\/look\.png/);
    assert.match(cards[3]!.querySelector("img")!.getAttribute("src")!, /references\/maren-kest\/head-front\.png/, "the character's own main photo");
    assert.ok(cards[0]!.querySelector(".fy-abshow__wv"), "the narrator's voice mark");
    assert.equal(cards[4]!.querySelector("img"), null, "no sheet: its initial on a card");
    assert.equal(cards[4]!.querySelector(".fy-abshow__ini")!.textContent, "T");
    assert.equal((cards[4] as HTMLButtonElement).disabled, true, "nowhere to go");
    await press(cards[1]!);
    assert.equal(m.where(), `/w/${FIXTURE_WORLD_ID}/cast/odile-sarn`, "a card opens the character's page");
  });

  it("a catalogue voice with no sheet shows the backdrop, and the narrator's card opens 165c", async () => {
    await mount(inkbound(91, { narrator: "george" }), door({ voices: [{ name: "George", voice: { label: "George", provider: "kokoro", local: true }, state: "narrator", blocks: 200 }] }));
    const narrator = all('[data-testid="audiobook-card"]')[0]!;
    assert.match(narrator.querySelector("img")!.getAttribute("src")!, /world-art\.png/);
    await press(narrator);
    assert.ok(dom.document.querySelector('[data-testid="narrator-dialog"]'));
  });
});

describe("the chapters as episodes (rule 7)", () => {
  it("each row its thumbnail, title, length, state word and synopsis; a press plays or opens, the chevron opens", async () => {
    const m = await mount(inkbound(91));
    const rows = all('[data-testid="audiobook-row"]');
    assert.deepEqual(rows.map((row) => row.querySelector(".fy-abshow__nm")!.textContent), ["Chapter 1", "2 · The counting of bells", "3 · Untitled"]);
    assert.deepEqual(rows.map((row) => row.querySelector(".fy-abshow__d")?.textContent ?? null), ["19 min", "10 min", null]);
    assert.deepEqual(rows.map((row) => row.getAttribute("data-state")), ["80 to read", "not read", "planned"]);
    assert.equal(rows[0]!.querySelector(".fy-abshow__syn")!.textContent, "Ade and Tunde's easy friendship opens a night at a club.");
    assert.equal(rows[1]!.querySelector(".fy-abshow__syn"), null, "no synopsis, nothing");
    assert.match(rows[0]!.querySelector(".fy-abshow__th img")!.getAttribute("src")!, /artifacts\/booth\.png/, "the chapter's first picture");
    assert.match(rows[1]!.querySelector(".fy-abshow__th img")!.getAttribute("src")!, /world-art\.png/, "else the backdrop");
    assert.equal(rows[2]!.querySelector(".fy-abshow__th--none")!.textContent, "3", "a planned chapter: its number on a dashed card");
    assert.equal(q('[data-testid="audiobook-bar"]'), null, "no read bar");
    // A row with something made plays from there.
    await press(rows[0]!.querySelector(".fy-abshow__ep-main"));
    assert.ok(q('[data-testid="audiobook-player"]'), "the player, on chapter 1");
    await press(q(".fy-abplayer__wait button"));
    // A row with nothing made opens the chapter instead.
    await press(all('[data-testid="audiobook-row"]')[1]!.querySelector(".fy-abshow__ep-main"));
    assert.equal(m.where(), `/w/${FIXTURE_WORLD_ID}/p/inkbound/story/chapters/neap?view=audiobook`);
  });

  it("the chevron opens the chapter's Audiobook view, played or not", async () => {
    const m = await mount(inkbound(91));
    await press(all('[data-testid="audiobook-row-open"]')[0]!);
    assert.equal(m.where(), `/w/${FIXTURE_WORLD_ID}/p/inkbound/story/chapters/chapter-1?view=audiobook`);
  });
});

describe("Reading, in one sheet (199e, rule 10)", () => {
  it("holds every control the page had: the reading, the narrator, each speaker, the book note, the requests and the book's counts, Done", async () => {
    const m = await mount(inkbound(91, { reading: "cast" }), door({ requests: "grouped", price: { ...PRICE, requests: 23, perParagraph: 81 }, unattributed: 2 }));
    assert.equal(q('[data-testid="reading-sheet"]'), null, "never on the page");
    await press(q('[data-testid="audiobook-more"]'));
    await press(q('[data-testid="menu-reading"]'));
    const sheet = q('[data-testid="reading-sheet"]')!;
    assert.equal(sheet.getAttribute("role"), "dialog");
    assert.deepEqual([...sheet.querySelectorAll('[aria-label="Reading"] button')].map((b) => b.textContent), ["Narrator", "Performed", "Cast"]);
    assert.match(sheet.querySelector('[data-testid="reading-narrator"]')!.textContent!, /^NarratorLow tideElevenLabs · cloud155 blocks$/);
    assert.deepEqual([...sheet.querySelectorAll('[data-testid="audiobook-voice"]')].map((row) => row.textContent), [
      "Odile Sarnno voice · narrator31 blocks",
      "Maren KestLow tideElevenLabs · cloud16 blocks",
      "Perrin Tallowno voice · narrator32 blocks",
      "unattributed2 lines · narrator",
    ]);
    const note = sheet.querySelector('textarea[aria-label="Book note"]') as HTMLTextAreaElement;
    assert.ok(note, "the book note, under every reading");
    assert.match(sheet.querySelector('[data-testid="book-requests"]')!.textContent!, /RequestsGroupedPer paragraphElevenLabs · up to ~5 min a request/);
    assert.match(sheet.querySelector('[data-testid="book-requests"]')!.textContent!, /Book23 requests81 per paragraph/);
    await press([...sheet.querySelectorAll('[aria-label="Reading"] button')].find((b) => b.textContent === "Performed")!);
    assert.ok(m.sent.some((message) => message.kind === "set-audiobook-reading" && message.reading === "performed"));
    await press(sheet.querySelector('[data-testid="reading-narrator"]'));
    assert.ok(dom.document.querySelector('[data-testid="narrator-dialog"]'), "the narrator's row opens 165c");
    await press(q('[data-testid="reading-done"]'));
    assert.equal(q('[data-testid="reading-sheet"]'), null);
  });

  it("closes on Escape", async () => {
    await mount(inkbound(91));
    await press(q('[data-testid="audiobook-more"]'));
    await press(q('[data-testid="menu-reading"]'));
    await act(async () => {
      const event = new dom.Event("keydown", { bubbles: true }) as unknown as KeyboardEvent;
      Object.assign(event, { key: "Escape" });
      q('[data-testid="reading-sheet"]')!.dispatchEvent(event);
    });
    assert.equal(q('[data-testid="reading-sheet"]'), null);
  });
});

describe("the player never covers the page (rule 9)", () => {
  it("docks in the page's flow, under its scroll, with Open to the full player; elsewhere it floats as before", async () => {
    const element = { playbackRate: 1, src: "", currentTime: 0, duration: NaN, paused: true, async play() { element.paused = false; }, pause() { element.paused = true; }, load() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {} };
    setAudioFactoryForTest(() => element as never);
    try {
      const m = await mount(inkbound(91));
      await act(async () => void (await playClip({ id: "block", url: "media/block.wav", title: "Chapter 1", sub: "Inkbound · Tunde · one block" })));
      const dock = q('[data-testid="player-dock"]')!;
      assert.ok(dock, "the dock is drawn");
      assert.ok(dock.parentElement!.classList.contains("fy-abshow__dock"), "in the page's own place for it");
      assert.equal(dock.parentElement!.previousElementSibling?.classList.contains("fy-abshow__page") || dock.parentElement!.parentElement!.querySelector(":scope > .fy-abshow__page") !== null, true, "beside the page's scroll, not over it");
      assert.equal(q(".fy-dock"), null, "not floating over the chapter list");
      assert.match(dock.textContent!, /Chapter 1Inkbound · Tunde · one block/);
      assert.deepEqual([...dock.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")), ["Back 15 seconds", "Pause Chapter 1", "Forward 30 seconds", "Open", "Dismiss the player"]);
      await press(dock.querySelector('[aria-label="Open"]'));
      assert.ok(q('[data-testid="audiobook-player"]'), "Open is the full player");
      assert.equal(q('[data-testid="player-dock"]'), null, "which takes the one voice: the clip is let go");
      await press(q(".fy-abplayer__wait button"));
      // Leave the page: the one dock floats again.
      await act(async () => m.root.unmount());
      open.splice(0);
      m.container.remove();
      const elsewhere = dom.document.createElement("div") as unknown as HTMLElement;
      dom.document.body.append(elsewhere);
      const root = createRoot(elsewhere);
      await act(async () => root.render(<PlayerDock />));
      await act(async () => void (await playClip({ id: "block", url: "media/block.wav", title: "Chapter 1" })));
      assert.ok(q(".fy-dock"), "the floating dock");
      assert.equal(q('[data-testid="player-dock"]'), null);
      await act(async () => root.unmount());
      elsewhere.remove();
    } finally {
      dismissPlayback();
      setAudioFactoryForTest(null);
    }
  });
});

describe("on a phone (199f)", () => {
  it("puts Continue first, then Read the book with its price, Export and ⋯ with the warning dot, under a back press", async () => {
    phone = true;
    store.set(audiobookPlaceKey(FIXTURE_WORLD_ID, "inkbound"), JSON.stringify({ place: { chapterId: "chapter-1", at: 760 } }));
    const m = await mount(inkbound(91));
    assert.deepEqual(presses(), ["audiobook-listen", "read-book", "audiobook-export-open", "audiobook-more"]);
    assert.equal(q('[data-testid="read-book"]')!.textContent, "Read the book · up to $2.40", "the price alone; the word is the ⋯'s");
    assert.ok(q('[data-testid="audiobook-more-dot"]'), "the warning dot on ⋯");
    await press(q('[data-testid="audiobook-more"]'));
    assert.equal(q('[data-testid="menu-reading"]')!.textContent, "ReadingCast2 no voice", "and the entry its word");
    await press(q('[data-testid="audiobook-hero"] [aria-label="Back"]'));
    assert.equal(m.where(), `/w/${FIXTURE_WORLD_ID}/p/inkbound`);
  });

  it("brings in the page's bar once the hero scrolls away", async () => {
    phone = true;
    await mount(inkbound(91));
    assert.equal(q('[data-testid="audiobook-pbar"]'), null);
    const page = q(".fy-abshow__page")!;
    await act(async () => {
      Object.defineProperty(page, "scrollTop", { value: 400, configurable: true });
      page.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
    });
    assert.match(q('[data-testid="audiobook-pbar"]')!.textContent!, /Inkbound/);
    assert.ok(q('[data-testid="audiobook-bar-more"]'), "with its ⋯");
  });
});
