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
