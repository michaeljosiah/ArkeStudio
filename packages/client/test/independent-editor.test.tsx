import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { applyTimelineCommands, mediaPlacementCommands, seedEmptyPictureTimeline, type ClientMessage, type ClientState } from "@arke-studio/contracts";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { CutScreen } from "../src/screens/production.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { matchMedia: (media: string) => ({ matches: false, media }) });
Object.assign(dom.HTMLElement.prototype, { focus() {} });
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), { pause() {}, play: () => Promise.resolve() });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement,
  HTMLMediaElement: dom.HTMLMediaElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
function stateWithVideo(placed: boolean): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const p = state.world!.productions[0]!;
  p.scenes = []; p.spine = null; p.cut = { audio: [], overlays: [] };
  const video = { ...state.world!.artifacts[0]!, kind: "video" as const, file: "holiday.mp4", mediaInfo: { durationSec: 5, hasAudio: true } };
  state.world!.artifacts = [video];
  const timeline = seedEmptyPictureTimeline(p);
  p.timeline = placed ? { status: "ready", timeline: applyTimelineCommands(timeline, mediaPlacementCommands(timeline, [video], "append", () => "cl_holiday")) } : { status: "absent" };
  return state;
}
async function mount(state: ClientState) {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json: string) { sent.push(JSON.parse(json)); } });
  __setStateForTest(state);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  await act(async () => root.render(<MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/p/${state.world!.productions[0]!.meta.id}/cut`]}>
    <Routes><Route path="/w/:worldId/p/:prodId/cut" element={<CutScreen />} /></Routes>
  </MemoryRouter>));
  const button = (text: string) => {
    const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === text);
    assert.ok(found, text); return found;
  };
  return { container, sent, button, async close() { await act(async () => root.unmount()); container.remove(); __setBridgeForTest(null); } };
}
it("imports onto the main timeline without scenes or predefined audio lanes", async () => {
  const screen = await mount(stateWithVideo(false));
  try {
    for (const kind of ["dialogue", "ambience", "music"]) assert.equal(screen.container.querySelector(`[data-track="${kind}"]`), null);
    await act(async () => screen.button("Import media").click());
    const request = screen.sent.find(message => message.kind === "upload-artifacts");
    assert.ok(request?.kind === "upload-artifacts");
    assert.equal(request.editor?.destination, "append"); assert.equal(request.editor?.baseRevision, null);
    assert.equal(screen.button("Importing…").disabled, true);
    await act(async () => __applyEventForTest({ type: "queue.enqueue-result", at: "2026-09-05T12:00:00Z",
      command: "upload-artifacts", requestId: request.requestId, disposition: "not-queued", requestedCount: 0, acceptedJobIds: [], failures: [] }));
    assert.equal(screen.button("Import media").disabled, false, "cancelling the picker releases the import state");
    await act(async () => screen.button("Import media").click());
    const next = screen.sent.filter(message => message.kind === "upload-artifacts").at(-1)!;
    assert.ok(next.kind === "upload-artifacts");
    await act(async () => __applyEventForTest({ type: "queue.enqueue-result", at: "2026-09-05T12:00:01Z",
      command: "upload-artifacts", requestId: next.requestId, disposition: "rejected", requestedCount: 1, acceptedJobIds: [], failures: [{ index: 0, reason: "The timeline changed during import" }] }));
    assert.match(screen.container.textContent!, /The timeline changed during import/);
    assert.equal(screen.button("Import media").disabled, false);
  } finally { await screen.close(); }
});

it("reserves migrated track ids when adding audio to an unsaved legacy cut", async () => {
  const state = stateWithVideo(false), p = state.world!.productions[0]!, artifactId = state.world!.artifacts[0]!.id;
  p.cut.audio = [
    { kind: "score", label: "Legacy score", entries: [{ artifactId, offsetSec: 0 }] },
    { kind: "ambience", label: "Legacy ambience", entries: [{ artifactId, offsetSec: 0 }] },
  ];
  const screen = await mount(state);
  try {
    await act(async () => screen.button("Add audio track").click());
    const request = screen.sent.find(message => message.kind === "timeline-command");
    assert.ok(request?.kind === "timeline-command");
    assert.deepEqual(request.commands, [{ kind: "add-track", trackId: "tr_audio-2", trackKind: "audio", name: "Audio 2" }]);
    assert.equal(request.baseRevision, null);
  } finally { await screen.close(); }
});

it("edits the clip role and future track default as separate commands", async () => {
  const state = stateWithVideo(false), p = state.world!.productions[0]!;
  const source = { kind: "artifact" as const, artifactId: state.world!.artifacts[0]!.id, label: "Recorded sound" };
  p.timeline = { status: "ready", timeline: applyTimelineCommands(seedEmptyPictureTimeline(p), [
    { kind: "add-track", trackId: "tr_audio-1", trackKind: "audio", name: "Audio 1" },
    { kind: "place", trackId: "tr_audio-1", clip: { id: "cl_sound", startFrame: 0, durationFrames: 48, sourceInFrames: 0, source } },
  ]) };
  const screen = await mount(state);
  try {
    await act(async () => screen.container.querySelector<HTMLButtonElement>('[data-clip="cl_sound"]')!.click());
    const role = screen.container.querySelector<HTMLSelectElement>('[aria-label="Clip role"]')!;
    assert.ok(role); assert.equal(role.getAttribute("disabled"), null);
    await act(async () => { Object.defineProperty(role, "value", { value: "dialogue", configurable: true }); role.dispatchEvent(new Event("change", { bubbles: true })); });
    const batch = screen.sent.find(message => message.kind === "timeline-command");
    assert.ok(batch?.kind === "timeline-command");
    assert.deepEqual(batch.commands, [{ kind: "set-clip-role", clipId: "cl_sound", role: "dialogue" }]);
    // Fold the acknowledged edit, then choose a default for later placements.
    p.timeline = { status: "ready", timeline: applyTimelineCommands(p.timeline.timeline, [{ kind: "set-clip-role", clipId: "cl_sound", role: "dialogue" }]) };
    await act(async () => __setStateForTest(structuredClone(state)));
    const defaults = screen.container.querySelector<HTMLSelectElement>('[aria-label="Default role for new clips"]')!;
    await act(async () => { Object.defineProperty(defaults, "value", { value: "music", configurable: true }); defaults.dispatchEvent(new Event("change", { bubbles: true })); });
    const change = screen.sent.filter(message => message.kind === "timeline-command").at(-1)!;
    assert.ok(change.kind === "timeline-command");
    assert.deepEqual(change.commands, [{ kind: "set-track", trackId: "tr_audio-1", defaultRole: "music" }]);
  } finally { await screen.close(); }
});
it("shows the filename as an editable clip and detaches sound with a neutral role", async () => {
  const screen = await mount(stateWithVideo(true));
  try {
    const picture = screen.container.querySelector<HTMLButtonElement>('[data-clip="cl_holiday"]')!;
    assert.ok(picture); assert.match(picture.getAttribute("aria-label")!, /holiday.mp4/);
    assert.equal(picture.classList.contains("fy-cutseg--gap"), false);
    assert.equal(screen.container.querySelector(".fy-scenes__band"), null);
    assert.equal(screen.container.querySelector('[data-testid="needs-decision"]'), null, "imported footage is not a shot waiting for a take");
    assert.doesNotMatch(screen.container.textContent!, /0 of 0 shots|1 gap/);
    await act(async () => picture.click());
    assert.equal(screen.button("Detach audio").disabled, false);
    await act(async () => screen.button("Detach audio").click());
    const batch = screen.sent.find(message => message.kind === "timeline-command");
    assert.ok(batch?.kind === "timeline-command");
    assert.equal(batch.commands.length, 1);
    const command = batch.commands[0]!;
    assert.ok(command.kind === "detach-audio");
    assert.equal(command.clipId, "cl_holiday");
    assert.match(command.newClipId, /^cl_/);
  } finally { await screen.close(); }
});
