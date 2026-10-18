import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { ulid, type ClientMessage, type ClientState, type EpisodeScriptBlock } from "@arke-studio/contracts";
import { EpisodeScriptScreen } from "../src/screens/episode-script.js";
import { bedMarks, joinBlock, mendRelations, parseParagraphs, scriptAsText, splitBlock } from "../src/lib/episode-script.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/** The episode script as a score (design turn 230d–f, SPEC-057 R-11..R-24). */
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1360, innerHeight: 900 });
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {}, setSelectionRange() {} });
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const AT = "2026-10-18T12:00:00.000Z";
const line = (speaker: string, words: string, extra: object = {}): EpisodeScriptBlock => ({ id: ulid(), kind: "dialogue", speaker, words, ...extra });

describe("the score's pure parts", () => {
  it("draws a bed down its lane from its cue to the block it stops before, with a foot", () => {
    const a = line("maren", "One."), b = line("bray", "Two."), c = line("maren", "Three.");
    const bed: EpisodeScriptBlock = { id: ulid(), kind: "music", heard: "Drone", until: c.id };
    const marks = bedMarks([bed, a, b, c]);
    assert.deepEqual(marks.map(row => row.map(mark => `${mark.lane}:${mark.at}:${mark.stops}`)),
      [["music:start:true"], ["music:run:true"], ["music:end:true"], []], "exactly over the rows it plays under");
  });

  it("runs a bed with no until to the end of its scene, with no foot", () => {
    const heading: EpisodeScriptBlock = { id: ulid(), kind: "heading", place: "Next" };
    const marks = bedMarks([{ id: ulid(), kind: "ambience", heard: "Rain" }, line("maren", "One."), heading, line("bray", "Two.")]);
    assert.deepEqual(marks.map(row => row.map(mark => `${mark.at}:${mark.stops}`)), [["start:false"], ["end:false"], [], []]);
  });

  it("split keeps the first part's id and gives the rest a new one; join takes the lower id away", () => {
    const original = line("maren", "Bray. Bray, look.", { direction: "breathless" });
    const split = splitBlock([original], original.id, 5);
    assert.equal(split.length, 2);
    assert.equal(split[0]!.id, original.id);
    assert.notEqual(split[1]!.id, original.id);
    assert.deepEqual(split.map(block => block.kind === "dialogue" ? [block.speaker, block.words, block.direction ?? null] : null),
      [["maren", "Bray.", "breathless"], ["maren", "Bray, look.", null]]);
    const joined = joinBlock(split, split[1]!.id)!;
    assert.deepEqual(joined.map(block => block.id), [original.id]);
    assert.equal(joined[0]!.kind === "dialogue" && joined[0]!.words, "Bray. Bray, look.");
    assert.equal(joinBlock([line("maren", "a"), line("bray", "b")], "x"), null);
  });

  it("an edit that strands an interruption mends it rather than saving a broken relation", () => {
    const cut = line("maren", "He said it was", { cut: true });
    assert.equal((mendRelations([cut])[0] as { cut?: boolean }).cut, undefined);
  });

  it("reads paragraph numbers as typed, and exports a numbered radio script", () => {
    assert.deepEqual(parseParagraphs("14-17, 20 x"), [14, 15, 16, 17, 20]);
    const text = scriptAsText("The tide turns", 1, [
      { id: ulid(), kind: "heading", place: "The bell tower", time: "Night" },
      line("maren", "Bray, look.", { direction: "breathless" }),
      { id: ulid(), kind: "sound", heard: "The bell." },
      { id: ulid(), kind: "narration", words: "She climbed." },
    ], slug => slug === "maren" ? "Maren Kest" : slug);
    assert.match(text, /^EPISODE 1 · The tide turns/);
    assert.match(text, /1\. THE BELL TOWER — Night/);
    assert.match(text, /  1  MAREN KEST \(breathless\)\n     Bray, look\./);
    assert.match(text, /SOUND: The bell\./);
    assert.match(text, /  2  NARRATOR\n     She climbed\./);
  });
});

function withScript(blocks: EpisodeScriptBlock[]): ClientState {
  const state = structuredClone(FIXTURE_STATE);
  const base = state.world!.productions[0]!;
  const novel = { ...structuredClone(base), meta: { ...base.meta, id: "low-water", title: "Low Water", format: "story", medium: "story", kind: undefined },
    chapters: [{ id: "the-bell-tower", order: 3, title: "The bell tower", file: "03-the-bell-tower.md", words: 900, version: 14, status: "drafted" }],
    scenes: [], episodes: [], takes: [] };
  const drama = { ...structuredClone(base), meta: { ...base.meta, id: "low-water-drama", title: "Low Water", format: "story", medium: "story", kind: "audio-drama" },
    chapters: [], scenes: [], episodes: [], takes: [],
    audioDrama: { version: 1, source: { productionId: "low-water" }, plan: { episodes: 6, minutes: 25, keptFromListener: [] } },
    episodeScripts: [{ file: "episode-001.json", hash: "sha256:base", script: { version: 2, episode: 1, title: "The tide turns", blocks } }] };
  state.world!.productions = [...state.world!.productions, novel, drama] as never;
  return state;
}

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
    root!.render(<MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/p/low-water-drama/script/1`]}>
      <Routes><Route path="/w/:worldId/p/:prodId/script/:episode" element={<EpisodeScriptScreen />} /></Routes>
    </MemoryRouter>);
  });
  return { container, sent };
}
const props = (el: Element) => (el as unknown as Record<string, Record<string, any>>)[Object.keys(el).find(key => key.startsWith("__reactProps$"))!]!;

describe("the score (230e)", () => {
  const heading: EpisodeScriptBlock = { id: ulid(), kind: "heading", place: "The bell tower", source: { story: "low-water", chapter: "the-bell-tower", version: 14, paragraphs: [2, 3] } };
  const drone: EpisodeScriptBlock = { id: ulid(), kind: "music", heard: "Low drone enters, under." };
  const maren = line("maren", "Bray, look.", { direction: "breathless, delighted", paragraphs: [2] });
  const bray = line("bray", "The log's wrong.");
  const blocks = [heading, drone, maren, bray];

  it("sets only the spoken words large, with direction above them and never inside", async () => {
    const m = await mount(withScript(blocks));
    const row = m.container.querySelector(`[data-block="${maren.id}"]`)!;
    assert.equal(row.querySelector(".fy-ad-score__line textarea")!.getAttribute("aria-label"), "maren's line");
    // linkedom keeps a controlled textarea's value in React's props, not on the node.
    assert.equal(props(row.querySelector(".fy-ad-score__line textarea")!).value, "Bray, look.");
    assert.equal(props(row.querySelector(".fy-ad-score__direction")!).value, "breathless, delighted");
    assert.equal(row.querySelector(".fy-ad-score__line .fy-ad-score__direction"), null, "direction is not part of the line");
    assert.ok(m.container.querySelector(`[data-block="${bray.id}"] .fy-ad-score__new`), "a line with no source paragraph is marked new");
    assert.equal(m.container.querySelector(`[data-block="${maren.id}"] .fy-ad-score__new`), null);
    // The drone runs from its row to the scene's end, in the music lane only.
    assert.ok(m.container.querySelector(`[data-block="${drone.id}"] [data-lane="music"] .fy-ad-score__bed--start`));
    assert.ok(m.container.querySelector(`[data-block="${maren.id}"] [data-lane="music"] .fy-ad-score__bed--run`));
    assert.ok(m.container.querySelector(`[data-block="${bray.id}"] [data-lane="music"] .fy-ad-score__bed--end`));
    assert.equal(m.container.querySelector(`[data-block="${maren.id}"] [data-lane="ambience"] .fy-ad-score__bed`), null);
    assert.match(m.container.textContent!, /Saved · script v2/);
  });

  it("draws two beds that overlap in one lane, each with its own start (codex on PR 1870)", async () => {
    const rain: EpisodeScriptBlock = { id: ulid(), kind: "ambience", heard: "Rain" };
    const wind: EpisodeScriptBlock = { id: ulid(), kind: "ambience", heard: "Wind" };
    const m = await mount(withScript([heading, rain, maren, wind, bray]));
    const beds = [...m.container.querySelectorAll(`[data-block="${bray.id}"] [data-lane="ambience"] .fy-ad-score__bed`)].map(bed => bed.getAttribute("data-bed"));
    assert.deepEqual(beds, [rain.id, wind.id], "both beds run under the last line");
    assert.ok(m.container.querySelector(`[data-block="${wind.id}"] [data-bed="${wind.id}"].fy-ad-score__bed--start`), "the later bed's start is not hidden");
  });

  it("an edit not yet saved when the score is left is still saved (codex on PR 1870)", async () => {
    const m = await mount(withScript(blocks));
    const words = m.container.querySelector(`[data-block="${bray.id}"] .fy-ad-score__line textarea`)!;
    await act(async () => props(words).onChange!({ target: { value: "The log is wrong." } }));
    await act(async () => root!.unmount());
    root = null;
    const save = m.sent.find((message): message is Extract<ClientMessage, { kind: "save-episode-script" }> => message.kind === "save-episode-script")!;
    assert.ok(save, "left inside the pause, the edit is sent rather than dropped");
    assert.equal(save.blocks.find(block => block.id === bray.id)!.kind === "dialogue" && (save.blocks.find(block => block.id === bray.id) as { words: string }).words, "The log is wrong.");
    assert.equal(save.baseHash, "sha256:base");
  });

  it("shows the pinned chapter version in Source and marks the selected line's passage", async () => {
    const m = await mount(withScript(blocks));
    const source = [...m.container.querySelectorAll("button")].find(button => button.textContent?.includes("Source"))!;
    await act(async () => source.dispatchEvent(new dom.Event("click", { bubbles: true })));
    await act(async () => m.container.querySelector(`[data-block="${maren.id}"]`)!.dispatchEvent(new dom.Event("click", { bubbles: true })));
    const read = m.sent.find((message): message is Extract<ClientMessage, { kind: "read-chapter-version" }> => message.kind === "read-chapter-version")!;
    assert.deepEqual([read.productionId, read.chapterFile, read.version], ["low-water", "03-the-bell-tower.md", 14], "the version the scene pinned");
    await act(async () => __applyEventForTest({ type: "chapter.version-result", at: AT, requestId: read.requestId, worldId: FIXTURE_WORLD_ID,
      productionId: "low-water", chapterFile: "03-the-bell-tower.md", version: 14, disposition: "read",
      body: "The stairs went up.\n\n“Climb,” Bray said.\n\n“Climb,” Bray said." }));
    const paragraphs = [...m.container.querySelectorAll(".fy-ad-source__paras li")];
    assert.equal(paragraphs.length, 3);
    assert.deepEqual(paragraphs.map(li => li.className.includes("--on")), [false, true, false],
      "paragraph 2 by number, though paragraph 3 reads the same");
    assert.match(m.container.querySelector(".fy-ad-source")!.textContent!, /Low Water v14/);
  });

  it("Enter splits a line keeping its id, and the script saves whole against the base it read", async () => {
    const m = await mount(withScript(blocks));
    const words = m.container.querySelector(`[data-block="${maren.id}"] .fy-ad-score__line textarea`) as HTMLTextAreaElement;
    await act(async () => {
      Object.defineProperty(words, "selectionStart", { value: 5, configurable: true });
      Object.defineProperty(words, "selectionEnd", { value: 5, configurable: true });
      props(words).onKeyDown!({ key: "Enter", shiftKey: false, preventDefault() {}, currentTarget: words });
    });
    const rows = [...m.container.querySelectorAll("[data-block]")].map(row => row.getAttribute("data-block"));
    assert.equal(rows.length, 5);
    assert.equal(rows[2], maren.id, "the first part keeps the line's id");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 800)); });
    const save = m.sent.find((message): message is Extract<ClientMessage, { kind: "save-episode-script" }> => message.kind === "save-episode-script")!;
    assert.ok(save, "the edit is saved");
    assert.equal(save.baseHash, "sha256:base");
    assert.equal(save.blocks.length, 5);
    assert.deepEqual(save.blocks.slice(2, 4).map(block => block.kind === "dialogue" ? block.words : ""), ["Bray,", "look."]);
    await act(async () => __applyEventForTest({ type: "episode-script.save-result", at: AT, requestId: save.requestId, worldId: FIXTURE_WORLD_ID,
      productionId: "low-water-drama", episode: 1, disposition: "saved", version: 2, hash: "sha256:next" }));
    assert.match(m.container.textContent!, /Saved · script v2/);
  });
});
