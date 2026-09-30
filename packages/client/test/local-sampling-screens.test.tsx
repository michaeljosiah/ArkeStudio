import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { BenchSession, ClientState } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { H3, SAMPLING, plain, withSampling } from "./local-sampling-fixture.js";

/**
 * Sampling for a local recipe (design turn 177), as the screens render it: the AI models tile's
 * line, the dialog Generate's "Edit in Settings" opens, and a local take's "what was sent" line.
 */

function render(state: ClientState, path: string): string {
  __setStateForTest(state);
  return plain(renderToString(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>));
}

describe("the AI models tile (design 177a)", () => {
  it("names the sampling with a Change link, Fast until something else is chosen", () => {
    const tile = render(withSampling(), `/settings/models?model=${H3.id}`);
    assert.match(tile, /data-testid="sampling-line"><span>Sampling<\/span><strong>Fast<\/strong>.*?>Change<\/button>/);
    const chosen = render(withSampling({ choices: { [H3.id]: { preset: "quality" } }, timings: {} }), `/settings/models?model=${H3.id}`);
    assert.match(chosen, /<strong>Quality<\/strong>/);
  });

  it("opens the dialog when Generate's Edit in Settings lands on it", () => {
    const html = render(withSampling(), `/settings/models?model=${H3.id}&sampling=1`);
    assert.match(html, /H3 Video · Sampling/);
    assert.match(html, /10 s clip/);
  });
});

describe("what the take says was sent (design 177c)", () => {
  it("shows the preset, its values and the seed on a local take's line", () => {
    const TAKE = "tk_01J8F3K2QW9VZX4N7M0RTYB6HE";
    const SESSION = "sess_01J8F3K2QW9VZX4N7M0RTYB6HD";
    const quality = { preset: "quality" as const, ...SAMPLING.presets[2]!.values };
    const session: BenchSession = {
      schemaVersion: 1, id: SESSION, title: "Harbour",
      composer: { mode: "video", provider: "comfyui", model: H3.id, params: { kind: "video", durationSec: 5, aspect: "16:9", resolution: "480p" }, brief: "Gulls over the harbour.", activeTokens: [], keyframeTokens: [] },
      tokenRegistry: [], subjectTokens: [], nextToken: {}, nextTake: 2, selectedTakeId: TAKE,
      takes: [{
        id: TAKE, n: 1, requestId: "r1", status: "succeeded",
        request: { mode: "video", brief: "Gulls over the harbour.", references: [], keyframes: [], provider: "comfyui", model: H3.id,
          params: { kind: "video", durationSec: 5, aspect: "16:9", resolution: "480p" }, requestedSeed: 771942558, sampling: quality },
        disposition: "open", createdAt: "2026-09-30T10:00:00.000Z",
      }],
      createdAt: "2026-09-30T10:00:00.000Z", updatedAt: "2026-09-30T10:01:00.000Z",
    } as BenchSession;
    const html = render({ ...withSampling(), bench: { worldId: FIXTURE_WORLD_ID, session } }, `/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION}`);
    assert.match(html, /fy-bench__briefline">Local · H3 Video · Quality · 12 steps · speed 0\.5 · shift 6 · seed 771942558 · Gulls over the harbour\./);
    assert.match(html, /data-testid="sampling-chip"/);
  });
});
