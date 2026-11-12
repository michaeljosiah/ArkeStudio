import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  applyTimelineCommands,
  mediaPlacementCommands,
  seedEmptyPictureTimeline,
  textLabel,
  PICTURE_TRACK_ID,
  type ClientMessage,
  type ClientState,
  type TextLook,
  type TimelineClip,
  type TimelineClipCommand,
} from "@arke-studio/contracts";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { CutScreen } from "../src/screens/cut.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The Cut holding text it cannot yet edit (SPEC-065 slices 2 and 3). The words and the look arrive
 * with the Cut's own controls in a later slice; until then a timeline that holds a text clip must
 * draw, name and inspect it truthfully, offer what a still is offered, a move and a crossfade among
 * it (R-17), and offer nothing the record would refuse (R-2, R-3, R-33).
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { innerWidth: 1024, innerHeight: 768, matchMedia: (media: string) => ({ matches: false, media }) });
Object.assign(dom.HTMLElement.prototype, { focus() {} });
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), { pause() {}, play: () => Promise.resolve() });
// Any text sends the Viewer through the compositor (SPEC-065 R-18), whose loop asks for frames.
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement,
  HTMLMediaElement: dom.HTMLMediaElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: () => 1, cancelAnimationFrame() {} });

const WORDS = "ADE\nthe one who stayed";
const SPOKEN = "ADE the one who stayed";
const look: TextLook = { typeface: "geist", weight: "regular", italic: false, size: 0.08, tracking: 0, leading: 1.2, capitals: false, align: "center",
  x: 0.5, y: 0.5, room: 0.8, fill: { kind: "solid", color: "#ffffff" } };
const text = (id: `cl_${string}`, startFrame: number): TimelineClip => ({
  id, startFrame, durationFrames: 112, sourceInFrames: 0, source: { kind: "text", label: textLabel(WORDS), text: WORDS, look }, fade: { inFrames: 24, outFrames: 30 } });

/**
 * A placed video, a title after it on the base track and the same title on a Names track above.
 * Both are placed through the client's own copy of the reducer, so this also proves it takes them.
 * `more` is placed after them, the same way.
 */
function stateWithText(more: TimelineClipCommand[] = []): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const p = state.world!.productions[0]!;
  p.scenes = []; p.spine = null; p.cut = { audio: [], overlays: [] };
  const video = { ...state.world!.artifacts[0]!, kind: "video" as const, file: "holiday.mp4", mediaInfo: { durationSec: 5, hasAudio: true } };
  state.world!.artifacts = [video];
  const seeded = seedEmptyPictureTimeline(p);
  const placed = applyTimelineCommands(seeded, mediaPlacementCommands(seeded, [video], "append", () => "cl_holiday"));
  const after = placed.tracks[0]!.clips[0]!.durationFrames;
  p.timeline = { status: "ready", timeline: applyTimelineCommands(placed, [
    { kind: "place", trackId: PICTURE_TRACK_ID, clip: text("cl_base", after) },
    { kind: "add-track", trackId: "tr_names", trackKind: "picture", name: "Names" },
    { kind: "place", trackId: "tr_names", clip: text("cl_names", 0) },
    ...more,
  ]) };
  return state;
}

async function mount(state: ClientState) {
  const sent: ClientMessage[] = [];
  const bridge = { appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json: string) { sent.push(JSON.parse(json)); } };
  Object.assign(window, { arke: bridge });
  __setBridgeForTest(bridge);
  __setStateForTest(state);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  await act(async () => root.render(<MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/p/${state.world!.productions[0]!.meta.id}/cut`]}>
    <Routes><Route path="/w/:worldId/p/:prodId/cut" element={<CutScreen />} /></Routes>
  </MemoryRouter>));
  const chip = (clipId: string) => {
    const found = container.querySelector<HTMLButtonElement>(`[data-clip="${clipId}"]`);
    assert.ok(found, `${clipId} is on the timeline`); return found;
  };
  const select = async (clipId: string) => {
    await act(async () => chip(clipId).click());
    const inspector = container.querySelector<HTMLElement>("#cut-inspector-panel");
    assert.ok(inspector, "the Inspector is rendered"); return inspector;
  };
  const menu = async (clipId: string) => {
    const event = new Event("contextmenu", { bubbles: true, cancelable: true }); Object.assign(event, { clientX: 100, clientY: 100 });
    await act(async () => { chip(clipId).dispatchEvent(event); });
    const found = document.querySelector<HTMLElement>('[role="menu"]');
    assert.ok(found, `${clipId} has a menu`); return found;
  };
  return { container, sent, chip, select, menu, async close() { await act(async () => root.unmount()); container.remove(); Reflect.deleteProperty(window, "arke"); __setBridgeForTest(null); } };
}

/** The text a row's label carries, as the Inspector's rows and fields write it. */
const rowLabels = (inspector: HTMLElement): string[] => [
  ...[...inspector.querySelectorAll(".fy-cutinspect__row > span")].map(span => span.textContent ?? ""),
  ...[...inspector.querySelectorAll("label")].map(label => label.childNodes[0]?.textContent ?? ""),
];

afterEach(() => { document.body.replaceChildren(); });

it("a text clip shows its first line on either Picture track and is named by all its words", async () => {
  const screen = await mount(stateWithText());
  try {
    for (const clipId of ["cl_base", "cl_names"]) {
      const chip = screen.chip(clipId);
      assert.equal(chip.getAttribute("data-source"), "text", `${clipId} is told apart from a picture`);
      assert.equal(chip.textContent?.trim(), "ADE", "the chip shows the first line alone");
      assert.ok(chip.getAttribute("aria-label")?.startsWith(`${SPOKEN}, `), `${clipId} is named by all its words: ${chip.getAttribute("aria-label")}`);
    }
    const base = screen.chip("cl_base");
    assert.doesNotMatch(base.className, /fy-cutseg--gap/, "text has no file behind it and is never a gap");
    assert.doesNotMatch(base.getAttribute("aria-label") ?? "", /, gap/);
    assert.equal(base.querySelector(".fy-portrait--fallback"), null, "no missing-picture mark");
    assert.equal(screen.chip("cl_holiday").getAttribute("data-source"), null, "a picture is not text");
  } finally { await screen.close(); }
});

it("a selected text clip shows TEXT with its timing, Motion, Fade and Appearance, and nothing it cannot do", async () => {
  const screen = await mount(stateWithText());
  try {
    for (const clipId of ["cl_base", "cl_names"]) {
      const inspector = await screen.select(clipId);
      assert.equal(inspector.querySelector(".fy-cutinspect__eyebrow")?.textContent, "TEXT");
      assert.equal(inspector.querySelector("h2")?.textContent, "ADE");
      const labels = rowLabels(inspector);
      for (const label of ["Track", "Position", "In", "Out", "Duration", "Fade in", "Fade out"]) assert.ok(labels.includes(label), `${clipId} shows ${label}`);
      assert.ok(inspector.querySelector('[aria-label="Picture blend mode"]'), "the appearance a still takes");
      for (const label of ["Source in", "Source", "Take", "Type", "Own sound"]) assert.ok(!labels.includes(label), `${clipId} shows no ${label}`);
      assert.ok(inspector.querySelector('[aria-label="Picture move"]'), "text moves as a still does (R-17)");
      assert.equal(inspector.querySelector('[aria-label="Picture motion"] h3')?.textContent, "Motion");
      assert.ok(![...inspector.querySelectorAll("button")].some(button => button.textContent?.trim() === "Detach audio"), "text has no sound to detach");
      assert.doesNotMatch(inspector.textContent ?? "", /PICTURE CLIP|PLACED PICTURE/);
    }
  } finally { await screen.close(); }
});

it("a fade typed on a text clip sends picture-fade", async () => {
  const state = stateWithText(), saved = state.world!.productions[0]!.timeline;
  assert.ok(saved?.status === "ready");
  const screen = await mount(state);
  try {
    const inspector = await screen.select("cl_names");
    const label = [...inspector.querySelectorAll("label")].find(row => row.childNodes[0]?.textContent === "Fade in");
    assert.ok(label, "the Fade in field");
    const input = document.getElementById(label.getAttribute("for")!) as HTMLInputElement;
    await act(async () => { input.value = "2"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { const event = new Event("keydown", { bubbles: true }); Object.assign(event, { key: "Enter" }); input.dispatchEvent(event); });
    const batches = screen.sent.filter(message => message.kind === "timeline-command");
    assert.equal(batches.length, 1);
    const [batch] = batches;
    assert.ok(batch?.kind === "timeline-command");
    assert.deepEqual(batch.commands, [{ kind: "picture-fade", clipId: "cl_names", inFrames: 2 * saved.timeline.frameRate }]);
  } finally { await screen.close(); }
});

it("a move chosen on a text clip sends picture-motion", async () => {
  const screen = await mount(stateWithText());
  try {
    const inspector = await screen.select("cl_names");
    const select = inspector.querySelector<HTMLSelectElement>('[aria-label="Picture move"]');
    assert.ok(select, "the Move menu");
    // Chosen as the Inspector's own test chooses a move: through React's handler, with the value it reads.
    const key = Object.keys(select).find(name => name.startsWith("__reactProps$"))!;
    await act(async () => (select as unknown as Record<string, { onChange: (event: unknown) => void }>)[key]!.onChange({ currentTarget: { value: "push-in" } }));
    const batches = screen.sent.filter(message => message.kind === "timeline-command");
    assert.equal(batches.length, 1);
    const [batch] = batches;
    assert.ok(batch?.kind === "timeline-command");
    assert.deepEqual(batch.commands, [{ kind: "picture-motion", clipId: "cl_names", motion: { kind: "push-in", amount: 0.08 } }]);
  } finally { await screen.close(); }
});

it("two touching names offer a crossfade at their join", async () => {
  const screen = await mount(stateWithText([{ kind: "place", trackId: "tr_names", clip: text("cl_names2", 112) }]));
  try {
    const joins = [...screen.container.querySelectorAll<HTMLButtonElement>("button")].map(button => button.getAttribute("aria-label") ?? "")
      .filter(label => label.startsWith("Add transition between"));
    // The title touching the video on the base track is not a pair of stills, so it offers none.
    assert.deepEqual(joins, ["Add transition between ADE → ADE"]);
  } finally { await screen.close(); }
});

it("Apply across images, over all still images, crossfades the two names and not the title after the video", async () => {
  const screen = await mount(stateWithText([{ kind: "place", trackId: "tr_names", clip: text("cl_names2", 112) }]));
  try {
    // Asked of the Cut's own batch, which hands the plan its own still test: the place a choice to leave titles out would be made.
    const button = (root: ParentNode, label: string) => {
      const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find(row => row.textContent?.trim() === label);
      assert.ok(found, label); return found;
    };
    await act(async () => button(screen.container, "Transitions").click());
    await act(async () => button(screen.container, "Apply across images…").click());
    const batch = document.querySelector<HTMLElement>('[aria-label="Apply across images"]');
    assert.ok(batch, "the batch opens");
    assert.equal(batch.querySelector("select")?.value, "all", "over all still images");
    await act(async () => button(batch, "Apply 1 crossfades").click());
    const sent = screen.sent.filter(message => message.kind === "timeline-command");
    assert.equal(sent.length, 1);
    const [message] = sent;
    assert.ok(message?.kind === "timeline-command");
    assert.deepEqual(message.commands, [{ kind: "transition-set", trackId: "tr_names", leftClipId: "cl_names", rightClipId: "cl_names2", durationFrames: 24 }]);
  } finally { await screen.close(); }
});

it("a text clip's menu offers no Extract audio", async () => {
  const screen = await mount(stateWithText());
  try {
    for (const clipId of ["cl_base", "cl_names"]) {
      const menu = await screen.menu(clipId);
      assert.equal(menu.querySelector('[data-action="extract"]'), null, `${clipId} offers no Extract audio`);
      for (const action of ["split", "duplicate", "delete"]) assert.ok(menu.querySelector(`[data-action="${action}"]`), `${clipId} offers ${action}`);
      await act(async () => { const escape = new Event("keydown", { bubbles: true }); Object.assign(escape, { key: "Escape" }); window.dispatchEvent(escape); });
      assert.equal(document.querySelector('[role="menu"]'), null);
    }
    // The video beside them still offers it, so the item's absence is the text's and not the menu's.
    const menu = await screen.menu("cl_holiday");
    assert.ok(menu.querySelector('[data-action="extract"]'));
  } finally { await screen.close(); }
});

it("a text clip on the base track is not listed under NEEDS A DECISION", async () => {
  const screen = await mount(stateWithText());
  try {
    assert.ok(screen.container.querySelector("#cut-inspector-panel"), "the Inspector shows the cut");
    assert.equal(screen.container.querySelector('[data-testid="needs-decision"]'), null);
  } finally { await screen.close(); }
});

it("the Library opens beside a text clip", async () => {
  const state = stateWithText();
  const artifactId = state.world!.artifacts[0]!.id;
  const screen = await mount(state);
  try {
    const row = screen.container.querySelector<HTMLElement>(`[data-library-item="artifact:${artifactId}"]`);
    assert.ok(row, "the placed video has its row");
    // Text is not in the Library (SPEC-065 R-1): no row of its own, and no use counted on another.
    assert.equal(screen.container.querySelector('[data-library-item="text"]'), null);
    assert.ok(![...screen.container.querySelectorAll("[data-library-item]")].some(item => /ADE/.test(item.textContent ?? "")));
    await act(async () => row.querySelector<HTMLButtonElement>("button")!.click());
    const locate = [...row.querySelectorAll("button")].find(button => /Locate in timeline/.test(button.textContent ?? ""));
    assert.ok(locate, "the video is located on the timeline");
    assert.equal(locate.querySelector(".fy-mono"), null, "once, not once per text clip");
  } finally { await screen.close(); }
});
