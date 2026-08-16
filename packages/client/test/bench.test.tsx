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
  /** A row whose reference route runs shorter than its text route, as wan's does. */
  const SHORTER: ManifestModel = {
    ...LONG,
    id: "test-shorter-with-refs",
    displayName: "Shorter With Refs",
    accepts: { referenceImages: 4, referenceRoles: false, startFrame: false, endFrame: false },
    limits: { ...LONG.limits, maxReferenceDurationSec: 6 },
  };

  function lengthState(model: ManifestModel, params: Record<string, unknown>, tokens?: string[]): ClientState {
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
            ...(tokens === undefined ? {} : { activeTokens: tokens }),
          },
        },
      },
    };
  }

  const render = (model: ManifestModel, params: Record<string, unknown> = {}, tokens?: string[]) =>
    renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, lengthState(model, params, tokens));

  it("offers each control only where the route publishes the choice", () => {
    const offered = render(LONG);
    assert.match(offered, /data-testid="bench-sound"/);
    // A switch over a route that publishes no such field would change nothing, and a control
    // that changes nothing is a control that lies.
    assert.doesNotMatch(render(BARE), /data-testid="bench-sound"/);
    // The length is not conditional on either: every row with lengths gets its pill.
    assert.match(offered, /data-testid="duration-open"/);
    assert.match(render(BARE), /data-testid="duration-open"/);
  });

  /**
   * The panel is a popover. Shut, none of the track is in the document, so the pill has to
   * carry the answer — otherwise the row goes quiet about what will be made. (The track's own
   * geometry is pinned in duration-track.test.ts, where it can be read directly.)
   */
  it("the closed pill says the length, or who is choosing it", () => {
    assert.match(render(LONG, { durationSec: 6 }), /data-testid="duration-open"[^>]*>[\s\S]{0,600}?6s</);
    assert.match(render(LONG), /data-testid="duration-open"[^>]*>[\s\S]{0,600}?Auto</);
    // BARE declares lengths but no `auto`: no duration goes on the wire, and printing the
    // shortest stop would name a length nobody asked for.
    assert.match(render(BARE), /data-testid="duration-open"[^>]*>[\s\S]{0,600}?default</);
  });

  it("marks a length the chosen route will not make, on the pill itself", () => {
    // Shut, the panel cannot warn: a refusal the user cannot see coming arrives as a surprise.
    const held = render(SHORTER, { durationSec: 8 }, ["Image 1"]);
    assert.match(held, /fy-bench__durationtrigger--over/);
    // The same length without the reference is perfectly reachable and unmarked.
    assert.doesNotMatch(render(SHORTER, { durationSec: 8 }, []), /fy-bench__durationtrigger--over/);
  });

  it("says in words which way the sound sits, rather than leaving an icon to be read", () => {
    assert.match(render(LONG), />sound</);
    assert.match(render(LONG, { sound: false }), />silent</);
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
