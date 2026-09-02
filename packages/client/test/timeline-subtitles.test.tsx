import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  applyTimelineCommands,
  seedStoryPictureTimeline,
  type ClientMessage,
  type ClientState,
  type ProductionTimeline,
} from "@arke-studio/contracts";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { CutScreen } from "../src/screens/production.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Subtitles on the editor and the export sheet (SPEC-038 R-21..R-27; SPEC-039 R-19b, R-21, T-5;
 * issue 683): cues sit on the Subtitles lane, the viewed cue shows over the preview, a cue's
 * words and timing are authored as commands, and delivery is a choice the export sheet names —
 * the sheet the Exports address now opens, since the Exports screen is gone.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { matchMedia: (query: string) => ({ matches: false, media: query }), confirm: () => true });
Object.assign(dom.HTMLElement.prototype, { focus() {} });
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), { pause() {}, play: () => Promise.resolve() });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  HTMLMediaElement: dom.HTMLMediaElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});

interface Mounted {
  container: HTMLElement;
  root: Root;
  sent: ClientMessage[];
}

function bridge(sent: ClientMessage[]) {
  return {
    appVersion: "test",
    platform: "test",
    connect: () => {},
    subscribe: () => {},
    send: (json: string) => sent.push(JSON.parse(json) as ClientMessage),
  } as unknown as NonNullable<Window["arke"]>;
}

/** The editor; `?export=1` lands with the sheet up, exactly as the Exports address does (SPEC-039 R-1). */
async function mount(state: ClientState, search = ""): Promise<Mounted> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest(bridge(sent));
  __setStateForTest(state);
  const production = state.world!.productions[0]!;
  const path = `/w/${state.world!.meta.worldId}/p/${production.meta.id}/cut${search}`;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/w/:worldId/p/:prodId/cut" element={<CutScreen />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return { container, root, sent };
}

async function close(mounted: Mounted): Promise<void> {
  await act(async () => mounted.root.unmount());
  mounted.container.remove();
}

function byLabel(mounted: Mounted, label: string): HTMLButtonElement {
  const found = [...mounted.container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
  );
  assert.ok(found, `${label} is rendered`);
  return found;
}

function commandsSent(mounted: Mounted): Extract<ClientMessage, { kind: "timeline-command" }>[] {
  return mounted.sent.filter((message): message is Extract<ClientMessage, { kind: "timeline-command" }> => message.kind === "timeline-command");
}

function sheet(mounted: Mounted): HTMLElement {
  const found = mounted.container.querySelector<HTMLElement>('[data-testid="export-sheet"]');
  assert.ok(found, "the export sheet is up");
  return found;
}

/** One chip group on the sheet, as label and pressed state. */
function chips(mounted: Mounted, group: string): Array<[string, string | null]> {
  return [...sheet(mounted).querySelectorAll<HTMLButtonElement>(`[aria-label="${group}"] .fy-exsheet__chip`)].map((chip) => [
    chip.textContent ?? "",
    chip.getAttribute("aria-pressed"),
  ]);
}

function exportPrimary(mounted: Mounted): HTMLButtonElement {
  const found = [...mounted.container.querySelectorAll<HTMLButtonElement>(".fy-libpick__confirm")].find((candidate) =>
    (candidate.textContent ?? "").startsWith("Export"),
  );
  assert.ok(found, "the sheet's primary is rendered");
  return found;
}

function exportRequest(mounted: Mounted): Extract<ClientMessage, { kind: "export-cut" }> {
  const request = mounted.sent.find((message) => message.kind === "export-cut");
  assert.ok(request && request.kind === "export-cut", "the export was sent");
  return request;
}

function subtitledState(): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const production = state.world!.productions[0]!;
  const timeline: ProductionTimeline = applyTimelineCommands(seedStoryPictureTimeline(production), [
    { kind: "add-subtitle-track", trackId: "tr_subs-en", name: "English", language: "en" },
    { kind: "add-cue", trackId: "tr_subs-en", cue: { id: "cu_one", text: "Hello, harbour.", startFrame: 0, endFrame: 24, speaker: "maren-kest" } },
    { kind: "add-cue", trackId: "tr_subs-en", cue: { id: "cu_two", text: "The bells,\nfar under.", startFrame: 48, endFrame: 96 } },
  ]);
  production.timeline = { status: "ready", timeline };
  return state;
}

afterEach(() => {
  __setBridgeForTest(null);
  document.body.replaceChildren();
});

describe("subtitles on the editor (issue 683)", () => {
  it("draws cues on the Subtitles lane, shows the current cue over the preview, and edits by command", async () => {
    const state = subtitledState();
    const mounted = await mount(state);
    try {
      const row = mounted.container.querySelector<HTMLElement>("[data-track='subtitles'][data-track-id='tr_subs-en']");
      assert.ok(row, "the language track is a row");
      assert.deepEqual([...row.querySelectorAll("[data-cue]")].map((cue) => cue.getAttribute("data-cue")), ["cu_one", "cu_two"]);
      assert.equal(mounted.container.querySelector(".fy-cutviewer__cue")?.textContent, "Hello, harbour.", "the cue at the playhead shows over the picture");

      const cue = row.querySelector<HTMLButtonElement>("[data-cue='cu_two']");
      assert.ok(cue);
      await act(async () => cue.click());
      assert.match(mounted.container.querySelector(".fy-cutinspect__eyebrow")?.textContent ?? "", /SUBTITLE · en/);
      assert.ok(mounted.container.querySelector("textarea[aria-label='Subtitle text']"), "the words are editable");
      const inspector = mounted.container.querySelector(".fy-cutinspect")?.textContent ?? "";
      assert.match(inspector, /00:00:02:00/, "in point at 24 fps");
      assert.match(inspector, /00:00:04:00/, "out point at 24 fps");
      await act(async () => byLabel(mounted, "Out one frame later").click());
      assert.deepEqual(commandsSent(mounted).at(-1)?.commands, [{ kind: "edit-cue", cueId: "cu_two", endFrame: 97 }]);
    } finally {
      await close(mounted);
    }
  });

  it("adds a cue at the playhead from the row and offers the sources from the Inspector", async () => {
    const state = subtitledState();
    const mounted = await mount(state);
    try {
      // The playhead sits at frame 0, inside cu_one, so the row cannot add there.
      assert.equal(byLabel(mounted, "Add subtitle at 00:00:00:00").disabled, true);
      const canvas = mounted.container.querySelector<HTMLElement>(".fy-timeline__canvas");
      assert.ok(canvas);
      await act(async () => canvas.click());
      const sources = mounted.container.querySelector(".fy-subsources");
      assert.ok(sources, "the cut view offers the subtitle sources");
      assert.match(sources.textContent ?? "", /SUBTITLES · 1/);
      assert.ok(byLabel(mounted, "Import SRT/VTT"));
      assert.equal(byLabel(mounted, "Draft from speech").disabled, false, "a saved timeline may ask for a draft");
      await act(async () => byLabel(mounted, "Draft from speech").click());
      const asked = mounted.sent.find((message) => message.kind === "timeline-transcribe");
      assert.deepEqual(asked, {
        kind: "timeline-transcribe",
        worldId: state.world!.meta.worldId,
        productionId: "saltlight",
        baseRevision: 1,
        trackId: "tr_subs-en",
        language: "en",
      });
    } finally {
      await close(mounted);
    }
  });

  it("names the subtitle delivery on the export sheet and passes it with the request", async () => {
    const state = subtitledState();
    const mounted = await mount(state, "?export=1");
    try {
      // Delivery is a choice (SPEC-038 R-27): none until it is made, and one language needs no track choice.
      assert.deepEqual(chips(mounted, "Subtitle output"), [
        ["Burned in", "false"],
        ["Sidecar", "false"],
        ["Both", "false"],
        ["None", "true"],
      ]);
      assert.equal(sheet(mounted).querySelector('[aria-label="Subtitle track"]'), null, "one track is not a choice");
      assert.deepEqual(chips(mounted, "Sidecar format"), [], "no sidecar format until a sidecar is asked for");
      await act(async () => byLabel(mounted, "Both").click());
      assert.deepEqual(chips(mounted, "Sidecar format"), [
        [".srt", "true"],
        [".vtt", "false"],
      ]);
      await act(async () => exportPrimary(mounted).click());
      const request = exportRequest(mounted);
      assert.deepEqual(request.subtitles, { trackId: "tr_subs-en", mode: "burn-in+sidecar", sidecar: "srt" });
      assert.equal(request.timelineRevision, 1);
    } finally {
      await close(mounted);
    }
  });

  it("offers the track once there are two languages, and the sidecar's format", async () => {
    const state = subtitledState();
    const production = state.world!.productions[0]!;
    const saved = production.timeline;
    assert.ok(saved && saved.status === "ready");
    production.timeline = {
      status: "ready",
      timeline: applyTimelineCommands(saved.timeline, [{ kind: "add-subtitle-track", trackId: "tr_subs-fr", name: "Français", language: "fr" }]),
    };
    const mounted = await mount(state, "?export=1");
    try {
      const track = sheet(mounted).querySelector<HTMLSelectElement>('select[aria-label="Subtitle track"]');
      assert.ok(track, "two languages make the track a choice");
      const options = [...track.querySelectorAll<HTMLOptionElement>("option")];
      assert.deepEqual(options.map((option) => option.textContent), ["English · en", "Français · fr"]);
      // linkedom's select has no value setter; choosing the option is what a person does anyway.
      await act(async () => {
        options.find((option) => option.value === "tr_subs-fr")!.selected = true;
        track.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      });
      await act(async () => byLabel(mounted, "Sidecar").click());
      await act(async () => byLabel(mounted, ".vtt").click());
      await act(async () => exportPrimary(mounted).click());
      const request = exportRequest(mounted);
      assert.deepEqual(request.subtitles, { trackId: "tr_subs-fr", mode: "sidecar", sidecar: "vtt" });
      assert.equal(request.timelineRevision, 2);
    } finally {
      await close(mounted);
    }
  });

  it("offers no subtitle delivery before a timeline exists", async () => {
    const mounted = await mount(structuredClone(FIXTURE_STATE) as ClientState, "?export=1");
    try {
      assert.equal(sheet(mounted).querySelector(".fy-exsheet__none")?.textContent, "no subtitle track");
      assert.deepEqual(chips(mounted, "Subtitle output"), [], "no mode to choose without a track");
    } finally {
      await close(mounted);
    }
  });
});
