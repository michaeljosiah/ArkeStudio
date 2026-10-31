import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type { AudiobookDoor, ChapterSummary, ClientMessage, ClientState } from "@arke-studio/contracts";
import { AudiobookScreen, bookNarrators, chapterHeading, chapterSeconds, chapterSpans, chapterStateWord, formatBookLength, namesCredit, readingWarning } from "../src/screens/audiobook.js";
import { audiobookPlaceKey } from "../src/lib/audiobook-place.js";
import { PlayerDock } from "../src/components/player.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { dismissPlayback, playClip, setAudioFactoryForTest } from "../src/lib/audio.js";
import { __applyEventForTest, __handleFrameForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
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
function inkbound(takes: number, options: { narrator?: "maren" | "george"; art?: boolean; reading?: "narrator" | "performed" | "cast"; shapes?: Array<"wide" | "tall"> } = {}): ClientState {
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
          ...(options.reading !== undefined || options.shapes !== undefined
            ? { audiobook: { schemaVersion: 1 as const, reading: options.reading ?? ("narrator" as const), ...(options.reading !== undefined ? { note: "Harbour English, unhurried." } : {}), ...(options.shapes !== undefined ? { pictureShapes: options.shapes } : {}) } }
            : {}),
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

  it("names the chapters a narrator of their own reads by number and run (R-195)", () => {
    const rows = Array.from({ length: 17 }, (_, at) => ({ chapterId: `c${at + 1}`, order: at + 1 }));
    assert.equal(chapterSpans(["c9", "c10", "c11", "c12", "c13", "c14", "c15", "c16"], rows), "Ch 9–16");
    assert.equal(chapterSpans(["c17", "c1", "c2", "c3"], rows), "Ch 1–3, 17", "in the book's order, whatever order they were kept in");
    assert.equal(chapterSpans(["c5"], rows), "Ch 5");
    assert.equal(chapterSpans(["gone"], rows), "Chapters", "a chapter no longer on the door is not counted");
  });

  it("counts one warning word under Cast, never under the narrator's reading", () => {
    assert.equal(readingWarning(door()), "2 no voice");
    assert.equal(readingWarning(door({ reading: "narrator" })), null);
    assert.equal(readingWarning(door({ voices: [door().voices[0]!, { ...door().voices[2]!, state: "voice unavailable" }] })), "1 unavailable");
    assert.equal(readingWarning(door({ voices: [door().voices[0]!], unattributed: 3 })), "3 unattributed");
    assert.equal(readingWarning(door({ voices: [door().voices[0]!] })), null);
  });
});

describe("audiobook work and measured duration (issue 1935)", () => {
  it("opens the first unfinished chapter, independently of the listener's place", async () => {
    store.set(audiobookPlaceKey(FIXTURE_WORLD_ID, "inkbound"), JSON.stringify({ chapterId: "chapter-1", at: 30 }));
    const m = await mount(inkbound(171), door({ rows: [{ ...ROWS[0]!, made: 171, notMade: 0 }, ROWS[1]!, ROWS[2]!] }));
    assert.equal(q('[data-testid="audiobook-next-work"]')!.textContent, "Continue work · Chapter 2");
    await press(q('[data-testid="audiobook-next-work"]'));
    assert.equal(m.where(), `/w/${FIXTURE_WORLD_ID}/p/inkbound/story/chapters/neap?view=audiobook`);
  });

  it("a complete measured book shows recorded time and no unfinished work, excluding plans", async () => {
    await mount(inkbound(171), door({ rows: [{ ...ROWS[0]!, made: 171, notMade: 0 }, ROWS[2]!] }));
    assert.equal(q('[data-testid="audiobook-line"]')!.textContent, "Audiobook · 2 chapters · 10 min recorded · Read by Low tide");
    assert.equal(q('[data-testid="audiobook-next-work"]'), null);
    assert.equal(q('.fy-abshow__d')!.textContent, "10 min recorded");
  });

  it("unmeasured takes stay estimated and the recorded subtotal is explicitly a lower bound", async () => {
    await mount(inkbound(91), door({ rows: [ROWS[0]!, { ...ROWS[1]!, made: 40, notMade: 0, seconds: null }] }));
    assert.match(q('[data-testid="audiobook-line"]')!.textContent!, /~29 min estimated total · at least 10 min recorded/);
    assert.equal(all('.fy-abshow__d')[1]!.textContent, "10 min estimated");
  });
});

describe("the hero (199a, 199b, rule 4)", () => {
  it("before narration, Read the book leads and Publish can create a book-only edition", async () => {
    await mount(inkbound(0));
    assert.deepEqual(presses(), ["audiobook-export-open", "read-book", "audiobook-more"]);
    assert.ok(q('[data-testid="read-book"]')!.classList.contains("fy-abshow__btn--pri"));
  });

  it("once a block is made: Listen, Export, Read the book with its count, price and warning word, ⋯", async () => {
    await mount(inkbound(91));
    assert.deepEqual(presses(), ["audiobook-listen", "audiobook-export-open", "read-book", "audiobook-more"]);
    assert.equal(q('[data-testid="audiobook-listen"]')!.textContent, "Listen");
    assert.equal(q('[data-testid="read-book"]')!.textContent, "Read the book · 2 chapters · up to $2.40 · 2 no voice");
    assert.ok(!q('[data-testid="read-book"]')!.classList.contains("fy-abshow__btn--pri"), "an outline");
    assert.equal(q('[data-testid="audiobook-line"]')!.textContent, "Audiobook · 3 chapters · ~29 min estimated total · 10 min recorded · Read by Low tide", "one meta line: every chapter, the length, who reads it");
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

  it("the ⋯ holds Reading with its reading and warning word, Narrator and Pictures; a world with no art adds Make a cover", async () => {
    await mount(inkbound(91, { art: false }));
    await press(q('[data-testid="audiobook-more"]'));
    assert.deepEqual(all('[role="menu"] [role="menuitem"]').map((item) => item.textContent), ["Audio Studio", "ReadingCast2 no voice", "NarratorLow tide", "PicturesWide", "Make a cover"]);
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

  it("credits a narrator to a part beside the book's, in the order they first read, and its card opens its first chapter (R-195)", async () => {
    const heart = { name: "Heart", voice: { label: "Heart", provider: "kokoro", local: true }, state: "narrator" as const, blocks: 40, chapters: ["neap"] };
    const m = await mount(inkbound(91, { narrator: "george" }), door({ voices: [{ name: "George", voice: { label: "George", provider: "kokoro", local: true }, state: "narrator", blocks: 171 }], chapterNarrators: [heart] }));
    assert.match(q('[data-testid="audiobook-line"]')!.textContent!, / · Read by George and Heart$/, "every narrator, as the video credits them");
    const cards = all('[data-testid="audiobook-card"]').slice(0, 2);
    assert.deepEqual(cards.map((card) => [...card.querySelectorAll(".fy-abshow__card-nm, .fy-abshow__card-rl")].map((part) => part.textContent)), [["George", "Narrator · Ch 1, 3"], ["Heart", "Narrator · Ch 2"]]);
    await press(cards[1]!);
    assert.equal(m.where(), `/w/${FIXTURE_WORLD_ID}/p/inkbound/story/chapters/neap?view=audiobook`, "a chapter's narrator is chosen from its chapter");
  });

  it("orders narrators by the chapter each first reads, leaves out a book narrator with no chapter left, and names each once", () => {
    const row = (name: string, chapters?: string[]) => ({ name, state: "narrator" as const, blocks: 1, ...(chapters !== undefined ? { chapters } : {}) });
    const rows = ROWS;
    const names = (d: Parameters<typeof bookNarrators>[0]) => bookNarrators(d).map((entry) => [entry.row.name, entry.chapters]);
    assert.deepEqual(names({ voices: [row("Ines")], rows }), [["Ines", ["chapter-1", "neap", "untitled"]]]);
    assert.deepEqual(names({ voices: [row("Ines")], chapterNarrators: [row("Mistress", ["chapter-1"])], rows }), [["Mistress", ["chapter-1"]], ["Ines", ["neap", "untitled"]]], "the part read first comes first");
    assert.deepEqual(names({ voices: [row("Ines")], chapterNarrators: [row("Mistress", ["chapter-1", "neap", "untitled"])], rows }), [["Mistress", ["chapter-1", "neap", "untitled"]]], "no chapter left to the book's narrator");
    assert.equal(namesCredit(["Ines", "Mistress", "Ines"]), "Ines and Mistress");
    assert.equal(namesCredit(["A", "B", "C"]), "A, B and C");
    assert.equal(namesCredit(["A"]), "A");
  });
});

describe("the chapters as episodes (rule 7)", () => {
  it("each row its thumbnail, title, length, state word and synopsis; a press plays or opens, the chevron opens", async () => {
    const m = await mount(inkbound(91));
    const rows = all('[data-testid="audiobook-row"]');
    assert.deepEqual(rows.map((row) => row.querySelector(".fy-abshow__nm")!.textContent), ["Chapter 1", "2 · The counting of bells", "3 · Untitled"]);
    assert.deepEqual(rows.map((row) => row.querySelector(".fy-abshow__d")?.textContent ?? null), ["19 min estimated", "10 min estimated", null]);
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

describe("Pictures, in one sheet (turn 235a)", () => {
  const AT_ = "2026-10-23T09:00:00.000Z";
  const sent = (m: Mounted, kind: ClientMessage["kind"]) => m.sent.filter((message) => message.kind === kind);
  const openSheet = async () => {
    await press(q('[data-testid="audiobook-more"]'));
    await press(q('[data-testid="menu-pictures"]'));
    return q('[data-testid="pictures-sheet"]')!;
  };

  it("the More menu says the shapes on, and the sheet turns Tall on and keeps one shape at least", async () => {
    const m = await mount(inkbound(91));
    await press(q('[data-testid="audiobook-more"]'));
    assert.match(q('[data-testid="menu-pictures"]')!.textContent!, /^Pictures.*Wide$/);
    await press(q('[data-testid="menu-pictures"]'));
    const sheet = q('[data-testid="pictures-sheet"]')!;
    assert.equal(sheet.getAttribute("role"), "dialog");
    assert.match(sheet.querySelector('[data-testid="pictures-shape-wide"]')!.textContent!, /Wide.*16:9.*desktop · tablet/);
    assert.match(sheet.querySelector('[data-testid="pictures-shape-tall"]')!.textContent!, /Tall.*9:16.*phone/);
    await press(sheet.querySelector('[data-testid="pictures-shape-tall"] [role="checkbox"]'));
    assert.deepEqual((sent(m, "set-audiobook-picture-shapes").at(-1) as Extract<ClientMessage, { kind: "set-audiobook-picture-shapes" }>).shapes, ["wide", "tall"]);
    // Wide alone is on: turning it off would leave the book no shape, so nothing is sent.
    const asked = sent(m, "set-audiobook-picture-shapes").length;
    await press(sheet.querySelector('[data-testid="pictures-shape-wide"] [role="checkbox"]'));
    assert.equal(sent(m, "set-audiobook-picture-shapes").length, asked);
  });

  it("offers Make N tall for the pictures without one or with one from an earlier picture, and follows the run in place", async () => {
    const m = await mount(inkbound(91, { shapes: ["wide", "tall"] }));
    const sheet = await openSheet();
    const picture = (key: string, extra: Record<string, unknown> = {}) => ({ key, number: 1, file: `artifacts/${key}.png`, at: 0, seconds: 30, ...extra });
    const listening = { productionId: "inkbound", title: "Inkbound", scope: { kind: "book" }, cover: null, chapters: [{ chapterId: "neap", order: 1, title: "Neap", state: "read", seconds: 90, blocks: [], gaps: [], opening: null, pictures: [picture("a"), picture("b", { tall: "artifacts/b-tall.png" }), picture("c", { tall: "artifacts/c-tall.png", tallEarlier: true })] }] };
    // The page asks for its own plan too; each ask is answered with the book's.
    for (const ask of sent(m, "open-audiobook-listening") as Array<Extract<ClientMessage, { kind: "open-audiobook-listening" }>>) {
      await act(async () => __applyEventForTest({ at: AT_, type: "audiobook.listening", requestId: ask.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", listening } as never));
    }
    assert.match(sheet.querySelector('[data-testid="pictures-shape-wide"]')!.textContent!, /3 made/);
    assert.match(sheet.querySelector('[data-testid="pictures-shape-tall"]')!.textContent!, /2 made/);
    assert.match(q('[data-testid="pictures-make-tall"]')!.textContent!, /^Tall · 2 to make.*Make 2 tall$/);
    await press(q('[data-testid="pictures-start-tall"]'));
    assert.equal(sent(m, "make-audiobook-tall-pictures").length, 1);
    await act(async () => __applyEventForTest({ at: AT_, type: "audiobook.tall-progress", worldId: FIXTURE_WORLD_ID, productionId: "inkbound", state: "making", total: 2, made: 1, failed: [] }));
    assert.match(q('[data-testid="pictures-make-tall"]')!.textContent!, /^Tall · 1 of 2.*Stop$/);
    await press(q('[data-testid="pictures-stop-tall"]'));
    assert.equal(sent(m, "stop-audiobook-tall-pictures").length, 1);
  });

  it("shows a run that ended while the window was away as ended, once the snapshot comes back (codex on PR 2166)", async () => {
    const m = await mount(inkbound(91, { shapes: ["wide", "tall"] }));
    await openSheet();
    const picture = (key: string) => ({ key, number: 1, file: `artifacts/${key}.png`, at: 0, seconds: 30 });
    const listening = { productionId: "inkbound", title: "Inkbound", scope: { kind: "book" }, cover: null, chapters: [{ chapterId: "neap", order: 1, title: "Neap", state: "read", seconds: 90, blocks: [], gaps: [], opening: null, pictures: [picture("a")] }] };
    const answerPlans = async () => {
      for (const ask of sent(m, "open-audiobook-listening") as Array<Extract<ClientMessage, { kind: "open-audiobook-listening" }>>) {
        await act(async () => __applyEventForTest({ at: AT_, type: "audiobook.listening", requestId: ask.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", listening } as never));
      }
    };
    await act(async () => __applyEventForTest({ at: AT_, type: "audiobook.tall-progress", worldId: FIXTURE_WORLD_ID, productionId: "inkbound", state: "making", total: 1, made: 0, failed: [] }));
    await answerPlans();
    assert.match(q('[data-testid="pictures-make-tall"]')!.textContent!, /^Tall · 0 of 1.*Stop$/);
    // The run ends unheard; the window rejoins to a snapshot, and the coordinator replays no run.
    await act(async () => __handleFrameForTest({ kind: "snapshot", seq: 1, state: inkbound(91, { shapes: ["wide", "tall"] }) }));
    await answerPlans();
    assert.match(q('[data-testid="pictures-make-tall"]')!.textContent!, /^Tall · 1 to make.*Make 1 tall$/);
  });

  it("keeps one book read out while a run lands pictures, and asks again when the window reconnects (2026-10-24)", async () => {
    const m = await mount(inkbound(91, { shapes: ["wide", "tall"] }));
    const sheet = await openSheet();
    const picture = (key: string) => ({ key, number: 1, file: `artifacts/${key}.png`, at: 0, seconds: 30 });
    const plan = (count: number) => ({ productionId: "inkbound", title: "Inkbound", scope: { kind: "book" }, cover: null, chapters: [{ chapterId: "neap", order: 1, title: "Neap", state: "read", seconds: 90, blocks: [], gaps: [], opening: null, pictures: Array.from({ length: count }, (_, i) => picture(`p${i}`)) }] });
    const asks = () => sent(m, "open-audiobook-listening") as Array<Extract<ClientMessage, { kind: "open-audiobook-listening" }>>;
    const answer = (requestId: string, count: number) => act(async () => __applyEventForTest({ at: AT_, type: "audiobook.listening", requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", listening: plan(count) } as never));
    const progress = (made: number) => act(async () => __applyEventForTest({ at: AT_, type: "audiobook.tall-progress", worldId: FIXTURE_WORLD_ID, productionId: "inkbound", state: "making", total: 9, made, failed: [] }));
    const out = asks().at(-1)!;
    const before = asks().length;
    // Three Talls land before the book is read once: the sheet waits on the read it has out.
    await progress(1); await progress(2); await progress(3);
    assert.equal(asks().length, before, "no ask while one is out");
    await answer(out.requestId, 3);
    assert.match(sheet.querySelector('[data-testid="pictures-shape-wide"]')!.textContent!, /3 made/);
    assert.equal(asks().length, before + 1, "the pictures landed meanwhile are read once, after it");
    await answer(asks().at(-1)!.requestId, 4);
    assert.match(sheet.querySelector('[data-testid="pictures-shape-wide"]')!.textContent!, /4 made/);
    assert.equal(asks().length, before + 1, "nothing landed meanwhile, so nothing more is asked");
    // An ask out as the socket closed is never answered: the window asks again once it is back.
    await progress(4);
    const lost = asks().length;
    await act(async () => __setStateForTest(inkbound(91, { shapes: ["wide", "tall"] }), { connection: "connecting" }));
    await act(async () => __setStateForTest(inkbound(91, { shapes: ["wide", "tall"] }), { connection: "open" }));
    assert.ok(asks().length > lost);
    await answer(asks().at(-1)!.requestId, 6);
    assert.match(sheet.querySelector('[data-testid="pictures-shape-wide"]')!.textContent!, /6 made/);
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

describe("the credits (design turn 252, SPEC-047 R-210 – R-213)", () => {
  const OPENING = "Inkbound. Written by Michael Josiah. Narrated by Ife Balogun.";
  const CLOSING = "You have been listening to Inkbound, written by Michael Josiah, narrated by Ife Balogun. Copyright 2026 Michael Josiah. The End.";
  const credits = (opening: Partial<{ words: string; missing: Array<"title" | "author" | "narrator"> }> = {}) => ({
    details: { title: "Inkbound", author: "Michael Josiah", narrator: "Ife Balogun", copyright: "2026 Michael Josiah" },
    voiceLabel: "Low tide",
    opening: { words: opening.words ?? OPENING, edited: opening.words !== undefined, missing: opening.missing ?? [], state: "made" as const, seconds: 9, file: "artifacts/inkbound-opening.wav" },
    closing: { words: CLOSING, edited: false, missing: [], state: "not made" as const },
  });
  const answer = async (view: ReturnType<typeof credits>) =>
    act(async () => __applyEventForTest({ at: AT, type: "audiobook.credits", worldId: FIXTURE_WORLD_ID, productionId: "inkbound", credits: view }));

  it("asks for the credits as the page opens, and draws one row at each end of Chapters", async () => {
    const mounted = await mount(inkbound(91));
    assert.ok(mounted.sent.some((message) => message.kind === "open-audiobook-credits"), "the credits are asked for");
    await answer(credits());
    const rows = all('[data-testid="audiobook-rows"] > div');
    assert.equal(rows[0]!.getAttribute("data-credit"), "opening", "the opening comes first");
    assert.equal(rows.at(-1)!.getAttribute("data-credit"), "closing", "the closing comes last");
    assert.equal(rows.filter((row) => row.getAttribute("data-testid") === "audiobook-row").length, ROWS.length, "the chapters stay as they were");
    assert.match(rows[0]!.textContent ?? "", /Opening credits.*0:09 recorded/);
    assert.match(rows[0]!.textContent ?? "", /Narrated by Ife Balogun/);
    assert.match(rows.at(-1)!.textContent ?? "", /Closing credits.*not read/);
  });

  it("opens the Credits sheet, prices what is not read, and confirms that price on the press", async () => {
    const mounted = await mount(inkbound(91));
    await answer(credits());
    await press(q('[data-credit="closing"] .fy-abshow__go'));
    assert.ok(q('[data-testid="credits-sheet"]'), "the sheet opens");
    assert.deepEqual(all('[data-testid="credits-sheet"] .fy-vd__note-k').map((label) => label.textContent), ["Title", "Written by", "Narrated by", "Copyright"]);
    const asked = mounted.sent.findLast((message) => message.kind === "read-audiobook-chapter") as Extract<ClientMessage, { kind: "read-audiobook-chapter" }>;
    assert.equal(asked.chapterFile, "audiobook-credits");
    assert.equal(asked.confirmationToken, undefined, "opening prices; nothing is read yet");
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.priced", worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "audiobook-credits", characters: 130, estimatedMicroUsd: 10_000, confirmationToken: "token-1", voices: [] }));
    const read = q('[data-testid="credits-read"]');
    assert.equal(read?.textContent, "Read closing · ~$0.01");
    await press(read);
    const confirmed = mounted.sent.findLast((message) => message.kind === "read-audiobook-chapter") as Extract<ClientMessage, { kind: "read-audiobook-chapter" }>;
    assert.equal(confirmed.confirmationToken, "token-1");
  });

  it("says in one clause when a credit no longer names the narrator, on its row and its label", async () => {
    await mount(inkbound(91));
    await answer(credits({ words: "Inkbound, by Michael Josiah.", missing: ["narrator"] }));
    assert.equal(q('[data-credit="opening"] [data-testid="audiobook-credit-state"]')?.textContent, "names no narrator");
    await press(q('[data-credit="opening"] .fy-abshow__go'));
    assert.equal(q('[data-testid="audiobook-credit"][data-credit="opening"] [data-testid="audiobook-credit-label-state"]')?.textContent, "names no narrator");
  });
});
