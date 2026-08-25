import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClientStateSchema, type ClientState, type ExportPreset } from "@arke-studio/contracts";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { __setStateForTest } from "../src/lib/store.js";
import { ExportsScreen, exportViewFor } from "../src/screens/production.js";
import { FIXTURE_STATE } from "./fixture-state.js";

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

function renderExports(state: ClientState, initialPreset: ExportPreset = "review-cut"): string {
  __setStateForTest(state);
  const world = state.world!;
  const production = world.productions[0]!;
  const path = `/w/${world.meta.worldId}/p/${production.meta.id}/exports`;
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/w/:worldId/p/:prodId/exports"
          element={<ExportsScreen initialPreset={initialPreset} />}
        />
      </Routes>
    </MemoryRouter>,
  )
    .replaceAll("<!-- -->", "")
    .replaceAll("&#x27;", "'");
}

function exportAction(html: string): { text: string; disabled: boolean } {
  const match =
    /<button([^>]*class="ui-btn ui-btn--primary ui-btn--default"[^>]*)>(Export[^<]*)<\/button>/.exec(html);
  assert.ok(match, "the primary export action is rendered");
  return { text: match[2]!, disabled: /\bdisabled=/.test(match[1]!) };
}

function assertSelectedPreset(html: string, label: string): void {
  const selected = /<button[^>]*class="fy-radio fy-radio--on"[^>]*>([\s\S]*?)<\/button>/.exec(html);
  assert.ok(selected?.[1]?.includes(label), `${label} is the selected preset`);
}

describe("the Exports screen's exhaustive cut views (issue 405)", () => {
  it("keeps an ordinary production on scene-order runtime, gap copy, and enabled presets", () => {
    const html = renderExports(structuredClone(FIXTURE_STATE) as ClientState, "master");

    assertSelectedPreset(html, "Master");
    assert.deepEqual(exportAction(html), { text: "Export · 10s", disabled: false });
    assert.ok(
      html.includes(
        "The cut has 1 gap (6s). They export as black slates carrying their labels and durations — an unfinished film still reviews.",
      ),
    );
    assert.ok(!html.includes("song to cut against"), "scene-order copy says nothing about a spine");
    assert.ok(!html.includes("cannot be made yet"), "ordinary presets retain their existing readiness");
  });

  it("blocks every preset when the named track artifact is missing, without borrowing scene runtime", () => {
    const html = renderExports(spineState("missing"), "master");

    assertSelectedPreset(html, "Master");
    assert.deepEqual(exportAction(html), { text: "Export", disabled: true });
    assert.ok(
      html.includes(
        "The spine names a track this world does not have, so there is nothing to measure or cut against. Assign a track again — the anchors are unaffected.",
      ),
    );
    assert.ok(
      !html.includes("Export · 10s"),
      "missing spine media never falls through to scene-order runtime",
    );
  });

  it("lets export measure an unmeasured track and claims no runtime it has not measured", () => {
    const html = renderExports(spineState("unmeasured"), "master");

    assertSelectedPreset(html, "Master");
    assert.deepEqual(exportAction(html), { text: "Export", disabled: false });
    assert.ok(
      html.includes(
        "The master track has not been measured yet, so its length is not known here. Exporting measures it first and renders against it — or says why it cannot be read. Nothing about the production changes either way.",
      ),
    );
    assert.ok(
      !html.includes("cannot be made yet"),
      "the export path is allowed to probe before deciding readiness",
    );
  });

  it("uses a silent track's measured runtime but blocks it with the silent-track reason", () => {
    const html = renderExports(spineState("silent"), "social-excerpt");

    assertSelectedPreset(html, "Social excerpt");
    assert.deepEqual(exportAction(html), { text: "Export · 20s", disabled: true });
    assert.ok(
      html.includes(
        "The master track has no audio stream, so there is no song to cut against. Assign a track that carries audio — nothing else about the production changes.",
      ),
    );
    assert.ok(
      !html.includes("track this world does not have"),
      "silent and missing tracks remain distinct states",
    );
  });

  it("renders a measured spine review from the song clock with every distinct gap note", () => {
    const html = renderExports(spineState("audio", true));

    assertSelectedPreset(html, "Review cut");
    assert.deepEqual(exportAction(html), { text: "Export · 20s", disabled: false });
    assert.ok(html.includes("6s is a labelled slate naming the shot that is missing"));
    assert.ok(html.includes("6s is plain black, anchored to no shot at all"));
    assert.ok(html.includes("1 shot anchored nowhere in the song, so it is not in the film at all"));
    assert.ok(html.includes("unresolved: no-take"));
    assert.ok(html.includes("An unfinished film still reviews."));
    assert.ok(!html.includes("The cut has 1 gap"), "spine readiness never reuses scene-order gap copy");
  });

  for (const [preset, label] of [
    ["master", "Master"],
    ["social-excerpt", "Social excerpt"],
  ] as const) {
    it(`names the ${preset} refusal and disables only the selected deliverable`, () => {
      const html = renderExports(spineState("audio", true), preset);

      assertSelectedPreset(html, label);
      assert.deepEqual(exportAction(html), { text: "Export · 20s", disabled: true });
      assert.ok(
        html.includes(
          `${label} cannot be made yet — 1 shot and 6.0s of unanchored song have no picture; 1 shot anchored nowhere in the song; unresolved: no-take.`,
        ),
      );
      assert.ok(
        html.includes("A review cut renders anyway:"),
        "the available review path is stated beside the refusal",
      );
    });
  }

  it("keeps the client spine preview anchor-ordered when scenes are reordered", () => {
    const before = spineState("audio", true);
    const beforeWorld = before.world!;
    const beforeView = exportViewFor(beforeWorld, beforeWorld.productions[0]!);
    assert.equal(beforeView.kind, "spine");

    const after = structuredClone(before) as ClientState;
    const production = after.world!.productions[0]!;
    production.scenes[0]!.order = 2;
    production.scenes[1]!.order = 1;
    production.scenes = [production.scenes[1]!, production.scenes[0]!];
    assert.deepEqual(
      production.scenes.map((scene) => scene.id),
      ["sc_05", "sc_04"],
    );

    const afterView = exportViewFor(after.world!, production);
    assert.equal(afterView.kind, "spine");
    if (beforeView.kind !== "spine" || afterView.kind !== "spine")
      assert.fail("expected measured spine views");
    assert.deepEqual(
      afterView.cut.segments,
      beforeView.cut.segments,
      "the preview follows anchor time, never scene order",
    );
    assert.equal(afterView.cut.trackDurationSec, beforeView.cut.trackDurationSec);
  });
});
