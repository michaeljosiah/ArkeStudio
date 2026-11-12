import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { applyTimelineCommands, defaultEffectClip, seedStoryPictureTimeline, undoTimelineHistory,
  type EffectClip, type ProductionTimeline, type TimelineClipCommand, type TimelineCommand } from "@arke-studio/contracts";
import { EffectLibrary, type EffectLibraryProps } from "../src/screens/editor-effect-library.js";
import { EffectTrackRows, effectGestureCommand, type EffectTrackRowsProps } from "../src/screens/editor-effect-tracks.js";
import { EffectTargetSelect } from "../src/screens/editor-effect-target.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
let touch = false;
Object.assign(dom.window, { matchMedia: (query: string) => ({ matches: touch && /coarse|max-width: 599/.test(query), media: query }), innerWidth: 1400, innerHeight: 880 });
Object.assign(dom.HTMLElement.prototype, { focus() {}, setPointerCapture() {}, releasePointerCapture() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 60, right: 1000, bottom: 60 }) });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element,
  Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
const mounted: Array<{ root: Root; container: HTMLElement }> = [];
async function mount(node: ReactNode) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), result = { container, root }; mounted.push(result);
  await act(async () => root.render(node)); return result;
}
afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.container.remove(); } touch = false; });
const buttons = (root: ParentNode = document) => Array.from(root.querySelectorAll<HTMLButtonElement>("button"));
const button = (text: string, root: ParentNode = document) => { const result = buttons(root).find(value => value.textContent?.trim() === text); assert.ok(result, `button: ${text}`); return result; };
const click = async (value: HTMLElement) => { await act(async () => value.click()); };
const field = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
async function change(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
  assert.ok(input, label);
  await act(async () => {
    // linkedom lacks the input event plumbing React installs in a browser.
    Object.defineProperty(input, "value", { configurable: true, writable: true, value });
    const key = Object.keys(input).find(name => name.startsWith("__reactProps$"))!;
    (input as unknown as Record<string, { onChange: (event: { currentTarget: typeof input; target: typeof input }) => void }>)[key]!.onChange({ currentTarget: input, target: input });
  });
}
async function submit(selector: string) { await act(async () => { document.querySelector(selector)!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); }
async function key(target: HTMLElement, keyValue: string, shiftKey = false) {
  const event = new Event("keydown", { bubbles: true, cancelable: true });
  Object.assign(event, { key: keyValue, shiftKey }); await act(async () => { target.dispatchEvent(event); }); return event;
}
async function pointer(target: EventTarget, type: string, clientX: number, pointerType = "mouse") {
  const event = new Event(type, { bubbles: true, cancelable: true }); Object.assign(event, { pointerId: 1, clientX, clientY: 0, button: 0, pointerType });
  await act(async () => { target.dispatchEvent(event); });
}
const base = () => seedStoryPictureTimeline(FIXTURE_STATE.world!.productions[0]!);
const makeEffect = (id = "cl_dust", startFrame = 24, durationFrames = 96, order = 0) => defaultEffectClip({ id, lineageId: `ef_${id}`, startFrame, durationFrames, order, seed: 42 });
const withEffects = (effects: EffectClip[] = [makeEffect()]) => applyTimelineCommands(base(), [
  { kind: "add-track", trackId: "tr_fx", trackKind: "effect", name: "Atmosphere" },
  ...effects.map(effect => ({ kind: "effect-create" as const, trackId: "tr_fx", effect })),
], { effectAuthority: "human" });
function libraryProps(timeline = base()): EffectLibraryProps & { sent: TimelineCommand[][]; created: string[] } {
  const sent: TimelineCommand[][] = [], created: string[] = [];
  return { timeline, frameRate: 24, pictureDurationFrames: 240, selectedPictureId: timeline.tracks[0]!.clips[1]!.id, playheadFrame: 48, disabled: false,
    onCommands: commands => { sent.push(commands); }, onCreated: id => { created.push(id); }, sent, created };
}
function tracksProps(timeline = withEffects()): EffectTrackRowsProps & { sent: TimelineCommand[][]; previews: Array<TimelineCommand[] | null>; created: string[]; selected: string[] } {
  const sent: TimelineCommand[][] = [], previews: Array<TimelineCommand[] | null> = [], created: string[] = [], selected: string[] = [];
  return { timeline, totalFrames: 240, frameRate: 24, selectedEffectId: "cl_dust", playheadFrame: 72, disabled: false,
    onSelect: id => { selected.push(id); }, onCommands: commands => { sent.push(commands); }, onPreview: commands => { previews.push(commands); }, onScrub: () => {},
    onCreated: id => { created.push(id); }, sent, previews, created, selected };
}
const clip = (id = "cl_dust") => document.querySelector<HTMLButtonElement>(`[data-effect="${id}"]`)!;
const compile = (timeline: ProductionTimeline, commands: TimelineCommand[]) => applyTimelineCommands(timeline, commands as TimelineClipCommand[], { effectAuthority: "human" });

describe("Effects library and independent Add", () => {
  it("offers all seven presets and Cancel authors nothing", async () => {
    const props = libraryProps(); await mount(<EffectLibrary {...props} />);
    assert.deepEqual(buttons(document.querySelector('[aria-label="Effect presets"]')!).map(value => value.getAttribute("aria-label")), ["Floating dust", "Embers", "Snow", "Floating lights", "Rain", "Smoke", "Air Particles"]);
    await click(button("Add effect")); assert.ok(button("Selected range").disabled);
    await click(button("Cancel")); assert.equal(props.sent.length, 0); assert.equal(props.created.length, 0);
  });
  it("copies Whole video without coupling visual target or sound; creation and its track undo together", async () => {
    const props = libraryProps(); await mount(<EffectLibrary {...props} />); await click(button("Add effect"));
    await change("Visual target", `clip:${props.selectedPictureId}`); await click(button("Whole video"));
    await submit(".fy-effect-add"); assert.equal(props.sent.length, 1); assert.equal(props.sent[0]!.length, 2);
    const timeline = compile(props.timeline!, props.sent[0]!); const effect = timeline.tracks.find(track => track.kind === "effect")!.effects![0]!;
    assert.deepEqual(effect.target, { kind: "visual-clip", clipId: props.selectedPictureId });
    assert.equal(effect.startFrame, 0); assert.equal(effect.durationFrames, 240); assert.equal(effect.reaction.enabled, false); assert.equal(effect.audioInput, undefined);
    assert.equal(effect.simulationOriginFrame, 0); assert.equal(effect.id, props.created[0]); assert.match(effect.lineageId, /^ef_/);
    assert.equal(undoTimelineHistory(timeline).tracks.some(track => track.kind === "effect"), false);
  });
  it("copies the selected picture's interval while retaining composition scope and an existing effects lane", async () => {
    const props = libraryProps(withEffects()); await mount(<EffectLibrary {...props} />); await click(button("Add effect")); await click(button("Selected picture"));
    assert.equal(field("Effect start").value, "00:00:04:00"); assert.equal(field("Effect end").value, "00:00:10:00");
    await submit(".fy-effect-add"); assert.equal(props.sent[0]!.length, 1);
    const command = props.sent[0]![0]!; assert.equal(command.kind, "effect-create");
    if (command.kind !== "effect-create") return;
    assert.deepEqual(command.effect.target, { kind: "composition" }); assert.equal(command.effect.startFrame, 96); assert.equal(command.effect.durationFrames, 144); assert.equal(command.effect.order, 1);
  });
  it("accepts typed exact frames, rejects reversed bounds, and rechecks read-only at confirmation", async () => {
    const props = libraryProps(), view = await mount(<EffectLibrary {...props} />); await click(button("Add effect"));
    await change("Effect start", "00:00:01:03"); await change("Effect end", "00:00:01:02");
    await submit(".fy-effect-add"); assert.equal(props.sent.length, 0);
    await change("Effect end", "00:00:02:07");
    await act(async () => view.root.render(<EffectLibrary {...props} disabled />)); await submit(".fy-effect-add"); assert.equal(props.sent.length, 0);
    await act(async () => view.root.render(<EffectLibrary {...props} />)); await submit(".fy-effect-add");
    const command = props.sent[0]!.find(row => row.kind === "effect-create")!;
    assert.equal(command.kind, "effect-create"); if (command.kind === "effect-create") { assert.equal(command.effect.startFrame, 27); assert.equal(command.effect.durationFrames, 28); }
  });
  it("retains and labels missing targets until explicitly replaced", async () => {
    const changes: unknown[] = []; await mount(<EffectTargetSelect timeline={base()} value={{ kind: "visual-clip", clipId: "cl_removed" }} disabled={false} onChange={target => changes.push(target)} />);
    assert.match(document.body.textContent!, /Missing visual clip · cl_removed/); assert.equal(changes.length, 0);
    await change("Visual target", "composition"); assert.deepEqual(changes, [{ kind: "composition" }]);
  });
});

describe("independent effect lanes", () => {
  it("keeps overlapping effects independently reachable and orders equal-order clips stably", async () => {
    const props = tracksProps(withEffects([makeEffect(), makeEffect("cl_embers", 24, 96)])); await mount(<EffectTrackRows {...props} />);
    assert.notEqual(clip().style.top, clip("cl_embers").style.top); assert.equal(clip().style.left, clip("cl_embers").style.left);
    await click(clip("cl_embers")); assert.deepEqual(props.selected, ["cl_embers"]);
    await key(clip(), "]"); const next = compile(props.timeline, props.sent[0]!);
    assert.equal(next.tracks.find(track => track.kind === "effect")!.effects!.find(effect => effect.id === "cl_dust")!.order, 1);
  });
  it("previews a drag then commits one effect move, with no picture, audio or ripple command", async () => {
    const props = tracksProps(); await mount(<EffectTrackRows {...props} />);
    await pointer(clip(), "pointerdown", 200); await pointer(clip(), "pointermove", 300);
    assert.equal(props.sent.length, 0); assert.deepEqual(props.previews.at(-1), [{ kind: "effect-move", clipId: "cl_dust", startFrame: 48 }]);
    await pointer(clip(), "pointerup", 300);
    assert.deepEqual(props.sent, [[{ kind: "effect-move", clipId: "cl_dust", startFrame: 48 }]]); assert.equal(props.previews.at(-1), null);
  });
  it("cancels Escape, pointer loss, permission loss and unmount without authoring", async () => {
    for (const reason of ["escape", "pointer", "permission", "revision", "unmount"] as const) {
      const props = tracksProps(), view = await mount(<EffectTrackRows {...props} authoringRevision={props.timeline.revision} />), element = view.container.querySelector<HTMLButtonElement>("[data-effect]")!;
      await pointer(element, "pointerdown", 200); await pointer(element, "pointermove", 250);
      if (reason === "escape") await key(element, "Escape");
      if (reason === "pointer") await pointer(element, "pointercancel", 250);
      if (reason === "permission") await act(async () => view.root.render(<EffectTrackRows {...props} disabled />));
      if (reason === "revision") { const changed = compile(props.timeline, [{ kind: "effect-move", clipId: "cl_dust", startFrame: 30 }]); await act(async () => view.root.render(<EffectTrackRows {...props} timeline={changed} authoringRevision={changed.revision} />)); }
      if (reason === "unmount") await act(async () => view.root.render(null));
      await pointer(element, "pointerup", 250); assert.equal(props.sent.length, 0, reason); assert.equal(props.previews.at(-1), null, reason);
    }
  });
  it("trims without restarting phase and keeps a one-frame minimum", async () => {
    const props = tracksProps(); await mount(<EffectTrackRows {...props} />);
    const grip = clip().querySelector<HTMLElement>(".fy-pictclip__grip--start")!;
    await pointer(grip, "pointerdown", 200); await pointer(grip, "pointermove", 250); await pointer(grip, "pointerup", 250);
    const next = compile(props.timeline, props.sent[0]!), effect = next.tracks.find(track => track.kind === "effect")!.effects![0]!;
    assert.equal(effect.startFrame, 36); assert.equal(effect.durationFrames, 84); assert.equal(effect.simulationOriginFrame, 24); assert.equal(effect.seed, 42);
    assert.deepEqual(effectGestureCommand(effect, "trim-start", 10000), { kind: "effect-trim", clipId: "cl_dust", edge: "head", deltaFrames: 83 });
  });
  it("provides split, fresh duplicate identity and delete through keyboard, without ripple", async () => {
    const props = tracksProps(); await mount(<EffectTrackRows {...props} />); await key(clip(), "s"); await key(clip(), "d");
    const split = props.sent[0]![0]!, duplicate = props.sent[1]![0]!;
    assert.equal(split.kind, "effect-split"); if (split.kind === "effect-split") { assert.equal(split.atFrame, 72); assert.notEqual(split.newClipId, "cl_dust"); }
    assert.equal(duplicate.kind, "effect-duplicate"); if (duplicate.kind === "effect-duplicate") {
      assert.equal(duplicate.startFrame, 120); assert.notEqual(duplicate.seed, 42); assert.notEqual(duplicate.newLineageId, "ef_cl_dust"); assert.equal(props.created[0], duplicate.newClipId);
    }
    const event = await key(clip(), "Delete", true); assert.equal(event.defaultPrevented, true);
    assert.deepEqual(props.sent[2], [{ kind: "effect-remove", clipId: "cl_dust" }]);
  });
  it("offers typed timing in its keyboard menu and rejects invalid split bounds", async () => {
    const props = tracksProps(); await mount(<EffectTrackRows {...props} />); await key(clip(), "ContextMenu"); await click(button("Edit timing…"));
    await change("Effect timing action", "split"); await change("Effect timing value", "00:00:05:00"); await submit(".fy-effect-timing");
    assert.equal(props.sent.length, 0); assert.match(document.querySelector(".fy-effect-timing")!.textContent!, /at least one frame/);
    await change("Effect timing action", "head"); await change("Effect timing value", "00:00:01:12"); await submit(".fy-effect-timing");
    assert.deepEqual(props.sent, [[{ kind: "effect-trim", clipId: "cl_dust", edge: "head", deltaFrames: 12 }]]);
  });
  it("uses the touch menu, permits selection when read-only, and sends no writes", async () => {
    touch = true; const props = tracksProps(); await mount(<EffectTrackRows {...props} disabled />); await click(clip()); await key(clip(), "ContextMenu");
    assert.ok(document.querySelector(".fy-cut-menu-sheet")); assert.equal(button("Duplicate effect D").disabled, true); await key(clip(), "Delete"); assert.equal(props.sent.length, 0); assert.ok(props.selected.length);
  });
  it("first touch selects, while a selected effect supports a cancellable drag", async () => {
    touch = true; const props = tracksProps(), view = await mount(<EffectTrackRows {...props} selectedEffectId={null} />);
    await pointer(clip(), "pointerdown", 200, "touch"); await pointer(clip(), "pointermove", 240, "touch"); await pointer(clip(), "pointerup", 240, "touch"); assert.equal(props.sent.length, 0);
    await act(async () => view.root.render(<EffectTrackRows {...props} />)); await pointer(clip(), "pointerdown", 200, "touch"); await pointer(clip(), "pointermove", 250, "touch"); await pointer(clip(), "pointercancel", 250, "touch");
    assert.equal(props.sent.length, 0); assert.equal(props.previews.at(-1), null);
  });
  it("snaps to shared timeline edges and permits keyboard frame adjustments", async () => {
    const props = tracksProps(); await mount(<EffectTrackRows {...props} snapFrames={() => [0, 48, 144]} />);
    await pointer(clip(), "pointerdown", 200); await pointer(clip(), "pointermove", 297); await pointer(clip(), "pointerup", 297);
    assert.deepEqual(props.sent[0], [{ kind: "effect-move", clipId: "cl_dust", startFrame: 48 }]);
    await key(clip(), "ArrowLeft"); await key(clip(), "ArrowRight", true);
    assert.deepEqual(props.sent.slice(1), [[{ kind: "effect-move", clipId: "cl_dust", startFrame: 23 }], [{ kind: "effect-move", clipId: "cl_dust", startFrame: 34 }]]);
  });
  it("pans with the Hand tool without moving an effect", async () => {
    const props = tracksProps(), view = await mount(<div className="fy-timeline__canvas"><EffectTrackRows {...props} tool="hand" /></div>);
    const canvas = view.container.firstElementChild as HTMLElement; canvas.scrollLeft = 200;
    await pointer(clip(), "pointerdown", 300); await pointer(window, "pointermove", 200); await pointer(window, "pointerup", 200);
    assert.equal(canvas.scrollLeft, 300); assert.equal(props.sent.length, 0);
  });
  it("hides an effects track and reorders tracks without muting audio or changing effect times", async () => {
    const timeline = applyTimelineCommands(withEffects(), [{ kind: "add-track", trackId: "tr_fx2", trackKind: "effect", name: "Second atmosphere", order: 3 }]);
    const props = tracksProps(timeline); await mount(<EffectTrackRows {...props} />);
    await click(document.querySelector<HTMLButtonElement>('[aria-label="Atmosphere effects track settings"]')!);
    await click(button("Hide effects")); assert.deepEqual(props.sent[0], [{ kind: "set-track", trackId: "tr_fx", muted: true }]);
    await click(button("Later effects track")); const result = compile(timeline, props.sent[1]!);
    assert.deepEqual(result.tracks.filter(track => track.kind === "effect").sort((a, b) => a.order - b.order).map(track => track.id), ["tr_fx2", "tr_fx"]);
    assert.deepEqual(result.tracks.find(track => track.id === "tr_fx")!.effects, timeline.tracks.find(track => track.id === "tr_fx")!.effects);
  });
});
