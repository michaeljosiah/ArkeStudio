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
    // An Audio Studio chapter is carried by its one mix, though it holds no speech block.
    const mixed: AudiobookListening = { ...PLAN, chapters: [...PLAN.chapters, { chapterId: "weir", order: 3, title: "The Weir", state: "read", seconds: 30, blocks: [], gaps: [], pictures: [], opening: null, mix: { file: "audio/weir.wav", seconds: 30 }, audioStudio: { revision: 1, issues: [], omissions: [] } }] };
    assert.equal(arkePlayerCounts(mixed, { book: true, motion: true }).chapters, 2);
  });

  it("counts each moment's Tall, and a smaller Size makes a smaller package (turn 235, SPEC-058 R-41, R-42)", async () => {
    const tall: AudiobookListening = { ...PLAN, chapters: PLAN.chapters.map((chapter) => ({ ...chapter, pictures: chapter.pictures.map((picture) => ({ ...picture, tall: "artifacts/stair-tall.png" })) })) };
    const counts = arkePlayerCounts(tall, { book: true, motion: true });
    assert.deepEqual([counts.pictures, counts.tall], [2, 1]);
    assert.ok(counts.bytes > arkePlayerCounts(PLAN, { book: true, motion: true }).bytes, "the Tall pictures have their size");
    assert.ok(arkePlayerCounts(tall, { book: true, motion: true, size: "960" }).bytes < counts.bytes, "960 is smaller than Full");

    const production = inkbound().world!.productions.find((p) => p.meta.id === "inkbound")!;
    const m = await mount(<AudiobookExportSheet worldId={FIXTURE_WORLD_ID} production={production} onClose={() => {}} />);
    const ask = lastAsk(m, "open-audiobook-listening")!;
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.listening", requestId: ask.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", listening: { ...tall, scope: { kind: "book" } } }));
    await press(q('[data-testid="audiobook-export-arke-player"]'));
    assert.match(row("Pictures"), /2 wide · 1 tall/);
    const estimate = () => text(q('[data-testid="arke-player-estimate"]'));
    const full = estimate();
    assert.match(full, /3 pictures/);
    await press([...q('[data-testid="arke-player-size"]')!.querySelectorAll("button")].find((button) => text(button) === "960 px")!);
    assert.equal(q('[data-testid="arke-player-size"] [aria-checked="true"]')?.textContent, "960 px");
    assert.notEqual(estimate(), full, "the estimate follows the Size");
    await press(q('[data-testid="arke-player-start"]'));
    assert.deepEqual(lastAsk(m, "export-arke-player")!.options, { book: true, motion: true, size: "960" });
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
    // A world with nothing public carries no guide, and its row says so (SPEC-059 R-15, 234c).
    assert.match(row("Guide"), /None public.*Edit/);
    assert.match(text(q('[data-testid="arke-player-estimate"]')), /^~\d+ MB · ~\d+ min on this machine/);

    await press([...dom.document.querySelectorAll('[role="checkbox"]')].find((el) => text(el) === "The book")!);
    await press(q('[data-testid="arke-player-start"]'));
    const asked = lastAsk(m, "export-arke-player")!;
    assert.match(asked.exportId, /^ap_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.deepEqual(asked.options, { book: false, motion: true, size: "full" });
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

  it("releases the chapters read whole since the last release as a part, with the author's schedule (turn 236d, 236e)", async () => {
    const plan: AudiobookListening = {
      ...PLAN,
      chapters: [
        PLAN.chapters[0]!,
        { ...PLAN.chapters[0]!, chapterId: "neap", order: 2, title: "Neap" },
        { ...PLAN.chapters[0]!, chapterId: "weir", order: 3, title: "The Weir" },
        { chapterId: "empty", order: 4, title: "Empty", state: "part", seconds: 4, blocks: [block("t4", 0)], gaps: [{ at: 4, from: 2, to: 6 }], pictures: [], opening: null },
      ],
    };
    const edition = { kind: "arke-player" as const, productionId: "inkbound", title: "The Undersong", dir: "exports/the-undersong-player-2026-10-22.zip", file: "exports/the-undersong-player-2026-10-22.zip", exportedAt: "2026-10-22T09:00:00.000Z", bytes: 360 * 1024 ** 2, sha256: SHA, holds: "1 chapter · 1 picture · the book", release: { edition: "2026-10-22", fingerprint: "a".repeat(64), chapters: [{ id: "slack-water", order: 1, title: "Slack water" }] } };
    const part = { ...edition, dir: "exports/the-undersong-part-2026-10-30.zip", file: "exports/the-undersong-part-2026-10-30.zip", exportedAt: "2026-10-30T09:00:00.000Z", bytes: 24 * 1024 ** 2, holds: "1 chapter · 1 picture", release: { edition: "2026-10-30", fingerprint: "b".repeat(64), chapters: [{ id: "neap", order: 2, title: "Neap" }], part: { follows: "2026-10-22", fingerprint: "a".repeat(64), number: 1, schedule: { day: "friday" as const } } } };
    const production = inkbound().world!.productions.find((p) => p.meta.id === "inkbound")!;
    const m = await mount(<AudiobookExportSheet worldId={FIXTURE_WORLD_ID} production={production} onClose={() => {}} />);
    const ask = lastAsk(m, "open-audiobook-listening")!;
    await act(async () => __applyEventForTest({ at: AT, type: "audiobook.listening", requestId: ask.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", listening: { ...plan, scope: { kind: "book" } } }));
    const answerLists = async (packages: Array<typeof edition>) => {
      for (const asked of m.sent.filter((message) => message.kind === "list-web-packages")) await act(async () => __applyEventForTest({ at: AT, type: "web-packages.listed", requestId: (asked as { requestId: string }).requestId, worldId: FIXTURE_WORLD_ID, packages }));
    };
    await answerLists([part, edition]);
    await press(q('[data-testid="audiobook-export-arke-player"]'));
    // Since names the newest release, its day and its last chapter (R-43).
    assert.match(row("Release"), /Whole world.*New chapters.*since 30 Oct 2026 · Chapter 2/);
    await press([...q('[data-testid="arke-player-release"]')!.querySelectorAll("button")].find((button) => text(button) === "New chapters")!);
    // After the last release: chapter 3 read whole and ticked; chapter 4 says how far it is read (R-44).
    const chapters = text(q('[data-testid="arke-player-chapters"]'));
    assert.match(chapters, /3 · The Weir.*read whole · 1 min · 1 picture.*4 · Empty.*read 1 of 6 blocks/);
    assert.equal((q('[data-testid="arke-player-chapters"] label.no input') as HTMLInputElement | null)?.disabled, true);
    // The newest part's schedule carries on (R-48).
    assert.equal((q('[data-testid="arke-player-day"]') as HTMLSelectElement | null)?.value, "friday");
    // Its own pictures, its opening's among them, and its chapter of the book; no guide (R-45).
    assert.match(text(q('[data-testid="arke-player-estimate"]')), /1 chapter · 2 pictures · the book$/);
    assert.equal(text(q('[data-testid="arke-player-start"]')), "Make part");
    await press(q('[data-testid="arke-player-start"]'));
    const asked = lastAsk(m, "export-arke-player")!;
    assert.deepEqual(asked.options, { book: true, motion: true, size: "full", part: { chapters: ["weir"], schedule: { day: "friday" } } });

    // Made (236e): the part, and the releases in order, the new one marked.
    await act(async () => __applyEventForTest({ at: AT, type: "arke-player.exported", requestId: asked.requestId, worldId: FIXTURE_WORLD_ID, productionId: "inkbound", exportId: asked.exportId, result: { ok: true, file: "exports/the-undersong-part-2026-11-06.zip", bytes: 24 * 1024 ** 2, sha256: SHA, edition: "2026-11-06", chapters: 1, pictures: 1, book: true, part: 2 } }));
    const made = { ...part, dir: "exports/the-undersong-part-2026-11-06.zip", file: "exports/the-undersong-part-2026-11-06.zip", exportedAt: "2026-11-06T09:00:00.000Z", release: { ...part.release, edition: "2026-11-06", chapters: [{ id: "weir", order: 3, title: "The Weir" }], part: { ...part.release.part, number: 2 } } };
    await answerLists([made, part, edition]);
    assert.match(text(q('[data-testid="arke-player-done"]')), /^1 part · 24 MB/);
    const releases = [...dom.document.querySelectorAll('[data-testid="arke-player-releases"] .fy-abv-rel')].map((el) => [text(el.querySelector(".d")), text(el.querySelector(".k")), el.classList.contains("now")]);
    assert.deepEqual(releases, [["22 Oct 2026", "Edition", false], ["30 Oct 2026", "Part", false], ["6 Nov 2026", "Part", true]]);
  });

  it("asks for the releases again when a reconnect lost the answer (codex on PR 2173)", async () => {
    const production = inkbound().world!.productions.find((p) => p.meta.id === "inkbound")!;
    const m = await mount(<AudiobookExportSheet worldId={FIXTURE_WORLD_ID} production={production} onClose={() => {}} />);
    const asked = () => m.sent.filter((message) => message.kind === "list-web-packages").length;
    const before = asked();
    assert.ok(before > 0, "the releases are asked for when the sheet opens");
    await act(async () => __setStateForTest(inkbound(), { connection: "closed" }));
    await act(async () => __setStateForTest(inkbound(), { connection: "open" }));
    assert.ok(asked() > before, "asked again once the connection is back");
    // Answered, a later reconnect asks no more.
    const answer = lastAsk(m, "list-web-packages")!;
    await act(async () => __applyEventForTest({ at: AT, type: "web-packages.listed", requestId: answer.requestId, worldId: FIXTURE_WORLD_ID, packages: [] }));
    const settled = asked();
    await act(async () => __setStateForTest(inkbound(), { connection: "closed" }));
    await act(async () => __setStateForTest(inkbound(), { connection: "open" }));
    assert.equal(asked(), settled);
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
