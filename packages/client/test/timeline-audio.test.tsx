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
  storyTimelineFingerprint,
  type ClientMessage,
  type ClientState,
  type ProductionTimeline,
} from "@arke-studio/contracts";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { CutScreen } from "../src/screens/cut.js";
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
      assert.equal(screen.container.querySelector("[data-track-id='tr_lane-0-sound-2']"), null, "the record is shown as saved, not folded again");
      const row = screen.container.querySelector<HTMLElement>("[data-track-id='tr_lane-0-sound']");
      assert.ok(row, "the lane's sound became an Ambience row");
      assert.equal(row.dataset["track"], "ambience");
      const clip = row.querySelector<HTMLButtonElement>("[data-clip='cl_ov-01J8G0000000000000000000A1']");
      assert.ok(clip);
      assert.match(clip.getAttribute("aria-label") ?? "", /The Vigil, 00:00:01:00 to 00:00:03:00/);

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

  it("keeps every lane on the picture ruler when audio outlives the film (#705)", async () => {
    const { state, timeline } = migratedState();
    const picture = timeline.tracks.find((track) => track.kind === "picture")!;
    const pictureFrames = Math.max(...picture.clips.map((clip) => clip.startFrame + clip.durationFrames));
    const sound = timeline.tracks.find((track) => track.kind === "ambience")!;
    sound.clips[0]!.startFrame = 0;
    sound.clips[0]!.durationFrames = pictureFrames * 10;
    const screen = await mountCut(state);
    try {
      const firstPicture = screen.container.querySelector<HTMLElement>(`[data-clip='${picture.clips[0]!.id}']`);
      const longAudio = screen.container.querySelector<HTMLElement>(`[data-clip='${sound.clips[0]!.id}']`);
      assert.ok(firstPicture && longAudio);
      assert.equal(firstPicture.style.width, `${(picture.clips[0]!.durationFrames / pictureFrames) * 100}%`);
      assert.equal(longAudio.style.width, "1000%", "the clip overflows the picture canvas instead of rescaling it");
    } finally {
      await close(screen);
    }
  });

  it("places from the Library without a drag, adding the track it needs, at the playhead", async () => {
    const { state } = migratedState();
    state.world!.artifacts.find(artifact => artifact.id === BELLS)!.mediaInfo = { durationSec: 2, hasAudio: true };
    const screen = await mountCut(state);
    try {
      // The non-drag path (SPEC-039 R-10): pick the row, then its Append to timeline action.
      await act(async () => screen.container.querySelector<HTMLButtonElement>(`[data-library-item="artifact:${BELLS}"] .fy-artrow__pick`)!.click());
      const add = [...screen.container.querySelectorAll<HTMLButtonElement>(".fy-artrow__actions button")].find((button) => button.textContent?.includes("Append to timeline"));
      assert.ok(add, "the bells offer Append to timeline");
      await act(async () => add.click());
      const sent = commandsSent(screen).at(-1);
      assert.ok(sent);
      assert.equal(sent.commands.length, 2, "no generic Audio track exists yet, so one is added in the same batch");
      assert.deepEqual(sent.commands[0], { kind: "add-track", trackId: "tr_audio-1", trackKind: "audio", name: "Audio 1" });
      const place = sent.commands[1]!;
      assert.equal(place.kind, "place");
      if (place.kind !== "place") return;
      assert.equal(place.trackId, "tr_audio-1");
      assert.equal(place.clip.startFrame, 0, "at the playhead");
      assert.deepEqual(place.clip.source, { kind: "artifact", artifactId: BELLS, label: "harbour-bells.wav" });
      assert.equal(place.clip.gainDb, 0);
      assert.equal(sent.label, "Append media");
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

  it("sets the film's look from the Inspector with no clip selected, after the mix, as one command (SPEC-038 R-45..R-50)", async () => {
    const { state, timeline } = migratedState();
    const screen = await mountCut(state);
    try {
      // With a clip selected the Inspector is the clip's, and the film's look is not in it.
      await act(async () => screen.container.querySelector<HTMLButtonElement>("[data-clip='cl_ov-01J8G0000000000000000000A1']")!.click());
      assert.equal(screen.container.querySelector('[aria-label="Look"]') === null, true);
      await act(async () => screen.container.querySelector<HTMLElement>(".fy-timeline__canvas")!.click());
      const inspector = screen.container.querySelector(".fy-cutinspect")!;
      assert.equal(inspector.querySelector(".fy-cutinspect__eyebrow")?.textContent, "CUT");
      assert.ok(inspector.innerHTML.indexOf('aria-label="Mix"') < inspector.innerHTML.indexOf('aria-label="Look"'), "the look follows the mix");
      await act(async () => byLabel(screen, "Grain light").click());
      assert.deepEqual(commandsSent(screen).at(-1)?.commands, [{ kind: "set-picture-look", look: { grain: "light" } }]);
      assert.equal(commandsSent(screen).at(-1)?.label, "Change the look");

      // What the coordinator would send back: the chip is pressed, and turning it off again clears the look.
      state.world!.productions[0]!.timeline = { status: "ready", timeline: applyTimelineCommands(timeline, [{ kind: "set-picture-look", look: { grain: "light" } }]) };
      await act(async () => __setStateForTest(structuredClone(state) as ClientState));
      assert.equal(byLabel(screen, "Grain light").getAttribute("aria-pressed"), "true");
      await act(async () => byLabel(screen, "Grain off").click());
      assert.deepEqual(commandsSent(screen).at(-1)?.commands, [{ kind: "set-picture-look", look: null }]);
      assert.equal(commandsSent(screen).at(-1)?.label, "Clear the look");
    } finally {
      await close(screen);
    }
  });

  it("fades a sound clip in and out from the Inspector, under its gain, and marks the clip that fades (SPEC-038 R-44)", async () => {
    const { state, timeline } = migratedState(), id = "cl_ov-01J8G0000000000000000000A1", second = timeline.frameRate;
    const screen = await mountCut(state);
    const type = async (label: string, value: string) => {
      const found = [...screen.container.querySelectorAll("label")].find((row) => row.childNodes[0]?.textContent === label);
      assert.ok(found, `${label} is a field`);
      const input = document.getElementById(found.getAttribute("for")!) as HTMLInputElement;
      await act(async () => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); });
      await act(async () => { const event = new Event("keydown", { bubbles: true }); Object.assign(event, { key: "Enter" }); input.dispatchEvent(event); });
    };
    try {
      await act(async () => screen.container.querySelector<HTMLButtonElement>(`[data-clip='${id}']`)!.click());
      const section = screen.container.querySelector('[aria-label="Sound fade"]');
      assert.ok(section, "a sound clip shows its fades");
      assert.equal(section.querySelector("h3")?.textContent, "Fade");
      assert.deepEqual([...section.querySelectorAll("label")].map((row) => row.childNodes[0]?.textContent), ["Fade in", "Fade out"]);
      const inspector = screen.container.querySelector(".fy-cutinspect")!.innerHTML;
      assert.ok(inspector.indexOf("Gain 1 dB quieter") < inspector.indexOf('aria-label="Sound fade"'), "under Gain");

      await type("Fade in", "1");
      assert.deepEqual(commandsSent(screen).at(-1)?.commands, [{ kind: "sound-fade", clipId: id, inFrames: second }], "one edge, in frames; the other is left alone");
      assert.equal(commandsSent(screen).at(-1)?.label, "Set sound fade");
      // The clip is two seconds long, and a fade is no longer than its clip.
      const before = commandsSent(screen).length;
      await type("Fade out", "5");
      assert.equal(commandsSent(screen).length, before, "a fade longer than its clip refuses before anything is sent");

      // What the coordinator would send back: the clip says it fades, to the eye and aloud.
      state.world!.productions[0]!.timeline = { status: "ready", timeline: applyTimelineCommands(timeline, [{ kind: "sound-fade", clipId: id, inFrames: second, outFrames: 12 }]) };
      await act(async () => __setStateForTest(structuredClone(state) as ClientState));
      const faded = screen.container.querySelector<HTMLButtonElement>(`[data-clip='${id}']`)!;
      assert.match(faded.getAttribute("aria-label") ?? "", /to 00:00:03:00, fades in, fades out$/);
      assert.deepEqual([...faded.querySelectorAll(".fy-typedclip__gain")].map((chip) => chip.textContent), ["FADE"]);
      await type("Fade out", "0");
      assert.deepEqual(commandsSent(screen).at(-1)?.commands, [{ kind: "sound-fade", clipId: id, outFrames: 0 }], "zero removes that edge");

      // With no clip selected the rows go with the rest of the clip's Inspector. Asked as a
      // boolean: a failed comparison of a DOM node makes the runner print the whole document.
      await act(async () => screen.container.querySelector<HTMLElement>(".fy-timeline__canvas")!.click());
      assert.equal(screen.container.querySelector('[aria-label="Sound fade"]') === null, true);
    } finally {
      await close(screen);
    }
  });

  it("sets a track's level and its hold under speech from the Inspector, and a fade's even-power shape (SPEC-038 R-52..R-54)", async () => {
    const { state, timeline } = migratedState(), id = "cl_ov-01J8G0000000000000000000A1";
    const trackId = timeline.tracks.find((track) => track.clips.some((clip) => clip.id === id))!.id;
    const screen = await mountCut(state);
    try {
      await act(async () => screen.container.querySelector<HTMLButtonElement>(`[data-clip='${id}']`)!.click());
      // The track's rows sit with its name, under the clip's own gain and fades.
      const inspector = screen.container.querySelector(".fy-cutinspect")!.innerHTML;
      assert.ok(inspector.indexOf('aria-label="Track name"') < inspector.indexOf("Track 1 dB quieter"), "with the track's name");
      await act(async () => byLabel(screen, "Track 1 dB quieter").click());
      assert.deepEqual(commandsSent(screen).at(-1)?.commands, [{ kind: "set-track", trackId, levelDb: -1 }]);
      assert.equal(commandsSent(screen).at(-1)?.label, "Set track level");
      await advance(state);
      await act(async () => byLabel(screen, "Track is lowered under speech").click());
      assert.deepEqual(commandsSent(screen).at(-1)?.commands, [{ kind: "set-track", trackId, ducks: false }]);
      assert.equal(commandsSent(screen).at(-1)?.label, "Hold track under speech");
      assert.equal(byLabel(screen, "Even-power fade").disabled, true, "with no fade there is no shape to set");

      // What the coordinator would send back: the track says its level and its hold, in the Inspector and on its name.
      state.world!.productions[0]!.timeline = { status: "ready", timeline: applyTimelineCommands(timeline, [{ kind: "set-track", trackId, levelDb: -6, ducks: false }, { kind: "sound-fade", clipId: id, inFrames: 12 }]) };
      await act(async () => __setStateForTest(structuredClone(state) as ClientState));
      assert.match(screen.container.querySelector(".fy-cutinspect")!.textContent ?? "", /Track level\s*−\s*-6 dB/);
      const hold = byLabel(screen, "Track holds under speech");
      assert.deepEqual([hold.getAttribute("aria-pressed"), hold.textContent], ["true", "Held"]);
      assert.match(screen.container.querySelector(`[data-track-id='${trackId}'] .fy-track__name`)!.getAttribute("title") ?? "", / · -6 dB · held under speech$/);
      await act(async () => hold.click());
      assert.deepEqual(commandsSent(screen).at(-1)?.commands, [{ kind: "set-track", trackId, ducks: true }]);
      await advance(state);
      assert.equal(byLabel(screen, "Even-power fade").textContent, "Off");
      await act(async () => byLabel(screen, "Even-power fade").click());
      assert.deepEqual(commandsSent(screen).at(-1)?.commands, [{ kind: "sound-fade", clipId: id, power: true }]);
      assert.equal(commandsSent(screen).at(-1)?.label, "Set fade shape");

      state.world!.productions[0]!.timeline = { status: "ready", timeline: applyTimelineCommands(timeline, [{ kind: "sound-fade", clipId: id, inFrames: 12, power: true }]) };
      await act(async () => __setStateForTest(structuredClone(state) as ClientState));
      assert.deepEqual([byLabel(screen, "Even-power fade").getAttribute("aria-pressed"), byLabel(screen, "Even-power fade").textContent], ["true", "On"]);
      assert.match(screen.container.querySelector<HTMLButtonElement>(`[data-clip='${id}']`)!.getAttribute("aria-label") ?? "", /, fades in, even power$/);
    } finally {
      await close(screen);
    }
  });

  it("gates a sound clip and sets it to a loudness from the Inspector, each one command the coordinator measures (SPEC-038 R-57..R-60)", async () => {
    const { state, timeline } = migratedState(), id = "cl_ov-01J8G0000000000000000000A1";
    const screen = await mountCut(state);
    try {
      await act(async () => screen.container.querySelector<HTMLButtonElement>(`[data-clip='${id}']`)!.click());
      const inspector = screen.container.querySelector(".fy-cutinspect")!.innerHTML, gateAt = inspector.indexOf('aria-label="Gate sound"');
      assert.ok(inspector.indexOf("Gain 1 dB quieter") < gateAt && gateAt < inspector.indexOf('aria-label="Sound fade"'), "under Gain, over the fades");
      // A gate is asked for, not made here: the command carries no measurement, and the coordinator fills it in.
      await act(async () => byLabel(screen, "Gate sound").click());
      assert.deepEqual(commandsSent(screen).at(-1)?.commands, [{ kind: "sound-gate", clipId: id, on: true }]);
      assert.equal(commandsSent(screen).at(-1)?.label, "Gate sound");
      assert.equal(byLabel(screen, "Target 1 LUFS quieter").disabled, true, "while a command is on its way the rows wait, as every row does");
      await advance(state);
      // A loudness: the target is the Inspector's, and what comes back is the clip's gain.
      await act(async () => byLabel(screen, "Target 1 LUFS quieter").click());
      await act(async () => byLabel(screen, "Target 1 LUFS quieter").click());
      assert.match(screen.container.querySelector(".fy-cutinspect")!.textContent ?? "", /Loudness\s*−\s*-22 LUFS/);
      const sentBefore = commandsSent(screen).length;
      assert.equal(sentBefore, 1, "choosing a target sends nothing");
      await act(async () => byLabel(screen, "Set clip to -22 LUFS").click());
      assert.deepEqual(commandsSent(screen).at(-1)?.commands, [{ kind: "match-loudness", clipId: id, lufs: -22 }]);
      assert.equal(commandsSent(screen).at(-1)?.label, "Set clip loudness");

      // What the coordinator would send back: the clip says it is gated, to the eye and aloud, and the row takes the gate off.
      state.world!.productions[0]!.timeline = { status: "ready", timeline: applyTimelineCommands(timeline, [
        { kind: "sound-gate", clipId: id, on: true, gate: { thresholdDb: -42, open: [[0.2, 1.1]] } }, { kind: "set-clip-gain", clipId: id, gainDb: 5.4 }]) };
      await act(async () => __setStateForTest(structuredClone(state) as ClientState));
      const gated = screen.container.querySelector<HTMLButtonElement>(`[data-clip='${id}']`)!;
      assert.match(gated.getAttribute("aria-label") ?? "", /, 5\.4 dB, gated$/);
      assert.equal([...gated.querySelectorAll(".fy-typedclip__gain")].some((chip) => chip.textContent === "GATE"), true);
      const off = byLabel(screen, "Remove gate");
      assert.deepEqual([off.getAttribute("aria-pressed"), off.textContent], ["true", "On"]);
      await act(async () => off.click());
      assert.deepEqual(commandsSent(screen).at(-1)?.commands, [{ kind: "sound-gate", clipId: id, on: false }]);
      assert.equal(commandsSent(screen).at(-1)?.label, "Remove gate");
    } finally {
      await close(screen);
    }
  });

  it("edits an unsaved cut's legacy placements as typed clips, fenced for the first write", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions[0]!;
    production.cut = {
      audio: [],
      overlays: [{ id: "ov_01J8G0000000000000000000A1", artifactId: BELLS, startSec: 1, endSec: 3, lane: 0, audio: "keep" }],
    } as never;
    const screen = await mountCut(state);
    try {
      // Nothing is folded on read (SPEC-037 R-2, A-1): the record is projected in memory, the
      // same fold the first write will save, so the lanes have nothing left to draw (issue 1159).
      assert.equal(screen.container.querySelector(".fy-clanes"), null, "no legacy lanes");
      assert.ok(screen.container.querySelector("[data-track-id='tr_lane-0-sound'] [data-clip='cl_ov-01J8G0000000000000000000A1']"), "the bells are an Ambience clip already");
      await act(async () => byLabel(screen, "Mute Overlay L0 sound").click());
      const sent = commandsSent(screen).at(-1);
      assert.ok(sent);
      assert.deepEqual(sent.commands, [{ kind: "set-track", trackId: "tr_lane-0-sound", muted: true }], "against the id the fold reserves");
      assert.equal(sent.baseRevision, null, "the first write materialises the record and folds the placement in");
      assert.equal(sent.sourceFingerprint, storyTimelineFingerprint(production));
    } finally {
      await close(screen);
    }
  });
});
