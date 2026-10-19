import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { dramaLineHash, ulid, type ClientState, type EpisodeScriptBlock } from "@arke-studio/contracts";
import { EpisodeScriptScreen } from "../src/screens/episode-script.js";
import { DramaEpisodesScreen } from "../src/screens/drama-episodes.js";
import { takeParked } from "../src/lib/episode-script-drafts.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/** An audio drama on a phone (design turn 230r–v, SPEC-057 R-79..R-81), at 390 × 844. */
const dom = parseHTML("<!doctype html><html><body></body></html>");
let modals = 0;
Object.assign(dom.window, {
  getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 390, innerHeight: 844,
  matchMedia: (query: string) => ({ matches: /max-width:\s*599px/.test(query), media: query }),
});
Object.assign(dom.HTMLElement.prototype, {
  focus() {}, scrollIntoView() {}, setSelectionRange() {},
  // A native modal dialog holds the focus and makes the page behind it inert.
  showModal(this: HTMLElement) { modals++; this.setAttribute("open", ""); },
  close(this: HTMLElement) { this.removeAttribute("open"); },
});
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const line = (speaker: string, words: string): EpisodeScriptBlock => ({ id: ulid(), kind: "dialogue", speaker, words });

function drama(blocks: EpisodeScriptBlock[], kept: string[] = []): ClientState {
  const state = structuredClone(FIXTURE_STATE);
  const base = state.world!.productions[0]!;
  const maren = state.world!.sheets.find((sheet) => sheet.id === "maren-kest")!;
  state.world!.sheets = [...state.world!.sheets, { ...structuredClone(maren), id: "bray", name: "Bray", voice: undefined }] as never;
  const production = { ...structuredClone(base), meta: { ...base.meta, id: "low-water-drama", title: "Low Water", format: "story", medium: "story", kind: "audio-drama" },
    chapters: [], scenes: [], episodes: [], takes: [],
    audioDrama: { version: 1, plan: { episodes: 6, minutes: 25, keptFromListener: [] } },
    episodeScripts: [{ file: "episode-001.json", hash: "sha256:base", script: { version: 3, episode: 1, title: "The tide turns", blocks } }],
    episodeTakes: [{ version: 1, episode: 1, lines: Object.fromEntries(blocks.filter((block) => kept.includes(block.id)).map((block) => [block.id, { kept: {
      artifactId: "ar_01ARZ3NDEKTSV4RRFFQ69G5FAV", file: "artifacts/a.wav", textHash: dramaLineHash(block as never), voice: maren.voice,
      estimatedMicroUsd: 0, madeAt: "2026-10-18T12:00:00.000Z" } }])) }] };
  state.world!.productions = [...state.world!.productions, production] as never;
  return state;
}

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  takeParked(FIXTURE_WORLD_ID, "low-water-drama", 1);
  root = null; __setBridgeForTest(null); __setStateForTest(FIXTURE_STATE);
  dom.document.body.innerHTML = "";
});

async function mount(state: ClientState, path: string) {
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send() {} } satisfies ArkeBridge);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    __setStateForTest(state, { connection: "open" });
    root!.render(<MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/p/low-water-drama/${path}`]}>
      <Routes>
        <Route path="/w/:worldId/p/:prodId/script/:episode" element={<EpisodeScriptScreen />} />
        <Route path="/w/:worldId/p/:prodId/home" element={<DramaEpisodesScreen />} />
      </Routes>
    </MemoryRouter>);
  });
  return container;
}
const props = (element: Element) => (element as unknown as Record<string, { onClick?: (e: unknown) => void }>)[Object.keys(element).find((key) => key.startsWith("__reactProps"))!]!;
const button = (label: string) => [...dom.document.body.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label);
const press = async (label: string) => act(async () => props(button(label)!).onClick!({ stopPropagation() {} }));

describe("the script on a phone (230r–v)", () => {
  const scenes = () => {
    const a = line("maren-kest", "Bray. Look."), b = line("bray", "I see them."), c = line("maren-kest", "Climb.");
    return { a, b, c, blocks: [{ id: ulid(), kind: "heading", place: "Quay" }, a, { id: ulid(), kind: "heading", place: "The tide turns" }, b, c] as EpisodeScriptBlock[] };
  };

  it("reads as one column: the scene in the head, the scenes as chips, and the tool bar under the thumb", async () => {
    const { blocks } = scenes();
    const container = await mount(drama(blocks), "script/1");
    assert.match(container.querySelector(".fy-ad-ep__ptitle")!.textContent!, /Quay.*Episode 1 · scene 1/);
    const chips = [...container.querySelectorAll(".fy-ad-ep__chips button")].map((chip) => chip.textContent);
    assert.deepEqual(chips, ["1 · Quay", "2"]);
    assert.equal(container.querySelector(".fy-ad-hear"), null, "no floating Hear bar over the score");
    const tools = dom.document.body.querySelector(".fy-ad-ep__tools")!;
    assert.ok(tools, "the tool bar is held at the foot");
    assert.deepEqual([...tools.querySelectorAll("button")].map((tool) => tool.textContent || tool.getAttribute("aria-label")), ["Hear 1 line", "Ask Arke", "Cast", "Type"]);
    await press("2");
    assert.equal(dom.document.body.querySelector(".fy-ad-ep__tools button")!.textContent, "Hear 2 lines", "Hear follows the scene in view");
  });

  it("opens Source and Cast as sheets that hold the focus, and a role's voice is chosen in place", async () => {
    const { blocks } = scenes();
    await mount(drama(blocks), "script/1");
    const before = modals;
    await press("Source");
    const source = dom.document.body.querySelector("dialog.fy-page-sheet[aria-label='Source']");
    assert.ok(source?.querySelector("aside.fy-ad-source"), "the Source column, as a sheet");
    assert.equal(modals, before + 1, "shown modal: the page behind is inert");
    await act(async () => props(source!.querySelector("[aria-label='Close source']")!).onClick!({}));
    await press("2");
    await press("Cast");
    const cast = dom.document.body.querySelector("dialog.fy-page-sheet[aria-label='Cast']")!;
    const bray = [...cast.querySelectorAll("h3 button")].find((role) => role.textContent?.startsWith("Bray"))!;
    assert.match(bray.textContent!, /No voice/);
    await act(async () => props(bray).onClick!({}));
    assert.ok([...cast.querySelectorAll("button")].some((candidate) => candidate.textContent === "Choose a voice…"), "the voice is chosen here, not on another page");
  });

  it("selects lines by tap, and Type adds a line to the scene in view (codex on PR 1881)", async () => {
    const { a, b, c, blocks } = scenes();
    const container = await mount(drama(blocks), "script/1");
    const tap = async (id: string) => act(async () => props(container.querySelector(`[data-block="${id}"]`)!).onClick!({ shiftKey: false }));
    await tap(b.id); await tap(c.id);
    assert.equal(dom.document.body.querySelector(".fy-ad-ep__tools .ui-btn")!.textContent, "Hear 2 lines", "a second tap adds a line");
    await tap(b.id);
    assert.equal(dom.document.body.querySelector(".fy-ad-ep__tools .ui-btn")!.textContent, "Hear 1 line", "a tap on a chosen line takes it away");
    await press("1");
    await press("Type");
    const order = [...container.querySelectorAll("[data-block]")].map((row) => row.getAttribute("data-block"));
    assert.equal(order.indexOf(a.id) + 1, order.findIndex((id) => ![a.id, b.id, c.id].includes(id!) && container.querySelector(`[data-block="${id}"] textarea`)), "the new line is in scene 1, after its last line");
  });

  it("keeps every phone target at 44 px and draws the beds as one edge line", () => {
    const css = readFileSync(new URL("../src/screens/audio-drama.css", import.meta.url), "utf8");
    const phone = css.slice(css.indexOf("@media (max-width: 599px) {", css.indexOf("/* A phone (230r")));
    assert.match(phone, /\.fy-ad-ep__chips button \{[^}]*height: 44px/);
    assert.match(phone, /\.fy-ad-ep__tools > :is\(\.ui-btn, \.fy-ad-ep__tool\) \{ min-height: 44px; \}/);
    assert.match(phone, /\.fy-ad-ep__bar--phone \.ui-iconbtn, \.fy-ad-ep__tools \.ui-iconbtn, \.fy-ad-show__thumb \.ui-iconbtn \{ width: 44px; height: 44px; \}/);
    const narrow = css.slice(css.indexOf("/* Below a laptop's width the bed lanes collapse"));
    assert.match(narrow, /\.fy-ad-score__lane \{ grid-area: lane; \}/, "both lanes share the one edge column");
  });
});

describe("the Episodes page on a phone (230u)", () => {
  it("holds the next episode under the thumb, with Chat beside it", async () => {
    const a = line("maren-kest", "Climb.");
    await mount(drama([{ id: ulid(), kind: "heading", place: "Quay" }, a], [a.id]), "home");
    const thumb = dom.document.body.querySelector(".fy-ad-show__thumb")!;
    assert.match(thumb.textContent!, /Episode 1 ·/);
    assert.ok(thumb.querySelector("[aria-label='Chat']"));
    // Full-bleed (230u, issue 1882): the hero carries the way back and the drama's pages.
    const top = dom.document.body.querySelector(".fy-ad-show__hero .fy-ad-show__ptop")!;
    assert.ok(top.querySelector("[aria-label='Back']"));
    assert.deepEqual([...top.querySelectorAll("button:not([aria-label])")].map((button) => button.textContent), ["Cast", "Artifacts"]);
  });
});
