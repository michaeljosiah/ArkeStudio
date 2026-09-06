import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  ClientStateSchema,
  legacySceneView,
  orderedShots,
  seedEmptyPictureTimeline,
  seedSpinePictureTimeline,
  seedStoryPictureTimeline,
  type ClientMessage,
  type ClientState,
} from "@arke-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { CutScreen } from "../src/screens/production.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Delivery is the editor's export sheet (SPEC-039 T-5): `/exports` lands on `/cut?export=1`, and
 * the Exports screen these cases were first written against is gone. Every refusal it proved is
 * proved here against the sheet — a story with nothing saved, an invalid record, a song not yet
 * opened on the timeline whatever its master's state, a master that has left the world, a
 * placement with no picture — and so is the gap that exports as a slate (issue 405).
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, {
  matchMedia: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }),
  getComputedStyle: () => ({ direction: "ltr", getPropertyValue: () => "" }),
});
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {} });
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), { pause() {}, play: () => Promise.resolve() });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  HTMLMediaElement: dom.HTMLMediaElement,
  Node: dom.Node,
  Event: dom.Event,
  KeyboardEvent: dom.window.KeyboardEvent ?? dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const TRACK = "ar_01J8G0000000000000000000T1";
const BELLS = "ar_01J8G0000000000000000000R1";
const CLIP = "tk_01J8F0000000000000000000B2";
const AT = "2026-08-20T12:00:00Z";
const HASH = `sha256:${"a".repeat(64)}`;
/** The three resolutions, by the word each chip ends on. */
const RESOLUTIONS = ["master", "vertical", "review"] as const;

type TrackState = "missing" | "unmeasured" | "silent" | "audio";

function spineState(trackState: TrackState, withUnanchoredShot = false): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const world = state.world!;
  const production = world.productions[0]!;

  production.scenes[0]!.order = 1;
  if (withUnanchoredShot) {
    const scene = {
      id: "sc_05",
      number: 5,
      order: 2,
      slug: "after-the-song",
      title: "After the song",
      status: "accepted",
      version: 1,
      shots: [
        {
          id: "sh_14",
          number: 14,
          title: "The water settles",
          description: "The harbour falls still.",
          durationSec: 3,
        },
      ],
    } as (typeof production.scenes)[number];
    production.scenes.push(scene);
    production.sceneFiles[scene.id] = "after-the-song";
  }

  production.spine = {
    schemaVersion: 1,
    revision: 1,
    trackArtifactId: TRACK,
    markers: [],
    // Deliberately stored out of play order: time, not object or scene order, is authoritative.
    anchors: {
      sh_12: { startSec: 10, endSec: 18, clipAudio: { mode: "mute" } },
      sh_13: { startSec: 0, endSec: 6, clipAudio: { mode: "mute" } },
    },
    updatedAt: AT,
  };
  production.takeMediaInfo = {
    [CLIP]: { sourceHash: HASH, mediaInfo: { durationSec: 12, hasAudio: true }, probedAt: AT },
  };

  if (trackState !== "missing") {
    const mediaInfo =
      trackState === "unmeasured" ? {} : { mediaInfo: { durationSec: 20, hasAudio: trackState === "audio" } };
    world.artifacts.push({
      id: TRACK,
      kind: "audio",
      file: "master.wav",
      hash: "sha256:6a1e02b9c44d7f32",
      origin: { by: "user" },
      links: [],
      created: AT,
      ...mediaInfo,
    } as (typeof world.artifacts)[number]);
  }

  return ClientStateSchema.parse(state);
}

/** The song, opened on the timeline as its first assembly (SPEC-037 R-13). */
function withSongTimeline(state: ClientState): ClientState {
  const production = state.world!.productions[0]!;
  production.timeline = { status: "ready", timeline: seedSpinePictureTimeline(production, production.spine!, 20) };
  return ClientStateSchema.parse(state);
}

/** A production with no story: what is on its timeline is the film (issue 453). */
function storylessState(): { state: ClientState; production: NonNullable<ClientState["world"]>["productions"][number] } {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const production = state.world!.productions[0]!;
  production.scenes = [];
  production.sceneFiles = {};
  return { state, production };
}

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

/** The editor with the sheet up, exactly as the Exports address lands (SPEC-039 R-1). */
async function mountSheet(state: ClientState): Promise<Mounted> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest(bridge(sent));
  __setStateForTest(state);
  const world = state.world!;
  const production = world.productions[0]!;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/w/${world.meta.worldId}/p/${production.meta.id}/cut?export=1`]}>
        <Routes>
          <Route path="/w/:worldId/p/:prodId/cut" element={<CutScreen />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return { container, root, sent };
}

async function unmount(mounted: Mounted): Promise<void> {
  await act(async () => mounted.root.unmount());
  mounted.container.remove();
}

function sheet(mounted: Mounted): HTMLElement {
  const found = mounted.container.querySelector<HTMLElement>('[data-testid="export-sheet"]');
  assert.ok(found, "the export sheet is up");
  return found;
}

/** The dialog's subtitle: the runtime and coverage when there is a film, the block when there is not. */
function meta(mounted: Mounted): string {
  return mounted.container.querySelector(".fy-editordialog__sub")?.textContent ?? "";
}

function warnings(mounted: Mounted): string[] {
  return [...sheet(mounted).querySelectorAll(".fy-exsheet__warn")].map((node) => node.textContent ?? "");
}

function primary(mounted: Mounted): HTMLButtonElement {
  const button = [...mounted.container.querySelectorAll<HTMLButtonElement>(".fy-libpick__confirm")].find((node) =>
    node.textContent?.startsWith("Export"),
  );
  assert.ok(button, "the sheet's primary is rendered");
  return button;
}

function action(mounted: Mounted): { text: string; disabled: boolean } {
  const button = primary(mounted);
  return { text: button.textContent ?? "", disabled: button.disabled };
}

function resolutionChip(mounted: Mounted, label: string): HTMLButtonElement {
  const chip = [...sheet(mounted).querySelectorAll<HTMLButtonElement>('[aria-label="Resolution"] .fy-exsheet__chip')].find((node) =>
    node.textContent?.endsWith(label),
  );
  assert.ok(chip, `the ${label} resolution is offered`);
  return chip;
}

async function chooseResolution(mounted: Mounted, label: string): Promise<void> {
  await act(async () => resolutionChip(mounted, label).click());
  assert.equal(resolutionChip(mounted, label).getAttribute("aria-pressed"), "true", `${label} is selected`);
}

function exportsSent(mounted: Mounted): Extract<ClientMessage, { kind: "export-cut" }>[] {
  return mounted.sent.filter((message): message is Extract<ClientMessage, { kind: "export-cut" }> => message.kind === "export-cut");
}

/** The song clock's one way onto the timeline (SPEC-037 R-13); the Cut offers it only for a master it can cut against. */
function openOnTimeline(mounted: Mounted): HTMLButtonElement | undefined {
  return [...mounted.container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === "Open on the timeline");
}

function renderCut(state: ClientState): HTMLElement {
  __setStateForTest(state);
  const world = state.world!;
  const production = world.productions[0]!;
  const path = `/w/${world.meta.worldId}/p/${production.meta.id}/cut`;
  const html = renderToString(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/w/:worldId/p/:prodId/cut" element={<CutScreen />} />
      </Routes>
    </MemoryRouter>,
  );
  return parseHTML(`<main>${html}</main>`).document.querySelector("main")!;
}

function spineLane(container: HTMLElement): string[] {
  const lane = [...container.querySelectorAll<HTMLElement>(".fy-track__lane")].find((node) =>
    node.querySelector(".fy-cutseg--black"),
  );
  assert.ok(lane, "the spine picture lane is rendered");
  return [...lane.children].map((child) => `${child.className}:${child.textContent ?? ""}`);
}

afterEach(() => {
  __setBridgeForTest(null);
  document.body.replaceChildren();
});

describe("export audio status (#908)", () => {
  for (const sound of ["audio", "silent", "unmeasured"] as const) {
    it(`reports ${sound} video sound for the film and episode before export`, async () => {
      const state = structuredClone(FIXTURE_STATE) as ClientState;
      const p = state.world!.productions[0]!;
      p.meta.kind = "series";
      p.cut = { audio: [], overlays: [] };
      p.scenes[0]!.shots = [p.scenes[0]!.shots[0]!];
      p.episodes = [{ id: "ep_one", version: 1, order: 1, title: "One", scenes: [p.scenes[0]!.id] }];
      p.takeMediaInfo = sound === "unmeasured" ? {} : {
        [CLIP]: { sourceHash: HASH, probedAt: AT, mediaInfo: { durationSec: 4, hasAudio: sound === "audio" } },
      };
      p.timeline = { status: "ready", timeline: seedStoryPictureTimeline(p) };
      const mounted = await mountSheet(state);
      try {
        const message = sound === "audio" ? null : sound === "silent"
          ? "No sound — no audible audio in this cut" : "No sound — video audio not measured";
        assert.deepEqual(warnings(mounted), message ? [message] : []);
        const chips = [...sheet(mounted).querySelectorAll<HTMLButtonElement>('[aria-label="Audio"] button')];
        assert.equal(chips.length, 2);
        assert.ok(chips.every(chip => chip.disabled === (sound !== "audio")));
        const episode = sheet(mounted).querySelector(".fy-exsheet__episode")!;
        assert.ok(episode);
        const status = episode.querySelector('[role="status"]');
        if (message) assert.ok(status?.textContent?.includes(message)); else assert.equal(status, null);
        if (sound === "unmeasured") assert.ok(status?.textContent?.includes(p.timeline.timeline.tracks[0]!.clips[0]!.source.label));
        assert.equal(primary(mounted).disabled, false, "silence remains exportable");
      } finally { await unmount(mounted); }
    });
  }
});

describe("the export sheet's refusals (SPEC-039 T-5; issue 405)", () => {
  it("refuses a story with nothing saved, then exports its timeline with the gap as a slate at every resolution", async () => {
    const empty = await mountSheet(structuredClone(FIXTURE_STATE) as ClientState);
    try {
      assert.deepEqual(warnings(empty), ["Nothing on the timeline yet. Add to the Library and place, or ask Arke."]);
      assert.deepEqual(action(empty), { text: "Export film", disabled: true });
      assert.ok(!meta(empty).includes("10s"), "no runtime is claimed for a film that is not on the timeline");
    } finally {
      await unmount(empty);
    }

    const saved = structuredClone(FIXTURE_STATE) as ClientState;
    const production = saved.world!.productions[0]!;
    const timeline = seedStoryPictureTimeline(production);
    production.timeline = { status: "ready", timeline };
    const mounted = await mountSheet(ClientStateSchema.parse(saved));
    try {
      assert.equal(meta(mounted), "10s · 1 of 2 shots · 1 gap");
      assert.deepEqual(warnings(mounted), ["No sound — video audio not measured", "1 shot has no accepted take. Exporting now writes a black slate where it sits."]);
      for (const label of RESOLUTIONS) {
        await chooseResolution(mounted, label);
        assert.deepEqual(action(mounted), { text: "Export with gaps", disabled: false }, `${label} exports the unfinished film`);
      }
      const text = sheet(mounted).textContent ?? "";
      // Labels state only what the encode does (SPEC-038 R-31, issue 682).
      assert.ok(!text.includes("timecode"), "no timecode is burned");
      assert.ok(!text.includes("captions"), "no captions are burned unless asked for");
      assert.ok(text.includes("1080 × 1920 · vertical"), "the 9:16 preset is named by its frame");
      await chooseResolution(mounted, "master");
      await act(async () => primary(mounted).click());
      const [request, ...rest] = exportsSent(mounted);
      assert.ok(request, "the export was sent");
      assert.deepEqual(rest, [], "once");
      assert.equal(request.preset, "master", "the chosen resolution is the preset the request carries");
      assert.equal(request.timelineRevision, timeline.revision);
      assert.equal(request.subtitles, undefined);
      assert.equal(request.episodeId, undefined);
      assert.equal(mounted.container.querySelector('[data-testid="export-sheet"]'), null, "the sheet closes");
    } finally {
      await unmount(mounted);
    }
  });

  it("refuses an invalid record in its own words", async () => {
    const invalid = structuredClone(FIXTURE_STATE) as ClientState;
    invalid.world!.productions[0]!.timeline = { status: "invalid", message: "timeline.json is malformed" };
    const mounted = await mountSheet(invalid);
    try {
      assert.deepEqual(warnings(mounted), ["Timeline unavailable · timeline.json is malformed"]);
      assert.equal(meta(mounted), "Timeline unavailable · timeline.json is malformed");
      assert.deepEqual(action(mounted), { text: "Export film", disabled: true });
    } finally {
      await unmount(mounted);
    }
  });

  it("refuses a production with no story when what is placed has no picture", async () => {
    const { state, production } = storylessState();
    const timeline = seedEmptyPictureTimeline(production);
    timeline.tracks[0]!.clips.push({
      id: "cl_bells",
      startFrame: 0,
      durationFrames: 48,
      sourceInFrames: 0,
      source: { kind: "artifact", artifactId: BELLS, label: "harbour-bells.wav" },
    });
    production.timeline = { status: "ready", timeline };
    const mounted = await mountSheet(ClientStateSchema.parse(state));
    try {
      assert.deepEqual(warnings(mounted), ["cl_bells cites harbour-bells.wav, which is audio and has no picture"]);
      assert.equal(action(mounted).disabled, true);
    } finally {
      await unmount(mounted);
    }
  });

  it("refuses a production with no story and nothing on its timeline rather than offering a zero-length film", async () => {
    const { state, production } = storylessState();
    production.timeline = { status: "ready", timeline: seedEmptyPictureTimeline(production) };
    const mounted = await mountSheet(ClientStateSchema.parse(state));
    try {
      // An empty plan is `concat=n=0`, which is not a filter graph; the coordinator would fail it only after reporting it running.
      assert.deepEqual(warnings(mounted), ["Nothing on the timeline yet. Add to the Library and place, or ask Arke."]);
      assert.deepEqual(action(mounted), { text: "Export film", disabled: true });
      assert.equal(meta(mounted), "Nothing on the timeline yet. Add to the Library and place, or ask Arke.", "a film of nothing has no runtime to claim");
    } finally {
      await unmount(mounted);
    }
  });
});

describe("the song clock on the export sheet", () => {
  it("refuses a master owned by another production before materializing the song (#895)", async () => {
    const state = spineState("audio");
    state.world!.artifacts.find(artifact => artifact.id === TRACK)!.production = "another-production";
    const cut = renderCut(state);
    assert.match(cut.textContent!, /Preview and export unavailable.*belongs to another production/);
    assert.equal(cut.querySelector("audio"), null, "the foreign master is not offered for playback");
    const mounted = await mountSheet(state);
    try {
      assert.match(warnings(mounted).join(" "), /Master track cites artifact .*belongs to another production.*Import the file/);
      assert.equal(action(mounted).disabled, true);
      assert.equal(openOnTimeline(mounted), undefined);
    } finally { await unmount(mounted); }
  });
  it("refuses a song that is not on the timeline yet, and offers the way there only for a master it can cut against", async () => {
    for (const trackState of ["missing", "unmeasured", "silent", "audio"] as const) {
      const mounted = await mountSheet(spineState(trackState));
      try {
        assert.deepEqual(warnings(mounted), ["Open the song on the timeline first."], trackState);
        assert.deepEqual(action(mounted), { text: "Export film", disabled: true }, trackState);
        assert.ok(!meta(mounted).includes("20s"), `${trackState}: no runtime is claimed before the song is on the timeline`);
        assert.ok(!meta(mounted).includes("10s"), `${trackState}: the scene-order runtime is never borrowed`);
        /*
         * A master the world does not have, one nobody measured, and one with no audio stream all
         * end the same way here (SPEC-037 R-13): the song cannot be opened on the timeline, so the
         * Cut does not offer to. Only the measured, audible master gets the button.
         */
        const open = openOnTimeline(mounted);
        if (trackState === "audio") {
          assert.ok(open, "a measured master that carries sound opens on the timeline");
          assert.equal(open.disabled, false);
        } else {
          assert.equal(open, undefined, `${trackState}: nothing to open on the timeline`);
        }
      } finally {
        await unmount(mounted);
      }
    }
  });

  it("exports a saved song at the song's length, slating the anchored shot with no take", async () => {
    const mounted = await mountSheet(withSongTimeline(spineState("audio", true)));
    try {
      assert.match(meta(mounted), /^20s · /, "the song is the runtime");
      assert.match(meta(mounted), / · 1 gap$/);
      assert.deepEqual(warnings(mounted), ["1 shot has no accepted take. Exporting now writes a black slate where it sits."]);
      for (const label of RESOLUTIONS) {
        await chooseResolution(mounted, label);
        assert.deepEqual(action(mounted), { text: "Export with gaps", disabled: false }, `${label} exports the unfinished song`);
      }
      await act(async () => primary(mounted).click());
      const [request] = exportsSent(mounted);
      assert.ok(request, "the export was sent");
      assert.equal(request.preset, "review-cut");
      assert.equal(request.timelineRevision, 0);
    } finally {
      await unmount(mounted);
    }
  });

  it("refuses a saved song whose master has left the world, naming the clip and the artifact", async () => {
    const mounted = await mountSheet(withSongTimeline(spineState("missing")));
    try {
      assert.deepEqual(warnings(mounted), [`cl_master cites artifact ${TRACK}, which this world does not have`]);
      assert.equal(action(mounted).disabled, true);
      assert.ok(!meta(mounted).includes("10s"), "the scene-order runtime is never borrowed");
    } finally {
      await unmount(mounted);
    }
  });
});

describe("the Cut's spine lane", () => {
  it("keeps the rendered client preview anchor-ordered when scenes are reordered", () => {
    const before = spineState("audio", true);
    const beforeProduction = before.world!.productions[0]!;
    const sceneA = legacySceneView(beforeProduction.scenes[0]!);
    sceneA.shots = sceneA.shots.filter((shot) => shot.id !== "sh_13");
    beforeProduction.scenes[0] = sceneA;
    const sceneB = legacySceneView(beforeProduction.scenes[1]!);
    sceneB.shots[0] = {
      id: "sh_13",
      number: 13,
      title: "The lamps answer",
      description: "The lamps flare and settle.",
      durationSec: 6,
    };
    beforeProduction.scenes[1] = sceneB;
    assert.deepEqual(
      beforeProduction.scenes.map((scene) => scene.id),
      ["sc_04", "sc_05"],
    );
    assert.deepEqual(
      beforeProduction.scenes.map((scene) => orderedShots(scene).map((shot) => shot.id)),
      [["sh_12"], ["sh_13"]],
    );
    const validatedBefore = ClientStateSchema.parse(before);
    const beforeCut = renderCut(validatedBefore);
    const beforeLane = spineLane(beforeCut);
    assert.deepEqual(beforeLane, [
      "fy-cutseg fy-cutseg--gap fy-cutseg--gap-warn:SHOT 13 · The lamps answer · 6.0s",
      "fy-cutseg fy-cutseg--black:4s",
      "fy-cutseg fy-cutseg--pick:SC 4",
      "fy-cutseg fy-cutseg--black:2s",
    ]);
    assert.match(beforeCut.textContent ?? "", /20s · 14s of 20s covered · cut to the track/);

    const after = structuredClone(validatedBefore) as ClientState;
    const production = after.world!.productions[0]!;
    production.scenes[0]!.order = 2;
    production.scenes[1]!.order = 1;
    production.scenes = [production.scenes[1]!, production.scenes[0]!];
    assert.deepEqual(
      production.scenes.map((scene) => scene.id),
      ["sc_05", "sc_04"],
    );

    const afterCut = renderCut(ClientStateSchema.parse(after));
    assert.deepEqual(
      spineLane(afterCut),
      beforeLane,
      "the rendered lane follows anchor time, never scene order",
    );
    assert.match(afterCut.textContent ?? "", /20s · 14s of 20s covered · cut to the track/);
  });
});
