import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type { AudiobookDoor, ChapterSummary, ClientMessage, ClientState } from "@arke-studio/contracts";
import { AudiobookScreen } from "../src/screens/audiobook.js";
import { ProductionLayout } from "../src/screens/production-shell.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __applyEventForTest, __handleFrameForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The Audiobook door (design turn 146, SPEC-047 R-12, R-15, R-17, R-29): a row a chapter with
 * its state as the coordinator answered it, the voices beside `Narrator · Cast` with the
 * speaker who has no voice said in warning, `Read the book` with its count and price, the
 * price asked once and answered by token, and a row opening the chapter's Audiobook view.
 * The rail's count is the door's answer too.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
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

const AT = "2026-09-14T09:00:00.000Z";
const ROUTE = `/w/${FIXTURE_WORLD_ID}/p/inkbound/story/audiobook`;
const CHAPTERS: ChapterSummary[] = [
  { id: "slack-water", file: "01-slack-water", order: 1, title: "Slack water", status: "drafted", version: 4, words: 4490, bodyHash: `sha256:${"a".repeat(64)}` },
  { id: "neap", file: "02-neap", order: 2, title: "The counting of bells", status: "drafting", version: 4, words: 1900, bodyHash: `sha256:${"b".repeat(64)}` },
  { id: "below", file: "03-below-the-harbour", order: 3, title: "Below the harbour", status: "planned", version: 1, words: 0 },
];

function inkbound(reading: "narrator" | "cast" = "narrator"): ClientState {
  const world = FIXTURE_STATE.world!;
  const salt = world.productions.find((p) => p.meta.id === "saltlight")!;
  return {
    ...FIXTURE_STATE,
    world: {
      ...world,
      productions: [
        ...world.productions,
        {
          ...salt,
          meta: { ...salt.meta, id: "inkbound", format: "story" as const, title: "Inkbound" },
          story: { ...(salt.story ?? { version: 1 }), version: 3 },
          chapters: CHAPTERS,
          ...(reading === "cast" ? { audiobook: { schemaVersion: 1 as const, reading } } : {}),
        },
      ],
    },
  };
}

const door = (reading: "narrator" | "cast", extra: Partial<AudiobookDoor> = {}): AudiobookDoor => ({
  reading,
  voices: [{ name: "George", voice: { label: "George", provider: "kokoro", local: true }, state: "narrator", blocks: 40 }],
  unattributed: 0,
  rows: [
    { chapterId: "slack-water", file: "01-slack-water", order: 1, title: "Slack water", version: 4, planned: false, total: 24, made: 24, stale: 0, flagged: 0, notMade: 0, seconds: 1864 },
    { chapterId: "neap", file: "02-neap", order: 2, title: "The counting of bells", version: 4, planned: false, total: 26, made: 22, stale: 0, flagged: 1, notMade: 3, seconds: 1200 },
    { chapterId: "below", file: "03-below-the-harbour", order: 3, title: "Below the harbour", version: 1, planned: true, total: 0, made: 0, stale: 0, flagged: 0, notMade: 0, seconds: 0 },
  ],
  price: { chapters: 1, blocks: 4, cloudBlocks: 0, characters: 0, estimatedMicroUsd: 0, voices: [{ label: "George", provider: "kokoro", local: true, characters: 610, estimatedMicroUsd: 0 }] },
  ...extra,
});

type Mounted = { container: HTMLElement; root: Root; sent: ClientMessage[]; where: () => string };
const open: Mounted[] = [];
let location = "";
function Where() {
  location = useLocation().pathname + useLocation().search;
  return null;
}

async function mount(state: ClientState, route = ROUTE, withRail = false): Promise<Mounted> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect: () => {}, subscribe: () => {}, send: (json: string) => sent.push(JSON.parse(json) as ClientMessage) } as unknown as ArkeBridge);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    __setStateForTest(state, { connection: "open" });
    root.render(
      <MemoryRouter initialEntries={[route]}>
        <Where />
        <Routes>
          {withRail ? (
            <Route path="/w/:worldId/p/:prodId" element={<ProductionLayout />}>
              <Route path="story/audiobook" element={<AudiobookScreen />} />
            </Route>
          ) : (
            <Route path="/w/:worldId/p/:prodId/story/audiobook" element={<AudiobookScreen />} />
          )}
          <Route path="/w/:worldId/p/:prodId/story/chapters/:chapterId" element={<div data-testid="chapter-opened" />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  const mounted = { container, root, sent, where: () => location };
  open.push(mounted);
  return mounted;
}

afterEach(async () => {
  for (const mounted of open.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
});

const text = (m: Mounted): string => m.container.textContent ?? "";
const q = (m: Mounted, selector: string): HTMLElement | null => m.container.querySelector(selector) as HTMLElement | null;
const all = (m: Mounted, selector: string): HTMLElement[] => [...m.container.querySelectorAll(selector)] as HTMLElement[];

async function answerDoor(m: Mounted, answer: AudiobookDoor): Promise<void> {
  const ask = m.sent.findLast((message) => message.kind === "open-audiobook") as Extract<ClientMessage, { kind: "open-audiobook" }>;
  assert.ok(ask, "the door is asked for");
  await act(async () => __applyEventForTest({ at: AT, type: "audiobook.door", requestId: ask.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", door: answer }));
}

describe("the Audiobook door (turn 146)", () => {
  it("shows a row a chapter with its state, the count and running time over them, the read bar, and opens a chapter's Audiobook view", async () => {
    const m = await mount(inkbound());
    assert.match(text(m), /Audiobook/);
    await answerDoor(m, door("narrator"));
    assert.equal(q(m, '[data-testid="audiobook-line"]')?.textContent, "1 of 2 chapters read · 31:04 · 1 planned");
    const rows = all(m, '[data-testid="audiobook-row"]');
    assert.deepEqual(
      rows.map((row) => row.querySelector(".fy-row__meta")?.textContent),
      ["read · 31:04", "22 of 26 made · 1 flagged", "planned"],
    );
    assert.equal(q(m, '[data-testid="audiobook-bar"]')?.getAttribute("aria-valuenow"), "46");
    assert.equal(q(m, '[data-testid="read-book"]')?.textContent, "Read the book · 1 chapter", "a local narrator costs nothing, so no price rides on the press");
    assert.ok(!/\bis\b.*\bbecause\b/.test(text(m)), "no sentence explains the door");
    await act(async () => rows[1]!.click());
    assert.equal(m.where(), `/w/${FIXTURE_WORLD_ID}/p/inkbound/story/chapters/neap?view=audiobook`, "a row opens the chapter in its Audiobook view");
  });

  it("the voices row says who reads and who has no voice under Cast, and only the narrator under Narrator (R-12)", async () => {
    const m = await mount(inkbound());
    await answerDoor(m, door("narrator"));
    assert.deepEqual(all(m, '[data-testid="audiobook-voice"]').map((chip) => chip.getAttribute("data-state")), ["narrator"]);
    assert.doesNotMatch(text(m), /no voice/);
    await act(async () => all(m, '[aria-label="Reading"] button').find((b) => b.textContent === "Cast")!.click());
    assert.deepEqual(m.sent.filter((message) => message.kind === "set-audiobook-reading").map((message) => (message as Extract<ClientMessage, { kind: "set-audiobook-reading" }>).reading), ["cast"]);
    await answerDoor(
      m,
      door("cast", {
        voices: [
          { name: "George", voice: { label: "George", provider: "kokoro", local: true }, state: "narrator", blocks: 19 },
          { sheet: "maren-kest", name: "Maren Kest", voice: { label: "Anna", provider: "elevenlabs", local: false }, state: "reads", blocks: 4 },
          { sheet: "odile-sarn", name: "Odile Sarn", state: "no voice", blocks: 3 },
        ],
        unattributed: 2,
      }),
    );
    const chips = all(m, '[data-testid="audiobook-voice"]');
    assert.deepEqual(chips.map((chip) => chip.getAttribute("data-state")), ["narrator", "reads", "no voice", "no voice"]);
    assert.match(chips[1]!.textContent ?? "", /Maren KestAnna · elevenlabs · 4 blocks/);
    assert.match(chips[2]!.textContent ?? "", /Odile Sarnno voice · narrator · 3 blocks/);
    assert.ok(chips[2]!.className.includes("fy-abdoor__voice--warn"), "in warning");
    assert.match(chips[3]!.textContent ?? "", /unattributedno voice · narrator · 2 blocks/);
  });

  it("Read the book is priced once, each voice named, and answered by token or declined (R-17)", async () => {
    const m = await mount(inkbound("cast"));
    await answerDoor(
      m,
      door("cast", {
        price: {
          chapters: 9,
          blocks: 120,
          cloudBlocks: 41,
          characters: 9400,
          estimatedMicroUsd: 940_000,
          voices: [
            { label: "George", provider: "kokoro", local: true, characters: 99_000, estimatedMicroUsd: 0 },
            { label: "Anna", provider: "elevenlabs", local: false, characters: 9400, estimatedMicroUsd: 940_000 },
            { label: "George", provider: "kokoro", speaker: "Odile Sarn", substituted: "no voice", local: true, characters: 300, estimatedMicroUsd: 0 },
          ],
        },
      }),
    );
    const press = q(m, '[data-testid="read-book"]')!;
    assert.equal(press.textContent, "Read the book · 9 chapters · $0.94");
    await act(async () => press.click());
    const presses = () => m.sent.filter((message) => message.kind === "read-audiobook-book");
    assert.equal(presses().length, 1);
    const ids = { worldId: FIXTURE_WORLD_ID, productionId: "inkbound" };
    const priced = async () => {
      await act(async () => __applyEventForTest({ at: AT, type: "audiobook.book-started", ...ids, requestId: "01J8F3K2QW9VZX4N7M0RTYB6H1", chapters: 9, blocks: 120 }));
      await act(async () =>
        __applyEventForTest({
          at: AT,
          type: "audiobook.book-priced",
          ...ids,
          chapters: 9,
          blocks: 120,
          cloudBlocks: 41,
          characters: 9400,
          estimatedMicroUsd: 940_000,
          confirmationToken: "tok",
          voices: [
            { label: "George", provider: "kokoro", local: true, characters: 99_000, estimatedMicroUsd: 0 },
            { label: "Anna", provider: "elevenlabs", local: false, characters: 9400, estimatedMicroUsd: 940_000 },
            { label: "George", provider: "kokoro", speaker: "Odile Sarn", substituted: "no voice", local: true, characters: 300, estimatedMicroUsd: 0 },
          ],
        }),
      );
    };
    await priced();
    assert.ok(q(m, '[data-testid="read-book-sheet"]'), "the price, once");
    // Declined: the sheet goes, nothing is sent, and the press stands for another day.
    await act(async () => all(m, "button").find((b) => b.textContent === "Cancel")!.click());
    assert.equal(q(m, '[data-testid="read-book-sheet"]'), null);
    assert.equal(presses().length, 1, "a decline sends nothing");
    await act(async () => q(m, '[data-testid="read-book"]')!.click());
    assert.equal(presses().length, 2);
    await priced();
    const sheet = q(m, '[data-testid="read-book-sheet"]');
    assert.ok(sheet, "priced again on the next press");
    assert.match(text(m), /9 chapters · 9,400 characters · 41 cloud lines/);
    const lines = all(m, '[data-testid="read-book-line"]').map((line) => line.textContent);
    assert.deepEqual(lines, ["Georgenarrator · kokoro · local99,000 · free", "Annaelevenlabs9,400 · $0.94", "Odile Sarnno voice · narrator300 · free"]);
    assert.match(text(m), /words and the voice to elevenlabs · text in Activity/);
    const confirm = q(m, '[data-testid="read-book-confirm"]')!;
    assert.equal(confirm.textContent, "Confirm 9,400 characters · $0.94");
    await act(async () => confirm.click());
    const answered = m.sent.findLast((message) => message.kind === "read-audiobook-book") as Extract<ClientMessage, { kind: "read-audiobook-book" }>;
    assert.equal(answered.confirmationToken, "tok");
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.book-started", ...ids, requestId: "01J8F3K2QW9VZX4N7M0RTYB6H1", chapters: 9, blocks: 120 }));
    assert.match(text(m), /reading… 0 of 9 chapters/);
    assert.ok(all(m, "button").some((b) => b.textContent === "Stop"));
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.book-progress", ...ids, chapterId: "slack-water", done: 3, chapters: 9 }));
    assert.match(text(m), /reading… 3 of 9 chapters/);
    // Every chapter's record refreshes the world, and the refresh replays the start with no
    // counts: what the window knows stands.
    const replayed = { at: AT, type: "audiobook.book-started" as const, ...ids, requestId: "01J8F3K2QW9VZX4N7M0RTYB6H1", chapters: 0, blocks: 0, replayed: true as const };
    await act(async () => __handleFrameForTest({ kind: "snapshot", seq: 3, state: inkbound("cast") }));
    await act(async () => __applyEventForTest(replayed));
    assert.match(text(m), /reading… 3 of 9 chapters/);
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.book-finished", ...ids, outcome: "stopped", chaptersRead: 3, chaptersRefused: 0, made: 40, flagged: 0 }));
    await act(async () => __handleFrameForTest({ kind: "snapshot", seq: 5, state: inkbound("cast") }));
    await act(async () => __applyEventForTest(replayed));
    assert.match(q(m, '[data-testid="audiobook-note"]')?.textContent ?? "", /stopped · the takes made stand/);
    assert.ok(!all(m, "button").some((b) => b.textContent === "Stop"), "a late replay does not flip a stopped book back to reading");
    assert.ok(q(m, '[data-testid="read-book"]'), "the press is back, for the rest");
  });

  it("the rail says how many chapters are read, from the door's answer (R-29)", async () => {
    const m = await mount(inkbound(), ROUTE, true);
    const rail = all(m, ".fy-prodrail__item").find((item) => item.textContent?.includes("Audiobook"));
    assert.ok(rail, "Audiobook sits on the story rail");
    assert.match(rail.textContent ?? "", /—/);
    await answerDoor(m, door("narrator"));
    assert.match(rail.textContent ?? "", /1\/2/);
    const items = all(m, ".fy-prodrail__item").map((item) => item.textContent?.replace(/[0-9—/]+$/, "").trim());
    const chapters = items.findIndex((label) => label?.startsWith("Chapters"));
    assert.equal(items[chapters + 1]?.startsWith("Audiobook"), true, "between Chapters and Artifacts");
    // A door that could not be read answers with the reason, never with a screen left opening.
    const ask = m.sent.findLast((message) => message.kind === "open-audiobook") as Extract<ClientMessage, { kind: "open-audiobook" }>;
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.door", requestId: ask.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", door: null, refused: "the chapter file is gone" }));
    assert.match(rail.textContent ?? "", /—/);
    assert.match(text(m), /the chapter file is gone/);
    assert.doesNotMatch(text(m), /Opening…/);
  });
});
