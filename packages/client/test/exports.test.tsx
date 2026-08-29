import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClientStateSchema, type ClientState } from "@arke-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { __setStateForTest } from "../src/lib/store.js";
import { CutScreen, ExportsScreen } from "../src/screens/production.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { orderedShots, writerSceneView } from "@arke-studio/contracts";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  HTMLMediaElement: dom.HTMLMediaElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const TRACK = "ar_01J8G0000000000000000000T1";
const CLIP = "tk_01J8F0000000000000000000B2";
const AT = "2026-08-20T12:00:00Z";
const HASH = `sha256:${"a".repeat(64)}`;

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

interface RenderedScreen {
  container: HTMLElement;
  root: Root;
}

async function renderExports(state: ClientState): Promise<RenderedScreen> {
  __setStateForTest(state);
  const world = state.world!;
  const production = world.productions[0]!;
  const path = `/w/${world.meta.worldId}/p/${production.meta.id}/exports`;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/w/:worldId/p/:prodId/exports" element={<ExportsScreen />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return { container, root };
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

async function unmount(screen: RenderedScreen): Promise<void> {
  await act(async () => screen.root.unmount());
  screen.container.remove();
}

function allText(screen: RenderedScreen): string {
  return screen.container.textContent ?? "";
}

function presetButton(screen: RenderedScreen, label: string): HTMLButtonElement {
  const button = [...screen.container.querySelectorAll<HTMLButtonElement>("button")].find((node) =>
    node.textContent?.includes(label),
  );
  assert.ok(button, `${label} preset is rendered`);
  return button;
}

async function choosePreset(screen: RenderedScreen, label: string): Promise<void> {
  await act(async () => presetButton(screen, label).click());
}

function exportAction(screen: RenderedScreen): { text: string; disabled: boolean } {
  const button = [...screen.container.querySelectorAll<HTMLButtonElement>("button.ui-btn--primary")].find(
    (node) => node.textContent?.startsWith("Export"),
  );
  assert.ok(button, "the primary export action is rendered");
  return { text: button.textContent ?? "", disabled: button.disabled };
}

function assertSelectedPreset(screen: RenderedScreen, label: string): void {
  assert.ok(presetButton(screen, label).classList.contains("fy-radio--on"), `${label} is selected`);
}

function spineLane(container: HTMLElement): string[] {
  const lane = [...container.querySelectorAll<HTMLElement>(".fy-track__lane")].find((node) =>
    node.querySelector(".fy-cutseg--black"),
  );
  assert.ok(lane, "the spine picture lane is rendered");
  return [...lane.children].map((child) => `${child.className}:${child.textContent ?? ""}`);
}

describe("the Exports screen's exhaustive cut views (issue 405)", () => {
  it("keeps an ordinary production on scene-order runtime, gap copy, and enabled presets", async () => {
    const renderer = await renderExports(structuredClone(FIXTURE_STATE) as ClientState);
    for (const label of ["Master", "Social excerpt", "Review cut"]) {
      await choosePreset(renderer, label);
      assertSelectedPreset(renderer, label);
      assert.deepEqual(exportAction(renderer), { text: "Export · 10s", disabled: false });
    }
    const text = allText(renderer);
    assert.ok(
      text.includes(
        "The cut has 1 gap (6s). They export as black slates carrying their labels and durations — an unfinished film still reviews.",
      ),
    );
    assert.ok(!text.includes("song to cut against"), "scene-order copy says nothing about a spine");
    assert.ok(!text.includes("cannot be made yet"), "ordinary presets retain their existing readiness");
    await unmount(renderer);
  });

  it("blocks every preset when the named track artifact is missing, without borrowing scene runtime", async () => {
    const renderer = await renderExports(spineState("missing"));
    for (const label of ["Master", "Social excerpt", "Review cut"]) {
      await choosePreset(renderer, label);
      assertSelectedPreset(renderer, label);
      assert.deepEqual(exportAction(renderer), { text: "Export", disabled: true });
    }
    const text = allText(renderer);
    assert.ok(
      text.includes(
        "The spine names a track this world does not have, so there is nothing to measure or cut against. Assign a track again — the anchors are unaffected.",
      ),
    );
    assert.ok(
      !text.includes("Export · 10s"),
      "missing spine media never falls through to scene-order runtime",
    );
    await unmount(renderer);
  });

  it("lets every preset measure an unmeasured track and claims no runtime it has not measured", async () => {
    const renderer = await renderExports(spineState("unmeasured"));
    for (const label of ["Master", "Social excerpt", "Review cut"]) {
      await choosePreset(renderer, label);
      assertSelectedPreset(renderer, label);
      assert.deepEqual(exportAction(renderer), { text: "Export", disabled: false });
    }
    const text = allText(renderer);
    assert.ok(
      text.includes(
        "The master track has not been measured yet, so its length is not known here. Exporting measures it first and renders against it — or says why it cannot be read. Nothing about the production changes either way.",
      ),
    );
    assert.ok(!text.includes("cannot be made yet"), "the export path may probe before deciding readiness");
    await unmount(renderer);
  });

  it("uses a silent track's measured runtime and blocks every preset with the silent-track reason", async () => {
    const renderer = await renderExports(spineState("silent"));
    for (const label of ["Master", "Social excerpt", "Review cut"]) {
      await choosePreset(renderer, label);
      assertSelectedPreset(renderer, label);
      assert.deepEqual(exportAction(renderer), { text: "Export · 20s", disabled: true });
    }
    const text = allText(renderer);
    assert.ok(
      text.includes(
        "The master track has no audio stream, so there is no song to cut against. Assign a track that carries audio — nothing else about the production changes.",
      ),
    );
    assert.ok(
      !text.includes("track this world does not have"),
      "silent and missing tracks remain distinct states",
    );
    await unmount(renderer);
  });

  it("renders a measured spine review from the song clock with every distinct gap note", async () => {
    const renderer = await renderExports(spineState("audio", true));

    assertSelectedPreset(renderer, "Review cut");
    assert.deepEqual(exportAction(renderer), { text: "Export · 20s", disabled: false });
    const text = allText(renderer);
    assert.ok(text.includes("6s is a labelled slate naming the shot that is missing"));
    assert.ok(text.includes("6s is plain black, anchored to no shot at all"));
    assert.ok(text.includes("1 shot anchored nowhere in the song, so it is not in the film at all"));
    assert.ok(text.includes("unresolved: no-take"));
    assert.ok(text.includes("An unfinished film still reviews."));
    assert.ok(!text.includes("The cut has 1 gap"), "spine readiness never reuses scene-order gap copy");
    await unmount(renderer);
  });

  it("recomputes preset-specific refusals as the user changes the selected deliverable", async () => {
    const renderer = await renderExports(spineState("audio", true));
    for (const label of ["Master", "Social excerpt"] as const) {
      await choosePreset(renderer, label);
      assertSelectedPreset(renderer, label);
      assert.deepEqual(exportAction(renderer), { text: "Export · 20s", disabled: true });
      assert.ok(
        allText(renderer).includes(
          `${label} cannot be made yet — 1 shot and 6.0s of unanchored song have no picture; 1 shot anchored nowhere in the song; unresolved: no-take.`,
        ),
      );
    }

    await choosePreset(renderer, "Review cut");
    assertSelectedPreset(renderer, "Review cut");
    assert.deepEqual(exportAction(renderer), { text: "Export · 20s", disabled: false });
    assert.ok(!allText(renderer).includes("cannot be made yet"));
    assert.ok(allText(renderer).includes("A review cut renders anyway:"));
    await unmount(renderer);
  });

  it("keeps the rendered client preview anchor-ordered when scenes are reordered", async () => {
    const before = spineState("audio", true);
    const beforeProduction = before.world!.productions[0]!;
    const sceneA = writerSceneView(beforeProduction.scenes[0]!);
    sceneA.shots = sceneA.shots.filter((shot) => shot.id !== "sh_13");
    beforeProduction.scenes[0] = sceneA;
    const sceneB = writerSceneView(beforeProduction.scenes[1]!);
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
      "fy-cutseg fy-cutseg--pick fy-cutseg--selected:SC 4",
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
