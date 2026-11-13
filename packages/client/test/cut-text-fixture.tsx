// First, so react-dom finds a document with an input event when it loads.
import { dom, seen, setWidth } from "./cut-text-dom.js";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  applyTimelineCommands,
  mediaPlacementCommands,
  seedEmptyPictureTimeline,
  textLabel,
  PICTURE_TRACK_ID,
  type ClientMessage,
  type ClientState,
  type ProductionTimeline,
  type TextDraftAnswer,
  type TextDraftCommand,
  type TextLook,
  type TimelineClip,
  type TimelineClipCommand,
  type TimelineClipId,
  type TimelineCommand,
} from "@arke-studio/contracts";
import { __applyEventForTest, __handleFrameForTest, __setBridgeForTest, __setStateForTest, __stateForTest } from "../src/lib/store.js";
import { CutScreen } from "../src/screens/cut.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The Cut with titles on it, for the text controls' tests (SPEC-065 R-29 – R-34, turn 277). A
 * placed video on the base track and titles on a track of their own; the window's socket is a
 * stub that answers the draft asks (R-32) the way a test says, a turn of the event loop later, as
 * the coordinator would.
 */

export function installDom(width = 1024) {
  setWidth(width);
  return { dom, seen };
}

export const LOOK: TextLook = { typeface: "geist", weight: "regular", italic: false, size: 0.08, tracking: 0, leading: 1.2, capitals: false, align: "center",
  x: 0.5, y: 0.5, room: 0.9, fill: { kind: "solid", color: "#ffffff" }, shadow: { color: "#000000", opacity: 0.8, blur: 0.3, dx: 0, dy: 0 } };

export function title(id: TimelineClipId, startFrame: number, words: string, look: Partial<TextLook> = {}, durationFrames = 96): TimelineClip {
  return { id, startFrame, durationFrames, sourceInFrames: 0, source: { kind: "text", label: textLabel(words), text: words, look: { ...LOOK, ...look } },
    fade: { inFrames: 12, outFrames: 12 } };
}

/** A placed video on the base track, then `commands` (a Titles track and its titles, say), each placed by the client's own reducer. */
export function stateWith(commands: TimelineClipCommand[] = []): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const p = state.world!.productions[0]!;
  p.scenes = []; p.spine = null; p.cut = { audio: [], overlays: [] };
  const video = { ...state.world!.artifacts[0]!, kind: "video" as const, file: "harbour.mp4", mediaInfo: { durationSec: 5, hasAudio: true } };
  state.world!.artifacts = [video];
  const seeded = seedEmptyPictureTimeline(p);
  const placed = applyTimelineCommands(seeded, mediaPlacementCommands(seeded, [video], "append", () => "cl_harbour"));
  p.timeline = { status: "ready", timeline: commands.length ? applyTimelineCommands(placed, commands) : placed };
  return state;
}

/** Three titles on a Titles track, as 277g draws them: one, a second at 7 %, and a third moved by hand to Y 70 %. */
export const THREE_TITLES: TimelineClipCommand[] = [
  { kind: "add-track", trackId: "tr_titles", trackKind: "picture", name: "Titles" },
  { kind: "place", trackId: "tr_titles", clip: title("cl_one", 0, "Harbour lights", { size: 0.09 }) },
  { kind: "place", trackId: "tr_titles", clip: title("cl_two", 120, "The coast\nat first light", { size: 0.07 }) },
  { kind: "place", trackId: "tr_titles", clip: title("cl_three", 240, "Evening", { size: 0.09, y: 0.7 }) },
];

export type Respond = (ask: TextDraftCommand["ask"]) => TextDraftAnswer | null;
/** What the coordinator answers when a test says nothing: every item drawn at its own size, a picture for a paint. */
export const DRAWN: Respond = ask => ask.kind === "paint"
  ? { kind: "drawn", results: [{ ok: true, drawnSize: ask.item.look.size }], picture: { name: "0".repeat(64), png: "iVBORw0KGgo=" } }
  : { kind: "drawn", results: ask.items.map(item => ({ ok: true as const, drawnSize: item.look.size })) };

let seq = 10_000;
/** Answers the stub socket has scheduled and not yet delivered; `settle` waits them out. */
let answering = 0;

export async function mountCut(state: ClientState) {
  const sent: ClientMessage[] = [];
  const answered = new Set<string>();
  let respond: Respond = DRAWN;
  const answer = (message: TextDraftCommand) => {
    const reply = respond(message.ask);
    if (reply === null) return;
    answered.add(message.requestId);
    __handleFrameForTest({ kind: "text-draft", seq: seq++, requestId: message.requestId, answer: reply });
  };
  const bridge = { appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json: string) {
    const message: ClientMessage = JSON.parse(json);
    sent.push(message);
    // Answered a turn later, as the socket would be: never inside the press that asked.
    if (message.kind === "text-draft") { answering++; setTimeout(() => { answering--; answer(message); }, 0); }
  } };
  Object.assign(window, { arke: bridge });
  __setBridgeForTest(bridge);
  __setStateForTest(state);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  await act(async () => root.render(<MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/p/${state.world!.productions[0]!.meta.id}/cut`]}>
    <Routes><Route path="/w/:worldId/p/:prodId/cut" element={<CutScreen />} /></Routes>
  </MemoryRouter>));
  await settle();
  const chip = (clipId: string) => {
    const found = container.querySelector<HTMLElement>(`[data-clip="${clipId}"]`);
    assert.ok(found, `${clipId} is on the timeline`); return found;
  };
  const inspector = () => {
    const found = container.querySelector<HTMLElement>("#cut-inspector-panel");
    assert.ok(found, "the Inspector is rendered"); return found;
  };
  return {
    container, sent, chip, inspector,
    /** Says how the coordinator answers from now on; null answers nothing. */
    respond(next: Respond) { respond = next; },
    /** Every ask the window has sent and not had answered. */
    unanswered: () => sent.filter((message): message is TextDraftCommand => message.kind === "text-draft" && !answered.has(message.requestId)),
    drafts: () => sent.filter((message): message is TextDraftCommand => message.kind === "text-draft"),
    timelineCommands: () => sent.flatMap(message => (message.kind === "timeline-command" ? [message] : [])),
    /** Answer one held ask now, as the coordinator would. */
    async answer(message: TextDraftCommand, reply: TextDraftAnswer) {
      await act(async () => { answered.add(message.requestId); __handleFrameForTest({ kind: "text-draft", seq: seq++, requestId: message.requestId, answer: reply }); });
      await settle();
    },
    async click(element: Element, modifiers: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {}) {
      await act(async () => {
        const event = new Event("click", { bubbles: true, cancelable: true });
        Object.assign(event, { button: 0, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...modifiers });
        element.dispatchEvent(event);
      });
      await settle();
    },
    /**
     * A mouse press as a browser sends one: pointerdown, pointerup, then the click. The lanes
     * select on pointerdown, before the click and before focus moves, so a bare click misses what
     * the press itself does. `upTo` stops after a step, to look at the screen in between.
     */
    async press(element: Element, modifiers: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {}, upTo: "pointerdown" | "click" = "click") {
      const fire = (type: string) => act(async () => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.assign(event, { button: 0, buttons: type === "pointerdown" ? 1 : 0, pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: 0, clientY: 0,
          shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...modifiers });
        element.dispatchEvent(event);
      });
      await fire("pointerdown");
      if (upTo === "pointerdown") return;
      await fire("pointerup");
      await this.click(element, modifiers);
    },
    /** The coordinator refuses the command in flight: a stale revision, or a painter's refusal. */
    async refuse(reason: string) {
      await act(async () => __applyEventForTest({ at: "2026-11-12T12:00:00Z", type: "timeline.command-refused",
        worldId: state.world!.meta.worldId, productionId: state.world!.productions[0]!.meta.id, reason }));
      await settle();
    },
    /** The record as the coordinator would make it after `commands`, sent as the next snapshot. */
    async apply(commands: readonly TimelineCommand[]) {
      const next = structuredClone(__stateForTest().state!);
      const production = next.world!.productions[0]!;
      assert.ok(production.timeline?.status === "ready");
      // Every command these tests send is a clip command; a take switch is not the timeline's to apply.
      production.timeline.timeline = applyTimelineCommands(production.timeline.timeline, commands.flatMap(command => (command.kind === "switch-take" ? [] : [command])));
      await act(async () => __setStateForTest(next));
      await settle();
    },
    timeline(): ProductionTimeline {
      const production = __stateForTest().state!.world!.productions[0]!;
      assert.ok(production.timeline?.status === "ready"); return production.timeline.timeline;
    },
    async close() { await act(async () => root.unmount()); container.remove(); Reflect.deleteProperty(window, "arke"); __setBridgeForTest(null); },
  };
}

/**
 * Lets timers and answers run: a draft goes 120 ms after typing pauses, and is answered a turn
 * later. On a loaded machine — the whole suite at once — the 120 ms timer and a 160 ms wait both
 * fall due while the loop is busy and run together, so the answer the first schedules lands after
 * the wait meant to cover it. The wait is over only once every answer already asked for has come.
 */
export async function settle(ms = 5) {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
  for (let turns = 0; answering > 0 && turns < 400; turns++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
}

/** React's own props on an element, to choose a value in a select as a person does. */
export function reactProps(element: Element): Record<string, (event: unknown) => void> {
  const key = Object.keys(element).find(name => name.startsWith("__reactProps$"));
  assert.ok(key, "a React element");
  return Reflect.get(element, key);
}

export async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => reactProps(select).onChange!({ currentTarget: { value } }));
  await settle();
}

export async function check(input: HTMLInputElement, checked: boolean) {
  await act(async () => reactProps(input).onChange!({ currentTarget: { checked } }));
  await settle();
}

export async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => { field.value = value; field.dispatchEvent(new Event("input", { bubbles: true })); });
}

export async function key(target: EventTarget, name: string, modifiers: { ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean } = {}) {
  await act(async () => {
    const event = new Event("keydown", { bubbles: true, cancelable: true });
    Object.assign(event, { key: name, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers });
    target.dispatchEvent(event);
  });
  await settle();
}

export async function focus(field: Element) { await act(async () => { field.dispatchEvent(new Event("focusin", { bubbles: true })); }); }
export async function blur(field: Element) { await act(async () => { field.dispatchEvent(new Event("focusout", { bubbles: true })); }); await settle(); }

export const byLabel = (root: ParentNode, label: string) => {
  const found = root.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  assert.ok(found, `${label} is there`); return found;
};
/** The Words field (its section carries the same name). */
export const wordsField = (root: ParentNode) => {
  const found = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Words"]');
  assert.ok(found, "the Words field"); return found;
};
export const button = (root: ParentNode, text: string) => {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find(candidate => candidate.textContent?.trim() === text);
  assert.ok(found, `the ${text} button`); return found;
};
export { PICTURE_TRACK_ID };
