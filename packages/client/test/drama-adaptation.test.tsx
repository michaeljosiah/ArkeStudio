import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { ulid, type ClientMessage, type ClientState, type EpisodeScriptBlock } from "@arke-studio/contracts";
import { DramaAdaptationScreen } from "../src/screens/drama-adaptation.js";
import { CUT, adaptationMap, layoutMap } from "../src/lib/adaptation.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/** The adaptation map and Compare (design turn 230m/n, SPEC-057 R-61..R-66). */
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1360, innerHeight: 900 });
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {} });
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const heading = (chapter: string, version: number, place: string, paragraphs?: number[]): EpisodeScriptBlock =>
  ({ id: ulid(), kind: "heading", place, source: { story: "low-water", chapter, version, hash: `sha256:${chapter}-v${version}`, ...(paragraphs ? { paragraphs } : {}) } });
const line = (words: string): EpisodeScriptBlock => ({ id: ulid(), kind: "dialogue", speaker: "maren-kest", words });

/** Four chapters: 1 and 2 kept in order, 3 cut, 4 moved ahead into episode 1; chapter 2 rewritten since. */
function world(): ClientState {
  const state = structuredClone(FIXTURE_STATE);
  const base = state.world!.productions[0]!;
  const chapter = (id: string, order: number, words: number, version: number) =>
    ({ id, order, title: `Chapter ${order}`, file: `0${order}-${id}.md`, words, version, hash: `sha256:${id}-v${version}`, status: "drafted" });
  const novel = { ...structuredClone(base), meta: { ...base.meta, id: "low-water", title: "Low Water", format: "story", medium: "story", kind: undefined },
    chapters: [chapter("tide", 1, 3000, 4), chapter("low", 2, 2000, 15), chapter("market", 3, 3600, 2), chapter("wax", 4, 1500, 1)],
    scenes: [], episodes: [], takes: [] };
  const drama = { ...structuredClone(base), meta: { ...base.meta, id: "low-water-drama", title: "Low Water", format: "story", medium: "story", kind: "audio-drama" },
    chapters: [], scenes: [], episodes: [], takes: [],
    audioDrama: { version: 1, source: { productionId: "low-water" }, plan: { episodes: 3, minutes: 25, keptFromListener: [] },
      verdicts: { market: { verdict: "cut", reason: "Repeats chapter 2.", leavesOut: "The market." } } },
    episodeScripts: [
      { file: "episode-001.json", hash: "sha256:e1", script: { version: 2, episode: 1, title: "Low Water", blocks: [
        heading("tide", 4, "The quay"), line("One."), heading("wax", 1, "The cylinder"), line("Two.")] } },
      { file: "episode-002.json", hash: "sha256:e2", script: { version: 9, episode: 2, title: "The Tide Log", blocks: [
        heading("low", 14, "The lamp room", [2]), line("Your brother hated that tower.")] } },
    ] };
  state.world!.productions = [...state.world!.productions, novel, drama] as never;
  return state;
}

describe("the adaptation map (R-61..R-64)", () => {
  it("reads ribbons from the scripts' pins and the verdicts: kept, moved, cut, not planned, changed", () => {
    const state = world();
    const production = state.world!.productions.find((p) => p.meta.id === "low-water-drama")!;
    const map = adaptationMap(state.world!, production);
    assert.deepEqual(map.chapters.map((chapter) => [chapter.id, chapter.verdict, chapter.moved, chapter.changed]), [
      ["tide", "keep", false, false], ["low", "keep", false, true], ["market", "cut", false, false], ["wax", "keep", true, false],
    ]);
    assert.deepEqual(map.ribbons.map((ribbon) => [ribbon.chapter, ribbon.to === CUT ? "cut" : ribbon.to.split(":")[0]]),
      [["tide", "1"], ["wax", "1"], ["low", "2"], ["market", "cut"]]);
    assert.deepEqual(map.counts, { read: 4, planned: 4, notPlanned: 0, changed: 1 });
    assert.equal(map.episodes[2]!.planned, false, "episode 3 has no script yet");
    assert.equal(map.cutWords, 3600);
  });

  it("lays chapters out by words and scenes by time, every ribbon between its two blocks", () => {
    const state = world();
    const map = adaptationMap(state.world!, state.world!.productions.find((p) => p.meta.id === "low-water-drama")!);
    const layout = layoutMap(map, { height: 400, left: 100, right: 300 });
    const tide = layout.chapters.get("tide")!, low = layout.chapters.get("low")!;
    assert.ok(tide.h > low.h, "3,000 words stand taller than 2,000");
    assert.equal(layout.ribbons.length, 4);
    for (const ribbon of layout.ribbons) assert.match(ribbon.d, /^M100,[\d.]+ C200,[\d.]+ 200,[\d.]+ 300,[\d.]+ L300,/);
  });
});

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null; __setBridgeForTest(null); __setStateForTest(FIXTURE_STATE);
  dom.document.body.innerHTML = "";
});
async function mount(state: ClientState) {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send: (json: string) => { sent.push(JSON.parse(json)); } } satisfies ArkeBridge);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    __setStateForTest(state, { connection: "open" });
    root!.render(<MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/p/low-water-drama/adaptation`]}>
      <Routes><Route path="/w/:worldId/p/:prodId/adaptation" element={<DramaAdaptationScreen />} /></Routes>
    </MemoryRouter>);
  });
  return { container, sent };
}
const props = (element: Element) => (element as unknown as Record<string, { onClick?: (e: unknown) => void }>)[Object.keys(element).find((key) => key.startsWith("__reactProps"))!]!;

describe("the Adaptation page (230m/n)", () => {
  it("says coverage in the header, opens a chapter's decision, and saves a changed verdict", async () => {
    const { container, sent } = await mount(world());
    assert.match(container.textContent!, /Read 4 of 4.*Planned 4.*Not planned 0.*1 changed/);
    await act(async () => props(container.querySelector('[data-chapter="market"]')!).onClick!({}));
    const panel = container.querySelector('[data-panel="market"]')!;
    assert.match(panel.textContent!, /Chapter 3 · Chapter 3.*Words3,600.*VerdictCut.*Repeats chapter 2\..*Leaves outThe market\./);
    await act(async () => props([...panel.querySelectorAll("button")].find((button) => button.textContent === "Change")!).onClick!({}));
    await act(async () => props([...container.querySelectorAll("button")].find((button) => button.textContent === "Save")!).onClick!({}));
    assert.deepEqual(sent.at(-1), { kind: "set-drama-verdict", worldId: FIXTURE_WORLD_ID, productionId: "low-water-drama", chapter: "market",
      value: { verdict: "cut", reason: "Repeats chapter 2.", leavesOut: "The market." } });
  });

  it("compares a changed chapter in three columns, and keeps the script by moving only the scene's pin", async () => {
    const state = world();
    const { container, sent } = await mount(state);
    const compare = [...container.querySelectorAll("button")].find((button) => button.textContent === "Compare")!;
    await act(async () => props(compare).onClick!({}));
    assert.match(container.querySelector(".fy-ad-cmp__bar")!.textContent!, /Chapter 2 · v14 → v15/);
    const read = sent.find((message) => message.kind === "read-drama-source") as { requestId: string; hash: string } | undefined;
    assert.equal(read?.hash, "sha256:low-v14", "the chapter as adapted is its exact pinned text");
    const opened = sent.find((message) => message.kind === "open-chapter") as { requestId: string } | undefined;
    assert.ok(opened, "the chapter now is opened");
    const AT = "2026-10-18T12:00:00.000Z";
    await act(async () => __applyEventForTest({ type: "drama.source", at: AT, requestId: read!.requestId as never, body: "Odile poured.\n\nYour brother hated that tower." }));
    await act(async () => __applyEventForTest({ type: "chapter.open-result", at: AT, requestId: opened!.requestId as never, worldId: FIXTURE_WORLD_ID,
      productionId: "low-water", chapterId: "low", disposition: "opened", body: "A new first paragraph.\n\nOdile poured.\n\nYour brother loved that tower." }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.match(container.textContent!, /1 line · 0 kept takes/, "the scene's line rests on the changed paragraph");
    assert.equal(container.querySelectorAll(".fy-ad-cmp__col").length, 3);
    await act(async () => props([...container.querySelectorAll("button")].find((button) => button.textContent === "Keep the script")!).onClick!({}));
    const save = sent.find((message) => message.kind === "save-episode-script") as Extract<ClientMessage, { kind: "save-episode-script" }>;
    assert.equal(save.baseHash, "sha256:e2");
    const pin = save.blocks[0]!.kind === "heading" ? save.blocks[0]!.source : undefined;
    assert.deepEqual([pin?.version, pin?.hash], [15, "sha256:low-v15"]);
    assert.deepEqual(save.blocks[1], state.world!.productions.find((p) => p.meta.id === "low-water-drama")!.episodeScripts![1]!.script.blocks[1],
      "the line itself is untouched, so its take is too");
  });
});
