import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { AudiobookListening, ChapterSummary, ClientMessage, ClientState } from "@arke-studio/contracts";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { AudiobookExportSheet, WebPackages } from "../src/components/audiobook-export.js";
import { arkePlayerCounts } from "../src/components/arke-player-export.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Export → Arke Player (design turn 233, SPEC-058 R-1, R-7): the fourth kind of the audiobook's
 * Export sheet — the world, the book, the narration read whole, its pictures, Text and loops,
 * priced in size and time — and the package made, with its SHA-256, listed in Publications.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1280, innerHeight: 800 });
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

const AT = "2026-10-21T09:00:00.000Z";
const CHAPTERS: ChapterSummary[] = [
  { id: "slack-water", file: "01-slack-water", order: 1, title: "Slack water", status: "drafted", version: 4, words: 4490, bodyHash: `sha256:${"a".repeat(64)}` },
  { id: "neap", file: "02-neap", order: 2, title: "Neap", status: "drafted", version: 4, words: 1900, bodyHash: `sha256:${"b".repeat(64)}` },
  { id: "empty", file: "03-empty", order: 3, title: "Empty", status: "outlined", version: 1, words: 0 },
];
function inkbound(): ClientState {
  const world = FIXTURE_STATE.world!;
  const salt = world.productions.find((p) => p.meta.id === "saltlight")!;
  return { ...FIXTURE_STATE, world: { ...world, productions: [...world.productions, { ...salt, meta: { ...salt.meta, id: "inkbound", format: "story" as const, title: "Inkbound" }, story: { ...(salt.story ?? { version: 1 }), version: 3 }, chapters: CHAPTERS }] } };
}
const block = (key: string, at: number, words = false) => ({ key, number: 1, file: `artifacts/${key}.wav`, at, seconds: 4, sentences: [{ at, text: key }], ...(words ? { words: [{ text: key, startSec: at, endSec: at + 1, probability: 1 }] } : {}) });
const PLAN: AudiobookListening = {
  productionId: "inkbound",
  title: "Inkbound",
  cover: "world-art.png",
  chapters: [
    { chapterId: "slack-water", order: 1, title: "Slack water", state: "read", seconds: 12, blocks: [block("t", 0, true), block("a", 4, true), block("b", 8, true)], gaps: [], pictures: [{ key: "a", number: 2, file: "artifacts/stair.png", at: 4, seconds: 8, short: true }], opening: "world-art.png" },
    { chapterId: "neap", order: 2, title: "Neap", state: "part", seconds: 4, blocks: [block("t2", 0)], gaps: [{ at: 4, from: 2, to: 3 }], pictures: [], opening: "world-art.png" },
  ],
};
const SHA = "9c41d0b27a5e3f8812c6d94b0e7a51f3c2d8846b19a0e5f7c3b61d2e48a97e07";

type Mounted = { container: HTMLElement; root: Root; sent: ClientMessage[] };
const open: Mounted[] = [];
async function mount(element: React.ReactElement): Promise<Mounted> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect: () => {}, subscribe: () => {}, send: (json: string) => sent.push(JSON.parse(json) as ClientMessage) } as unknown as ArkeBridge);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    __setStateForTest(inkbound(), { connection: "open" });
    root.render(element);
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
const q = (selector: string) => dom.document.querySelector(selector) as HTMLElement | null;
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const press = async (el: Element | null) => {
  assert.ok(el, "the thing to press exists");
  await act(async () => void el.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event));
};
const lastAsk = <K extends ClientMessage["kind"]>(m: Mounted, kind: K) => m.sent.filter((message): message is Extract<ClientMessage, { kind: K }> => message.kind === kind).at(-1);
const row = (label: string) => text([...dom.document.querySelectorAll(".fy-abv-opt")].find((el) => text(el.querySelector("b")) === label) ?? null);

describe("Export → Arke Player (turn 233)", () => {
  it("counts what the package would hold from the plan the player plays", () => {
    const counts = arkePlayerCounts(PLAN, { book: true, motion: true });
    assert.deepEqual([counts.chapters, counts.of, counts.range, counts.pictures, counts.loops, counts.wordsTimed], [1, 2, "Chapter 1", 2, 0, 1]);
    assert.ok(counts.bytes > arkePlayerCounts(PLAN, { book: false, motion: true }).bytes, "the book has its size");
  });

  it("offers Arke Player as a fourth kind, with its rows, and makes the package on the desktop", async () => {
    const production = inkbound().world!.productions.find((p) => p.meta.id === "inkbound")!;
    const m = await mount(<AudiobookExportSheet worldId={FIXTURE_WORLD_ID} production={production} onClose={() => {}} />);
    const ask = lastAsk(m, "open-audiobook-listening")!;
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.listening", requestId: ask.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", listening: { ...PLAN, scope: { kind: "book" } } }));
    await press(q('[data-testid="audiobook-export-arke-player"]'));
    assert.match(row("Book"), /The book.*2 chapters · EPUB/, "a chapter with no prose is not in the book");
    assert.match(row("Narration"), /1 of 2 · read whole.*Chapter 1/);
    assert.match(row("Pictures"), /2 · fitted for a phone/);
    assert.match(row("Text"), /words timed in 1 of 1/);
    assert.match(row("Motion"), /None/);
    assert.match(text(q('[data-testid="arke-player-estimate"]')), /^~\d+ MB · ~\d+ min on this machine/);

    await press([...dom.document.querySelectorAll('[role="checkbox"]')].find((el) => text(el) === "The book")!);
    await press(q('[data-testid="arke-player-start"]'));
    const asked = lastAsk(m, "export-arke-player")!;
    assert.match(asked.exportId, /^ap_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.deepEqual(asked.options, { book: false, motion: true });
    assert.ok(q('[data-testid="arke-player-making"]'));

    // Made (233c): its file and size, and its SHA-256 in full to copy.
    await act(async () => __applyEventForTest({ at: AT, type: "arke-player.exported", requestId: asked.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", exportId: asked.exportId, result: { ok: true, file: "exports/the-undersong-player-2026-10-21.zip", bytes: 228 * 1024 ** 2, sha256: SHA, edition: "2026-10-21", chapters: 1, pictures: 2, book: false } }));
    const done = text(q('[data-testid="arke-player-done"]'));
    assert.match(done, /1 package · 228 MB/);
    assert.match(done, /the-undersong-player-2026-10-21\.zip/);
    assert.match(done, /1 chapter · 2 pictures · 228 MB/);
    assert.ok(done.includes(SHA));
    assert.ok([...dom.document.querySelectorAll("button")].some((button) => text(button) === "Copy"));
  });

  it("says what stood in the way, one clause each (233d)", async () => {
    const production = inkbound().world!.productions.find((p) => p.meta.id === "inkbound")!;
    const m = await mount(<AudiobookExportSheet worldId={FIXTURE_WORLD_ID} production={production} onClose={() => {}} />);
    const ask = lastAsk(m, "open-audiobook-listening")!;
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.listening", requestId: ask.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", listening: { ...PLAN, scope: { kind: "book" } } }));
    await press(q('[data-testid="audiobook-export-arke-player"]'));
    await press(q('[data-testid="arke-player-start"]'));
    const asked = lastAsk(m, "export-arke-player")!;
    await act(async () => __applyEventForTest({ at: AT, type: "arke-player.exported", requestId: asked.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", exportId: asked.exportId, result: { ok: false, blockers: ["Chapter 4 · The Weir · its loop won’t play · use its still", "Chapter 9 · a picture outside this world"] } }));
    assert.deepEqual([...dom.document.querySelectorAll(".fy-abv-warn")].map((el) => text(el)), ["Chapter 4 · The Weir · its loop won’t play · use its still", "Chapter 9 · a picture outside this world"]);
    assert.equal(q('[data-testid="arke-player-start"]')?.hasAttribute("disabled"), false, "Make package again once they are cleared");
  });

  it("lists the package in Publications with its size and Copy SHA-256 (233e)", async () => {
    const m = await mount(<WebPackages worldId={FIXTURE_WORLD_ID} />);
    const ask = lastAsk(m, "list-web-packages")!;
    await act(async () => __applyEventForTest({ at: AT, type: "web-packages.listed", requestId: ask.requestId, worldId: FIXTURE_WORLD_ID, packages: [{ kind: "arke-player", productionId: "inkbound", title: "The Undersong", dir: "exports/the-undersong-player-2026-10-21.zip", exportedAt: AT, exportId: "ap_01J8G000000000000000000001", file: "exports/the-undersong-player-2026-10-21.zip", bytes: 228 * 1024 ** 2, sha256: SHA, holds: "12 chapters · 131 pictures · the book" }] }));
    const listed = text(q('[data-testid="web-package"]'));
    assert.match(listed, /The Undersong.*Arke Player · 2026-10-21 · 12 chapters · 131 pictures · the book · 228 MB/);
    assert.ok([...dom.document.querySelectorAll("button")].some((button) => text(button) === "Copy SHA-256"));
  });
});
