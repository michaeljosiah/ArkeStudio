import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { BenchSession, ClientState, ManifestModel } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { ReferencePickerBody, type PickerSource } from "../src/components/reference-picker.js";

/**
 * The bench (issue 305): the screen restores a session — strip, references, brief, selection —
 * from state alone, which is exactly what surviving a restart means (§1). And the picker's
 * refusals are the coordinator's own sentences, predicted with the same shared functions.
 */

const SESSION_ID = "sess_01J8F3K2QW9VZX4N7M0RTYB6HD";
const TAKE_ID = "tk_01J8F3K2QW9VZX4N7M0RTYB6HE";

const IMAGE_MODEL: ManifestModel = {
  id: "test-image",
  provider: "fal",
  capability: "image",
  displayName: "Test Image",
  accepts: { referenceImages: 2, referenceRoles: false, startFrame: false, endFrame: false },
  limits: { maxPromptChars: 500 },
  pricing: { kind: "perImage", microUsdPerImage: 60000 },
};

function benchSession(): BenchSession {
  return {
    schemaVersion: 1,
    id: SESSION_ID,
    title: "Harbour night studies",
    composer: {
      mode: "image",
      provider: "fal",
      model: "test-image",
      params: { kind: "image", count: 2 },
      brief: "A rusted tide-clock face, citing Image 1.",
      activeTokens: ["Image 1"],
      keyframeTokens: [],
    },
    tokenRegistry: [
      {
        token: "Image 1",
        kind: "image",
        source: { source: "artifact", artifactId: "ar_01J8F3K2QW9VZX4N7M0RTYB6HF", hash: "sha256:deadbeef" },
      },
    ],
    nextToken: { image: 2 },
    nextTake: 2,
    selectedTakeId: TAKE_ID,
    takes: [
      {
        id: TAKE_ID,
        n: 1,
        requestId: "r1",
        status: "succeeded",
        request: {
          mode: "image",
          brief: "A rusted tide-clock face, citing Image 1.",
          references: [],
          keyframes: [],
          provider: "fal",
          model: "test-image",
          params: { kind: "image", count: 1 },
        },
        media: { file: "take.png", hash: "sha256:beefbeef" },
        cost: { estimatedMicroUsd: 60000, actualMicroUsd: 60000 },
        disposition: "open",
        createdAt: "2026-08-16T10:00:00.000Z",
        completedAt: "2026-08-16T10:01:00.000Z",
      },
    ],
    createdAt: "2026-08-16T10:00:00.000Z",
    updatedAt: "2026-08-16T10:01:00.000Z",
  };
}

function stateWithBench(): ClientState {
  const base = FIXTURE_STATE;
  return {
    ...base,
    app: { ...base.app, manifest: { ...base.app.manifest!, models: [...base.app.manifest!.models, IMAGE_MODEL] } },
    bench: { worldId: FIXTURE_WORLD_ID, session: benchSession() },
  };
}

function renderAt(path: string, state: ClientState): string {
  __setStateForTest(state);
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe("the bench screen (issue 305 §3)", () => {
  it("restores the session whole: title, brief, token, numbered take, selection", () => {
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, stateWithBench());
    assert.match(html, /Harbour night studies/);
    assert.match(html, /A rusted tide-clock face, citing Image 1\./);
    assert.match(html, /Image 1/);
    assert.match(html, /data-testid="strip-take"/);
    assert.match(html, /TAKE 1/); // the wall names the selected take by its number
    assert.match(html, /Keep · file as artifact/);
  });

  it("the counter exists exactly where the model publishes a cap (issue 305 §5.1)", () => {
    const withCap = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, stateWithBench());
    assert.match(withCap, /data-testid="prompt-counter"/);
    assert.match(withCap, /41\/500/); // the brief's own length against the row's figure

    // The same screen under a model with no published cap shows NO counter — not a default.
    const state = stateWithBench();
    const capless = {
      ...state,
      app: {
        ...state.app,
        manifest: {
          ...state.app.manifest!,
          models: state.app.manifest!.models.map((m) => (m.id === "test-image" ? { ...m, limits: {} } : m)),
        },
      },
    };
    const without = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, capless);
    assert.doesNotMatch(without, /data-testid="prompt-counter"/);
  });

  it("the estimate follows the count: two takes price twice one", () => {
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, stateWithBench());
    // count: 2 at $0.06/image → ~$0.12
    assert.match(html, /~\$0\.12/);
  });
});

describe("the Artifacts door (issue 305 §2)", () => {
  it("carries Generate, and the made-here count appears only when a bench artifact exists", () => {
    const plain = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts`, FIXTURE_STATE);
    assert.match(plain, /data-testid="artifacts-generate"/);
    assert.doesNotMatch(plain, /Made here/);

    const state = stateWithBench();
    const withMade = {
      ...state,
      world: {
        ...state.world!,
        artifacts: [
          ...state.world!.artifacts,
          {
            id: "ar_01J8F3K2QW9VZX4N7M0RTYB6HG",
            kind: "image" as const,
            file: "bench-take-1.png",
            hash: "sha256:beadbead",
            origin: { by: "system" as const, producedBy: "bench" },
            links: [],
            created: "2026-08-16T10:02:00.000Z",
          },
        ],
      },
    };
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts`, withMade);
    assert.match(html, /Made here 1/);
    assert.match(html, /1 made here/);
  });
});

describe("the reference picker's refusals (issue 305 §9)", () => {
  const audioSource: PickerSource = {
    key: "artifact:ar_a",
    kind: "audio",
    name: "harbour-bells.wav",
    meta: "wav · 2:14",
    durationSec: 134,
    pick: { source: "artifact", artifactId: "ar_a" },
  };
  const documentSource: PickerSource = {
    key: "artifact:ar_d",
    kind: "document",
    name: "treatment.pdf",
    meta: "pdf",
    durationSec: null,
    pick: { source: "artifact", artifactId: "ar_d" },
  };

  it("speaks the coordinator's own sentences on the tile", () => {
    const html = renderToString(
      <ReferencePickerBody
        mode="bench"
        worldSlug="the-undersong"
        model={IMAGE_MODEL}
        carried={[]}
        world={[audioSource, documentSource]}
        session={[]}
        onUpload={() => {}}
        onClose={() => {}}
      />,
    );
    // No audio allowance on the row → the kind refuses; a document refuses whatever the model.
    assert.match(html, /this model takes no audio/);
    assert.match(html, /a document cannot be sent/);
  });

  it("states capacity in the row's own numbers, never a house figure", () => {
    const html = renderToString(
      <ReferencePickerBody
        mode="bench"
        worldSlug="the-undersong"
        model={IMAGE_MODEL}
        carried={[{ kind: "image", durationSec: 0 }]}
        world={[]}
        session={[]}
        onUpload={() => {}}
        onClose={() => {}}
      />,
    );
    assert.match(html, /1 of 2 images/);
  });
});

describe("the Keyframe tab (issue 305 §3)", () => {
  const FRAME_VIDEO: ManifestModel = {
    id: "test-frame-video",
    provider: "fal",
    capability: "video",
    displayName: "Frame Video",
    accepts: { referenceImages: 0, referenceRoles: false, startFrame: false, endFrame: false },
    limits: { maxDurationSec: 10 },
    pricing: { kind: "perSecond", microUsdPerSecond: 100000 },
    modes: {
      generate: { locked: [] },
      "first-frame": { route: "t/image-to-video", locked: ["aspect"] },
      "first-and-last-frame": { route: "t/image-to-video", locked: ["aspect"] },
    },
  };
  const PLAIN_VIDEO: ManifestModel = {
    ...FRAME_VIDEO,
    id: "test-plain-video",
    displayName: "Plain Video",
    modes: { generate: { locked: [] } },
  };

  function videoState(model: ManifestModel): ClientState {
    const base = stateWithBench();
    const session = base.bench!.session;
    return {
      ...base,
      app: { ...base.app, manifest: { ...base.app.manifest!, models: [...base.app.manifest!.models, model] } },
      bench: {
        worldId: FIXTURE_WORLD_ID,
        session: {
          ...session,
          composer: {
            ...session.composer,
            mode: "video",
            provider: model.provider,
            model: model.id,
            params: { kind: "video" },
          },
        },
      },
    };
  }

  it("the tab exists exactly where the model verifies a frame task mode", () => {
    const withTabs = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, videoState(FRAME_VIDEO));
    assert.match(withTabs, /Keyframe/);
    assert.doesNotMatch(withTabs, /takes no keyframes/);
  });

  it("a model with no frame mode shows no tab, and the composer says so in a line", () => {
    const without = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, videoState(PLAIN_VIDEO));
    assert.doesNotMatch(without, /Keyframe/);
    assert.match(without, /Plain Video takes no keyframes\./);
  });
});

describe("recipes (issue 305 §3)", () => {
  it("the dispatch row carries the Recipes trigger", () => {
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, stateWithBench());
    assert.match(html, /data-testid="bench-recipes"/);
    assert.match(html, /Recipes/);
  });
});

describe("a lingering keyframe stays visible (issue 305 §3)", () => {
  it("the tab renders for riding frames even when the model verifies no frame mode", () => {
    const PLAIN: ManifestModel = {
      id: "test-plain-video2",
      provider: "fal",
      capability: "video",
      displayName: "Plain Video 2",
      accepts: { referenceImages: 0, referenceRoles: false, startFrame: false, endFrame: false },
      limits: { maxDurationSec: 10 },
      pricing: { kind: "perSecond", microUsdPerSecond: 100000 },
      modes: { generate: { locked: [] } },
    };
    const base = stateWithBench();
    const session = base.bench!.session;
    const state: ClientState = {
      ...base,
      app: { ...base.app, manifest: { ...base.app.manifest!, models: [...base.app.manifest!.models, PLAIN] } },
      bench: {
        worldId: FIXTURE_WORLD_ID,
        session: {
          ...session,
          composer: {
            ...session.composer,
            mode: "video",
            provider: PLAIN.provider,
            model: PLAIN.id,
            params: { kind: "video" },
            keyframeTokens: ["Image 1"],
          },
        },
      },
    };
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, state);
    // What is attached stays visible and removable — no hidden state, no dead end.
    assert.match(html, /Keyframe/);
    assert.doesNotMatch(html, /takes no keyframes/);
  });
});

describe("the video length and its sound (asked for 2026-08-16)", () => {
  const LONG: ManifestModel = {
    id: "test-long-video",
    provider: "fal",
    capability: "video",
    displayName: "Long Video",
    accepts: { referenceImages: 0, referenceRoles: false, startFrame: false, endFrame: false },
    limits: { maxDurationSec: 8, durations: { 4: "4s", 6: "6s", 8: "8s" }, soundChoice: true, durationAuto: true },
    pricing: { kind: "perSecond", microUsdPerSecond: 100000 },
    modes: { generate: { locked: [] } },
  };
  /** The same row without the two declarations, to prove each control is earned, not decorative. */
  const BARE: ManifestModel = {
    ...LONG,
    id: "test-bare-video",
    displayName: "Bare Video",
    limits: { maxDurationSec: 8, durations: { 4: "4s", 6: "6s", 8: "8s" } },
  };

  function lengthState(model: ManifestModel, params: Record<string, unknown>): ClientState {
    const base = stateWithBench();
    const session = base.bench!.session;
    return {
      ...base,
      app: { ...base.app, manifest: { ...base.app.manifest!, models: [...base.app.manifest!.models, model] } },
      bench: {
        worldId: FIXTURE_WORLD_ID,
        session: {
          ...session,
          composer: {
            ...session.composer,
            mode: "video",
            provider: model.provider,
            model: model.id,
            params: { kind: "video", ...params },
          },
        },
      },
    };
  }

  const render = (model: ManifestModel, params: Record<string, unknown> = {}) =>
    renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, lengthState(model, params));

  it("offers each control only where the route publishes the choice", () => {
    const offered = render(LONG);
    assert.match(offered, /data-testid="bench-sound"/);
    assert.match(offered, /data-testid="duration-auto"/);
    // A switch over a route that publishes no such field would change nothing, and a control
    // that changes nothing is a control that lies.
    const bare = render(BARE);
    assert.doesNotMatch(bare, /data-testid="bench-sound"/);
    assert.doesNotMatch(bare, /data-testid="duration-auto"/);
    // The track itself is not conditional on either: every row with lengths gets one.
    assert.match(bare, /data-testid="duration-range"/);
  });

  it("under Auto the track states no length, because none has been chosen", () => {
    const auto = render(LONG);
    // No competing value pill beside the lit Auto, and no fill: a handle parked on the shortest
    // stop over a filled track would claim 4 seconds when nobody has said 4 seconds.
    assert.doesNotMatch(auto, /data-testid="duration-value"/);
    assert.match(auto, /--fy-duration-fill:\s*0%/);
    assert.match(auto, /fy-bench__durationrange--auto/);
  });

  it("a chosen length fills the track to its own place in the model's range", () => {
    // The track runs from one position below the shortest stop — that position is "unsaid" —
    // so [4, 6, 8] occupies four positions and 6s sits two of three along.
    const middle = render(LONG, { durationSec: 6 });
    assert.match(middle, /data-testid="duration-value"/);
    assert.match(middle, /6 s/);
    assert.match(middle, /--fy-duration-fill:\s*66\.6/);
    assert.doesNotMatch(middle, /fy-bench__durationrange--auto/);
    assert.match(render(LONG, { durationSec: 8 }), /--fy-duration-fill:\s*100%/);
    assert.match(render(LONG, { durationSec: 4 }), /--fy-duration-fill:\s*33\.3/);
  });

  /**
   * A range input fires no change when the click lands on the value it already holds. With the
   * handle parked on the first stop, the shortest length — the cheapest one — could not be
   * picked at all. The track carries a position below the shortest stop so every real stop is
   * one the handle can move *to*, and that position is where "unsaid" honestly lives.
   */
  it("keeps a position below the shortest stop, so the shortest stop can be reached", () => {
    const unset = render(LONG);
    assert.match(unset, /min="-1"/);
    assert.match(unset, /value="-1"/);
    assert.match(unset, /--fy-duration-fill:\s*0%/);
    // And a chosen shortest length is a real position on the track, not the same one.
    assert.match(render(LONG, { durationSec: 4 }), /value="0"/);
  });

  it("says 'default' where no length was chosen and the model offers no Auto", () => {
    // BARE declares lengths but no `auto`. Printing its shortest stop would name a length
    // nobody asked for, while the wire carries no duration at all.
    const bare = render(BARE);
    assert.match(bare, /data-testid="duration-value"/);
    assert.match(bare, />default</);
    assert.doesNotMatch(bare, /4 s/);
  });

  it("says in words which way the sound sits, rather than leaving an icon to be read", () => {
    assert.match(render(LONG), />sound</);
    assert.match(render(LONG, { sound: false }), />silent</);
  });

  /**
   * Wan makes 15 seconds from text and 10 from references — two routes, two ceilings. The track
   * has to follow the route the job will land on, or the user picks 12s, accepts an estimate for
   * 12s, and learns at dispatch that the endpoint never offered it.
   */
  describe("when a reference shortens the range", () => {
    const SHORTER: ManifestModel = {
      ...LONG,
      id: "test-shorter-with-refs",
      displayName: "Shorter With Refs",
      accepts: { referenceImages: 4, referenceRoles: false, startFrame: false, endFrame: false },
      limits: { ...LONG.limits, maxReferenceDurationSec: 6 },
    };

    /** The fixture already registers Image 1; this only makes sure the lane is carrying it. */
    function withReference(model: ManifestModel, params: Record<string, unknown>): ClientState {
      const state = lengthState(model, params);
      const session = state.bench!.session;
      return {
        ...state,
        bench: {
          worldId: FIXTURE_WORLD_ID,
          session: { ...session, composer: { ...session.composer, activeTokens: ["Image 1"] } },
        },
      };
    }

    const renderWith = (params: Record<string, unknown> = {}) =>
      renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, withReference(SHORTER, params));

    /** The same model with the lane emptied — the fixture ships a reference, so this is explicit. */
    const renderWithout = (params: Record<string, unknown> = {}) => {
      const state = lengthState(SHORTER, params);
      const session = state.bench!.session;
      return renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, {
        ...state,
        bench: {
          worldId: FIXTURE_WORLD_ID,
          session: { ...session, composer: { ...session.composer, activeTokens: [] } },
        },
      });
    };

    it("ends the track at the reference route's ceiling, with the rest struck rather than hidden", () => {
      const html = renderWith({ durationSec: 6 });
      assert.match(html, /data-testid="duration-lost"/);
      // 6s is the end of the shortened track [4, 6], and 8s is what the reference cost.
      assert.match(html, /--fy-duration-fill:\s*100%/);
      assert.match(html, />8s</);
      // Without the reference the same model runs the full range and strikes nothing.
      const free = renderWithout({ durationSec: 6 });
      assert.doesNotMatch(free, /data-testid="duration-lost"/);
      // 6s of [4, 6, 8] no longer sits at the end — the track really did change shape.
      assert.match(free, /--fy-duration-fill:\s*66\.6/);
    });

    it("keeps a length chosen before the reference, and marks it out of reach", () => {
      // Nothing is rewritten behind the user: 8s was asked for, 8s is still what it says, and
      // the mark is what tells them Generate will refuse.
      const html = renderWith({ durationSec: 8 });
      assert.match(html, /8 s/);
      assert.match(html, /fy-bench__durationpill--over/);
    });
  });
});

describe("the enhancer (asked for 2026-08-16)", () => {
  it("the sparkle exists exactly where a model and words both do", () => {
    const withWords = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, stateWithBench());
    assert.match(withWords, /data-testid="bench-enhance"/);

    const state = stateWithBench();
    const wordless = {
      ...state,
      bench: {
        worldId: FIXTURE_WORLD_ID,
        session: { ...state.bench!.session, composer: { ...state.bench!.session.composer, brief: "" } },
      },
    };
    const without = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, wordless);
    assert.doesNotMatch(without, /data-testid="bench-enhance"/);
  });
});
