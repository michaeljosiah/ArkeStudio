import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import type { AudiobookDoor, AudiobookListening, ChapterSummary, ClientMessage, ClientState } from "@arke-studio/contracts";
import { AudiobookScreen } from "../src/screens/audiobook.js";
import { bookHasTakes, playerChapters } from "../src/components/audiobook-player.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { claimRead } from "../src/lib/reply-reads.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Listen (design turn 186, SPEC-047 R-66, R-67): the book as a listener hears it, opened over the
 * window from the audiobook door once a block anywhere is made, fed the coordinator's plan, and
 * fed it again while a chapter is read under it — without the player starting over.
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

const AT = "2026-10-03T09:00:00.000Z";
const ROUTE = `/w/${FIXTURE_WORLD_ID}/p/inkbound/story/audiobook`;
const stamp = (takes: number) => ({ chapterVersion: 4, hash: "h", updatedAt: AT, takes, flagged: 0 });
const chapters = (takes: number): ChapterSummary[] => [
  { id: "slack-water", file: "01-slack-water", order: 1, title: "Slack water", status: "drafted", version: 4, words: 4490, bodyHash: `sha256:${"a".repeat(64)}`, ...(takes > 0 ? { audiobook: stamp(takes) } : {}) },
  { id: "neap", file: "02-neap", order: 2, title: "The counting of bells", status: "drafting", version: 4, words: 1900, bodyHash: `sha256:${"b".repeat(64)}` },
];

function inkbound(takes: number): ClientState {
  const world = FIXTURE_STATE.world!;
  const salt = world.productions.find((p) => p.meta.id === "saltlight")!;
  return {
    ...FIXTURE_STATE,
    world: {
      ...world,
      productions: [...world.productions, { ...salt, meta: { ...salt.meta, id: "inkbound", format: "story" as const, title: "Inkbound" }, story: { ...(salt.story ?? { version: 1 }), version: 3 }, chapters: chapters(takes) }],
    },
  };
}

const DOOR: AudiobookDoor = {
  reading: "narrator",
  voices: [{ name: "George", voice: { label: "George", provider: "kokoro", local: true }, state: "narrator", blocks: 4 }],
  unattributed: 0,
  rows: [
    { chapterId: "slack-water", file: "01-slack-water", order: 1, title: "Slack water", version: 4, planned: false, total: 3, made: 2, stale: 0, flagged: 0, notMade: 1, seconds: 14 },
    { chapterId: "neap", file: "02-neap", order: 2, title: "The counting of bells", version: 4, planned: false, total: 3, made: 0, stale: 0, flagged: 0, notMade: 3, seconds: 0 },
  ],
  price: { chapters: 2, blocks: 4, cloudBlocks: 0, characters: 0, estimatedMicroUsd: 0, voices: [] },
};

const sentence = (at: number, text: string) => [{ at, text }];
function listening(made: number): AudiobookListening {
  const blocks = [
    { key: "title", number: 1, file: "artifacts/t.wav", at: 0, seconds: 4, sentences: sentence(0, "Chapter 1 · Slack water") },
    { key: "p0.0", number: 2, file: "artifacts/a.wav", at: 4, seconds: 10, sentences: sentence(4, "The bell rang twice.") },
    { key: "p1.0", number: 3, file: "artifacts/b.wav", at: 14, seconds: 6, sentences: sentence(14, "Odile did not answer.") },
  ].slice(0, made);
  const seconds = blocks.reduce((sum, block) => sum + block.seconds, 0);
  return {
    productionId: "inkbound",
    title: "Inkbound",
    cover: "world-art.png",
    chapters: [
      { chapterId: "slack-water", order: 1, title: "Slack water", state: made === 3 ? "read" : "part", seconds, blocks, gaps: made === 3 ? [] : [{ at: seconds, from: made + 1, to: 3 }], pictures: [], opening: "world-art.png" },
      { chapterId: "neap", order: 2, title: "The counting of bells", state: "not read", seconds: 0, blocks: [], gaps: [{ at: 0, from: 1, to: 12 }], pictures: [], opening: "world-art.png" },
    ],
  };
}

type Mounted = { container: HTMLElement; root: Root; sent: ClientMessage[] };
const open: Mounted[] = [];
async function mount(state: ClientState): Promise<Mounted> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect: () => {}, subscribe: () => {}, send: (json: string) => sent.push(JSON.parse(json) as ClientMessage) } as unknown as ArkeBridge);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    __setStateForTest(state, { connection: "open" });
    root.render(
      <MemoryRouter initialEntries={[ROUTE]}>
        <Routes>
          <Route path="/w/:worldId/p/:prodId/story/audiobook" element={<AudiobookScreen />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  const mounted = { container, root, sent };
  open.push(mounted);
  return mounted;
}

afterEach(async () => {
  for (const mounted of open.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
});

// The player is drawn on the body, outside the screen that opened it: found from the document.
const q = (m: Mounted, selector: string): HTMLElement | null => (m.container.querySelector(selector) ?? dom.document.querySelector(selector)) as HTMLElement | null;
const all = (selector: string) => dom.document.querySelectorAll(selector);
const press = async (element: Element | null) => {
  assert.ok(element, "the thing to press exists");
  await act(async () => void element.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event));
};
const asks = (m: Mounted) => m.sent.filter((message): message is Extract<ClientMessage, { kind: "open-audiobook-listening" }> => message.kind === "open-audiobook-listening");
async function answer(m: Mounted, plan: AudiobookListening): Promise<void> {
  const ask = asks(m).at(-1);
  assert.ok(ask, "the plan is asked for");
  await act(async () => __applyEventForTest({ at: AT, type: "audiobook.listening", requestId: ask.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", listening: plan }));
}

describe("Listen (turn 186)", () => {
  it("waits for one made block anywhere in the book", async () => {
    assert.equal(bookHasTakes({ chapters: chapters(0) }), false);
    assert.equal(bookHasTakes({ chapters: chapters(2) }), true);
    const m = await mount(inkbound(0));
    // Not drawn, not disabled (design turn 199): until a block is made, Read the book leads.
    assert.equal(q(m, '[data-testid="audiobook-listen"]'), null);
  });

  it("opens the player over the window on the coordinator's plan, a chapter read in part included", async () => {
    const m = await mount(inkbound(2));
    await press(q(m, '[data-testid="audiobook-listen"]'));
    assert.equal(asks(m).length, 1, "the plan is asked for once");
    assert.match(q(m, '[data-testid="audiobook-player"]')?.textContent ?? "", /opening…/);
    await answer(m, listening(2));
    const player = q(m, ".abp");
    assert.ok(player, "the player is mounted");
    assert.match(q(m, ".abp-chap")?.textContent ?? "", /Chapter 01 · Slack water/);
    assert.equal(all(".abp-line u").length, 1, "the unread blocks are marked");
    assert.match((q(m, "audio") as HTMLAudioElement | null)?.getAttribute("src") ?? "", /artifacts\/t\.wav/, "the takes are served by the app");
  });

  it("asks again when a take lands, and the running player takes the new plan in place", async () => {
    const m = await mount(inkbound(2));
    await press(q(m, '[data-testid="audiobook-listen"]'));
    await answer(m, listening(2));
    const player = q(m, ".abp");
    await act(async () => __setStateForTest(inkbound(3), { connection: "open" }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1300)));
    assert.equal(asks(m).length, 2, "asked again a breath after the book moved");
    await answer(m, listening(3));
    assert.ok(q(m, ".abp") === player, "the same player, not started over");
    assert.equal(all(".abp-line u").length, 0, "the gap is filled");
  });

  it("is a modal while it waits for its plan: Esc closes it (codex on PR 1493)", async () => {
    const m = await mount(inkbound(2));
    await press(q(m, '[data-testid="audiobook-listen"]'));
    const shell = q(m, '[data-testid="audiobook-player"]');
    assert.equal(shell?.getAttribute("role"), "dialog");
    await act(async () => {
      const event = new dom.Event("keydown", { bubbles: true }) as unknown as KeyboardEvent;
      Object.assign(event, { key: "Escape" });
      shell!.dispatchEvent(event);
    });
    assert.equal(q(m, '[data-testid="audiobook-player"]'), null);
  });

  it("stops a read still being made as it opens, so its first piece never lands over the book (codex on PR 1495)", async () => {
    let stopped = false;
    claimRead("page-read:test", () => {
      stopped = true;
    });
    const m = await mount(inkbound(2));
    await press(q(m, '[data-testid="audiobook-listen"]'));
    assert.equal(stopped, true);
    // A read that takes the voice while the book is open pauses it; the book's next play takes it back.
    await answer(m, listening(2));
    let second = false;
    claimRead("page-read:later", () => {
      second = true;
    });
    await press(q(m, '.abp [data-act="toggle"]'));
    if (q(m, '.abp [data-act="toggle"]')?.getAttribute("aria-label") === "Play") await press(q(m, '.abp [data-act="toggle"]'));
    assert.equal(second, true, "the later read is stopped when the book plays again");
  });

  it("closes from the player's own Close", async () => {
    const m = await mount(inkbound(2));
    await press(q(m, '[data-testid="audiobook-listen"]'));
    await answer(m, listening(2));
    await press(q(m, '.abp [aria-label="Close"]'));
    assert.equal(q(m, '[data-testid="audiobook-player"]'), null);
  });

  it("draws the player on the body, never inside the animated title row (owner, 2026-10-03)", async () => {
    // `.fy-h1row` enters with fy-fade-up; a transformed ancestor made the fixed player an
    // invisible box over the row, and the head disappeared under it.
    const m = await mount(inkbound(2));
    await press(q(m, '[data-testid="audiobook-listen"]'));
    const shell = q(m, '[data-testid="audiobook-player"]');
    assert.ok(shell, "the player opened");
    assert.equal(shell.parentElement, dom.document.body as unknown as HTMLElement, "a child of the body");
    assert.equal(shell.closest(".fy-h1row"), null);
    assert.equal(shell.closest(".fy-fade-up, .fy-prodmain"), null, "outside every animated container of the screen");
    assert.equal(m.container.contains(shell), false);
    await press(q(m, '.fy-abplayer__wait button'));
    assert.equal(q(m, '[data-testid="audiobook-player"]'), null, "and gone from the body when closed");
  });

  it("is the hero's primary, with a play mark, once a block is made — Export follows and Read the book stands back (199)", async () => {
    const none = await mount(inkbound(0));
    const doorAsk0 = none.sent.filter((message): message is Extract<ClientMessage, { kind: "open-audiobook" }> => message.kind === "open-audiobook").at(-1)!;
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.door", requestId: doorAsk0.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", door: DOOR }));
    assert.equal(q(none, '[data-testid="audiobook-listen"]'), null, "nothing to hear: no Listen");
    assert.equal(q(none, '[data-testid="audiobook-export-open"]'), null, "and no Export");
    assert.ok(q(none, '[data-testid="read-book"]')?.classList.contains("fy-abshow__btn--pri"), "Read the book leads");
    await act(async () => none.root.unmount());
    open.splice(0);
    none.container.remove();
    const m = await mount(inkbound(2));
    const doorAsk = m.sent.filter((message): message is Extract<ClientMessage, { kind: "open-audiobook" }> => message.kind === "open-audiobook").at(-1)!;
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.door", requestId: doorAsk.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", door: DOOR }));
    const listen = q(m, '[data-testid="audiobook-listen"]');
    assert.equal(listen?.classList.contains("fy-abshow__btn--pri"), true);
    assert.equal(q(m, '[data-testid="read-book"]')?.classList.contains("fy-abshow__btn--pri"), false, "the read of the rest stands back");
    assert.ok(listen?.querySelector("svg"));
    const head = q(m, '[data-testid="audiobook-presses"]')!;
    const order = [...head.querySelectorAll("button")].map((button) => button.getAttribute("data-testid"));
    assert.deepEqual(order, ["audiobook-listen", "audiobook-export-open", "read-book", "audiobook-more"], "Listen, Export, Read the book, ⋯");
    assert.equal(head.querySelectorAll(".fy-abshow__btn--pri").length, 1, "one primary in the hero");
  });

  it("serves every file the plan names through the app", () => {
    const chapters_ = playerChapters({ ...listening(3), chapters: [{ ...listening(3).chapters[0]!, pictures: [{ key: "p1.0", number: 3, file: "artifacts/p.png", at: 14, seconds: 6, short: true, focus: { x: 0.7, y: 0.3 } }] }] }, (file) => `/media/w/${file}`);
    assert.equal(chapters_[0]!.blocks[1]!.src, "/media/w/artifacts/a.wav");
    assert.deepEqual(chapters_[0]!.pictures, [{ at: 14, seconds: 6, src: "/media/w/artifacts/p.png", focus: { x: 0.7, y: 0.3 } }]);
    assert.equal(chapters_[0]!.opening, "/media/w/world-art.png");
  });
});
