import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  applyTimelineCommands,
  migrateLegacyCut,
  seedStoryPictureTimeline,
  type ClientMessage,
  type ClientState,
  type ProductionTimeline,
} from "@arke-studio/contracts";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { CutScreen } from "../src/screens/production.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Dialogue, Ambience and Music on the editor (SPEC-038 R-12, R-13; SPEC-039 R-10, R-13, R-23;
 * issue 681): typed rows replace the legacy lanes once the timeline owns every placement, Mute
 * and Solo are track commands on the row, the Library places without a drag, and the Inspector
 * authors gain and the one mix policy — every one of them a single fenced batch.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { matchMedia: (query: string) => ({ matches: false, media: query }) });
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

interface MountedCut {
  container: HTMLElement;
  root: Root;
  sent: ClientMessage[];
}

const BELLS = "ar_01J8G0000000000000000000R1";

function bridge(sent: ClientMessage[]) {
  return {
    appVersion: "test",
    platform: "test",
    connect: () => {},
    subscribe: () => {},
    send: (json: string) => sent.push(JSON.parse(json) as ClientMessage),
  } as unknown as NonNullable<Window["arke"]>;
}

async function mountCut(state: ClientState): Promise<MountedCut> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest(bridge(sent));
  __setStateForTest(state);
  const production = state.world!.productions[0]!;
  const path = `/w/${state.world!.meta.worldId}/p/${production.meta.id}/cut`;
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

async function close(screen: MountedCut): Promise<void> {
  await act(async () => screen.root.unmount());
  screen.container.remove();
}

function commandsSent(screen: MountedCut): Extract<ClientMessage, { kind: "timeline-command" }>[] {
  return screen.sent.filter((message): message is Extract<ClientMessage, { kind: "timeline-command" }> => message.kind === "timeline-command");
}

function byLabel(screen: MountedCut, label: string): HTMLButtonElement {
  const found = [...screen.container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
  );
  assert.ok(found, `${label} is rendered`);
  return found;
}

async function advance(state: ClientState): Promise<void> {
  const timeline = state.world!.productions[0]!.timeline;
  if (timeline?.status === "ready") timeline.timeline.revision += 1;
  await act(async () => __setStateForTest(structuredClone(state) as ClientState));
}

/**
 * The fixture with its bells placed on a lane, then migrated: one Ambience track, no lanes. The
 * migration folds the placement in but says nothing about the Library, which lists only what the
 * record holds (R-8, amended 2026-09-02) — so the bells are added to it here, as a person would.
 */
function migratedState(): { state: ClientState; timeline: ProductionTimeline } {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const production = state.world!.productions[0]!;
  production.cut = {
    audio: [],
    overlays: [{ id: "ov_01J8G0000000000000000000A1", artifactId: BELLS, startSec: 1, endSec: 3, lane: 0, audio: "keep" }],
  } as typeof production.cut;
  const migrated = migrateLegacyCut(seedStoryPictureTimeline(production), production, state.world!.artifacts).timeline;
  const timeline = applyTimelineCommands(migrated, [
    { kind: "add-to-library", items: [{ kind: "artifact", artifactId: BELLS }] },
    { kind: "move-adjacent", clipId: "cl_sh-13", direction: "earlier" },
  ]);
  production.timeline = { status: "ready", timeline };
  return { state, timeline };
}

afterEach(() => {
  __setBridgeForTest(null);
  document.body.replaceChildren();
});

describe("typed tracks on the editor (issue 681)", () => {
  it("draws typed rows instead of lanes once the timeline owns the placements, with Mute and Solo as commands", async () => {
    const { state } = migratedState();
    const screen = await mountCut(state);
    try {
      assert.equal(screen.container.querySelector(".fy-clanes"), null, "the legacy lanes have no writer and are not drawn");
      const row = screen.container.querySelector<HTMLElement>("[data-track-id='tr_lane-0-sound']");
      assert.ok(row, "the lane's sound became an Ambience row");
      assert.equal(row.dataset["track"], "ambience");
      const clip = row.querySelector<HTMLButtonElement>("[data-clip='cl_ov-01J8G0000000000000000000A1']");
      assert.ok(clip);
      assert.match(clip.getAttribute("aria-label") ?? "", /harbour-bells\.wav, 00:00:01:00 to 00:00:03:00/);

      await act(async () => byLabel(screen, "Mute Overlay L0 sound").click());
      assert.deepEqual(commandsSent(screen).at(-1)?.commands, [{ kind: "set-track", trackId: "tr_lane-0-sound", muted: true }]);
      await advance(state);
      await act(async () => byLabel(screen, "Solo Overlay L0 sound").click());
      assert.deepEqual(commandsSent(screen).at(-1)?.commands, [{ kind: "set-track", trackId: "tr_lane-0-sound", solo: true }]);
      assert.equal(commandsSent(screen).length, 2, "one batch per press");
    } finally {
      await close(screen);
    }
  });

  it("places from the Library without a drag, adding the track it needs, at the playhead", async () => {
    const { state } = migratedState();
    const screen = await mountCut(state);
    try {
      // The non-drag path (SPEC-039 R-10): pick the row, then its Add to timeline action.
      await act(async () => screen.container.querySelector<HTMLButtonElement>(`[data-library-item="artifact:${BELLS}"] .fy-artrow__pick`)!.click());
      const add = [...screen.container.querySelectorAll<HTMLButtonElement>(".fy-artrow__actions button")].find((button) => button.textContent?.includes("Add to timeline"));
      assert.ok(add, "the bells offer Add to timeline");
      await act(async () => add.click());
      const sent = commandsSent(screen).at(-1);
      assert.ok(sent);
      assert.equal(sent.commands.length, 2, "no Music track exists yet, so one is added in the same batch");
      assert.deepEqual(sent.commands[0], { kind: "add-track", trackId: "tr_music", trackKind: "music", name: "Music" });
      const place = sent.commands[1]!;
      assert.equal(place.kind, "place");
      if (place.kind !== "place") return;
      assert.equal(place.trackId, "tr_music");
      assert.equal(place.clip.startFrame, 0, "at the playhead");
      assert.deepEqual(place.clip.source, { kind: "artifact", artifactId: BELLS, label: "harbour-bells.wav" });
      assert.equal(place.clip.gainDb, 0);
      assert.equal(sent.label, "Place harbour-bells.wav");
    } finally {
      await close(screen);
    }
  });

  it("authors gain on an audio clip and the one mix policy from the Inspector", async () => {
    const { state } = migratedState();
    const screen = await mountCut(state);
    try {
      const clip = screen.container.querySelector<HTMLButtonElement>("[data-clip='cl_ov-01J8G0000000000000000000A1']");
      assert.ok(clip);
      await act(async () => clip.click());
      assert.equal(screen.container.querySelector(".fy-cutinspect__eyebrow")?.textContent, "AMBIENCE CLIP");
      await act(async () => byLabel(screen, "Gain 1 dB quieter").click());
      assert.deepEqual(commandsSent(screen).at(-1)?.commands, [{ kind: "set-clip-gain", clipId: "cl_ov-01J8G0000000000000000000A1", gainDb: -1 }]);

      await advance(state);
      const canvas = screen.container.querySelector<HTMLElement>(".fy-timeline__canvas");
      assert.ok(canvas);
      await act(async () => canvas.click());
      assert.equal(screen.container.querySelector(".fy-cutinspect__eyebrow")?.textContent, "CUT");
      assert.match(screen.container.querySelector(".fy-mixpanel")?.textContent ?? "", /-9 dB/);
      await act(async () => byLabel(screen, "On").click());
      assert.deepEqual(commandsSent(screen).at(-1)?.commands, [{ kind: "set-mix", mix: { speechFirst: false } }]);
      await advance(state);
      await act(async () => byLabel(screen, "Duck 1 dB more").click());
      assert.deepEqual(commandsSent(screen).at(-1)?.commands, [{ kind: "set-mix", mix: { duckingDb: -10 } }]);
    } finally {
      await close(screen);
    }
  });

  it("keeps the legacy lanes while the timeline has not absorbed them", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    // Only a cut that still holds a legacy placement draws its lanes (the target has none).
    state.world!.productions[0]!.cut = {
      audio: [],
      overlays: [{ id: "ov_01J8G0000000000000000000A1", artifactId: BELLS, startSec: 1, endSec: 3, lane: 0, audio: "keep" }],
    } as never;
    const screen = await mountCut(state);
    try {
      assert.ok(screen.container.querySelector(".fy-clanes"), "an unsaved cut still edits on lanes");
      assert.equal(screen.container.querySelector("[data-track='ambience'] .fy-typedlane"), null);
    } finally {
      await close(screen);
    }
  });
});
