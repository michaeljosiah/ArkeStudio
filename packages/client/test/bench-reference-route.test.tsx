import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { BenchSession, BenchTake, ClientState, ManifestModel } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { BenchSentBox } from "../src/screens/bench.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { H3, plain, withSampling } from "./local-sampling-fixture.js";

/*
 * H3 Video's Reference lane on the bench (design turn 179): each riding picture says who it is,
 * a row without the route keeps the picture and holds Generate in one clause, and a reference
 * take's "What was sent" shows the record the take kept.
 */

const SESSION_ID = "sess_01J8F3K2QW9VZX4N7M0RTYB6HD";
const TAKE_ID = "tk_01J8F3K2QW9VZX4N7M0RTYB6HE";
const HASH = "sha256:3f9c00000000000000000000000000000000000000000000000000000000a41e";
const BRIEF = "The woman is @Image 1. Dimly lit luxurious bedroom at night, a couple, slow camera move.";

const ROUTED: ManifestModel = {
  ...H3,
  limits: { ...H3.limits, durations: { "10": "10", "15": "15" } },
  modes: { generate: { locked: [] }, "first-frame": { locked: [] } },
  referenceRoute: { maxImages: 1, referenceSyntax: "minimax-h3" },
};
const H3_768: ManifestModel = {
  ...ROUTED,
  id: "comfyui-h3-video-768",
  displayName: "Local · H3 Video 768p",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { ...ROUTED.limits, durations: { "5": "5", "7": "7" }, resolutions: ["768p"] },
  modes: undefined,
  referenceRoute: undefined,
};

const PROMPT = "<Subject 1> is the woman, shown in <Picture 1>.\n" +
  "The woman is <Picture 1>. Dimly lit luxurious bedroom at night, a couple, slow camera move.";

function take(): BenchTake {
  return {
    id: TAKE_ID as BenchTake["id"],
    n: 23,
    requestId: "r23",
    status: "succeeded",
    request: {
      mode: "video",
      brief: BRIEF,
      references: [{ token: "Image 1", kind: "image", source: { source: "artifact", artifactId: "ar_01J8F3K2QW9VZX4N7M0RTYB6HF", hash: HASH } }],
      keyframes: [],
      provider: "comfyui",
      model: ROUTED.id,
      params: { kind: "video", durationSec: 15, aspect: "16:9", resolution: "480p", who: { "Image 1": "the woman" } },
      requestedSeed: 186690333,
      sampling: { preset: "fast", steps: 8, speedAdapter: 1, shift: 12, sampler: "euler", scheduler: "simple" },
      referenceRoute: { route: "reference", prompt: PROMPT, pictures: [{ token: "Image 1", file: "dancer.png", hash: HASH, who: "the woman" }] },
    },
    media: { file: "take.mp4", hash: "sha256:beefbeef" },
    cost: { estimatedMicroUsd: 0, actualMicroUsd: 0 },
    disposition: "open",
    createdAt: "2026-10-01T10:00:00.000Z",
    completedAt: "2026-10-01T10:19:00.000Z",
  } as BenchTake;
}

function session(model: ManifestModel, who: Record<string, string> | null): BenchSession {
  return {
    schemaVersion: 1,
    id: SESSION_ID,
    title: "Reference takes",
    composer: {
      mode: "video",
      provider: "comfyui",
      model: model.id,
      params: { kind: "video", durationSec: model === H3_768 ? 7 : 15, aspect: "16:9", resolution: model === H3_768 ? "768p" : "480p", ...(who !== null ? { who } : {}) },
      brief: BRIEF,
      activeTokens: ["Image 1"],
      keyframeTokens: [],
    },
    tokenRegistry: [{ token: "Image 1", kind: "image", source: { source: "artifact", artifactId: "ar_01J8F3K2QW9VZX4N7M0RTYB6HF", hash: HASH } }],
    subjectTokens: [],
    nextToken: { image: 2 },
    nextTake: 24,
    selectedTakeId: TAKE_ID,
    takes: [take()],
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:19:00.000Z",
  } as BenchSession;
}

function state(model: ManifestModel, who: Record<string, string> | null = { "Image 1": "the woman" }): ClientState {
  const base = withSampling();
  return {
    ...base,
    app: {
      ...base.app,
      manifest: { ...base.app.manifest!, models: [...base.app.manifest!.models.filter((row) => row.id !== H3.id), ROUTED, H3_768] },
      comfyui: {
        ...base.app.comfyui!,
        recipes: [ROUTED, H3_768].map((row) => ({ recipeId: row.id, recipeVersion: 1, displayName: row.displayName, capability: "video" as const, state: "ready" as const })),
      },
    },
    bench: { worldId: FIXTURE_WORLD_ID, session: session(model, who) },
  };
}

function render(value: ClientState): string {
  __setStateForTest(value);
  return plain(renderToString(
    <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`]}>
      <App />
    </MemoryRouter>,
  ));
}

describe("H3 Video's Reference lane (design turn 179)", () => {
  it("offers both lanes, and each riding picture carries an editable who", () => {
    const html = render(state(ROUTED));
    assert.match(html, /role="tablist" aria-label="What the pictures are for"/);
    assert.match(html, />Reference<\/button>/);
    assert.match(html, />Keyframe<\/button>/);
    assert.match(html, /<input[^>]*class="fy-bench__who"[^>]*aria-label="Who Image 1 is"[^>]*value="the woman"/);
    assert.doesNotMatch(html, /data-testid="bench-route-refusal"/);
    assert.doesNotMatch(/<button[^>]*data-testid="bench-generate"[^>]*>/.exec(html)?.[0] ?? "disabled", /disabled/);
  });

  it("an unnamed picture reads as the person until someone says otherwise", () => {
    const html = render(state(ROUTED, null));
    assert.match(html, /aria-label="Who Image 1 is"[^>]*placeholder="the person"[^>]*value="the person"|placeholder="the person"[^>]*value="the person"/);
  });

  it("768p keeps the picture, drops the who, and holds Generate in exactly one clause", () => {
    const html = render(state(H3_768));
    assert.match(html, /data-riding="true"/, "the picture is still in the tray");
    assert.doesNotMatch(html, /fy-bench__who/);
    assert.match(html, /<p role="alert" class="fy-bench__refusal" data-testid="bench-route-refusal">H3 Video 768p takes no reference pictures yet<\/p>/);
    const button = /<button[^>]*data-testid="bench-generate"[^>]*>/.exec(html)?.[0] ?? "";
    assert.match(button, /disabled/);
  });

  it("the brief's notices count what the route carries, not the row's one native picture", () => {
    // H3 Video binds one picture natively and carries nine by the route: a brief naming the second
    // picture was told it could not be carried while the engine received both (2026-10-07).
    const nine: ManifestModel = { ...ROUTED, referenceRoute: { maxImages: 9, referenceSyntax: "minimax-h3" } };
    const value = state(ROUTED);
    value.app.manifest = { ...value.app.manifest!, models: value.app.manifest!.models.map((row) => (row.id === ROUTED.id ? nine : row)) };
    value.bench!.session.composer.brief = "Ife is @Image 1. Ade is @Image 2. They sit in a parked car at night.";
    assert.doesNotMatch(render(value), /References beyond the budget cannot be carried/);
    // Past the route's own budget the notice still speaks, and names the route's number.
    value.bench!.session.composer.brief = "The tenth guest is @Image 10.";
    assert.match(render(value), /accepts 9 image references; the prompt names reference 10/);
  });

  it("the wall names the route by how many pictures rode", () => {
    const html = render(state(ROUTED));
    assert.match(html, /Local · H3 Video · 1 reference/);
  });

  it("What was sent is a disclosure on a reference take, closed until pressed", () => {
    const html = render(state(ROUTED));
    assert.match(html, /aria-label="What was sent"[^>]*aria-expanded="false"|aria-expanded="false"[^>]*aria-label="What was sent"/);
    assert.doesNotMatch(html, /data-testid="bench-sent"/);
  });
});

describe("what a reference take was sent (design 179b)", () => {
  it("draws the subject line, the brief as it went, the picture's file and hash, and the route", () => {
    // The box is the take's own record, drawn as the screen draws it once opened.
    const adapted = take();
    if (adapted.request.params.kind === "video") {
      adapted.request.params.adapters = [0.5, 0.4, 0.8].map((strength, i) => ({ releaseId: `fixture-${i}`, sha256: String(i).repeat(64), strength }));
    }
    const html = plain(renderToString(<BenchSentBox take={adapted} routeName="Local · H3 Video" bundleName="Motion + anatomy" sampling="Fast · 8 steps · seed 186690333" />));
    assert.match(html, /<h4>What was sent<\/h4>/);
    assert.match(html, /<p><code>&lt;Subject 1&gt;<\/code> is the woman, shown in <code>&lt;Picture 1&gt;<\/code>\.<\/p>/);
    assert.match(html, /<p class="fy-bench__sentdim">The woman is <code>&lt;Picture 1&gt;<\/code>\. Dimly lit/);
    assert.match(html, /Picture 1 · dancer\.png · sha256:3f9c…a41e/);
    assert.match(html, /H3 Video · reference · Motion \+ anatomy 0\.5 \/ 0\.4 \/ 0\.8 · Fast · 8 steps · seed 186690333 · 15 s/);
  });
});
