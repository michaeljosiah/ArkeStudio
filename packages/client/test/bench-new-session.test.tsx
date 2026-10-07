import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import type { BenchSession, ClientMessage, ClientState, ManifestModel } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/*
 * A new world session from the Bench (2026-10-07): the screen leaves for the id-less address
 * before the fresh session exists. The one it left is still in the store until then, and taking
 * it for the answer wrote its id back into the address — so when the fresh one landed nothing
 * matched and the screen sat on "Opening the bench…" until the id was typed.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }) });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const OLD = "sess_01J8F3K2QW9VZX4N7M0RTYB6HD";
const FRESH = "sess_01J8F3K2QW9VZX4N7M0RTYB6HE";

const IMAGE_MODEL: ManifestModel = {
  id: "test-image",
  provider: "fal",
  capability: "image",
  displayName: "Test Image",
  accepts: { referenceImages: 2, referenceRoles: false, startFrame: false, endFrame: false },
  limits: { maxPromptChars: 500 },
  pricing: { kind: "perImage", microUsdPerImage: 60000 },
};

function worldSession(id: string, title: string, brief: string): BenchSession {
  return {
    schemaVersion: 1,
    id,
    title,
    composer: {
      mode: "image",
      provider: "fal",
      model: IMAGE_MODEL.id,
      params: { kind: "image", aspect: "16:9", count: 1 },
      brief,
      activeTokens: [],
      keyframeTokens: [],
    },
    tokenRegistry: [],
    subjectTokens: [],
    nextToken: {},
    nextTake: 1,
    takes: [],
    createdAt: "2026-10-07T20:00:00.000Z",
    updatedAt: "2026-10-07T20:00:00.000Z",
  } as unknown as BenchSession;
}

function stateWith(session: BenchSession): ClientState {
  const state = structuredClone(FIXTURE_STATE);
  state.app.manifest = { ...state.app.manifest!, models: [...state.app.manifest!.models.filter((row) => row.id !== IMAGE_MODEL.id), IMAGE_MODEL] };
  state.bench = { worldId: FIXTURE_WORLD_ID, session };
  return state;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  __setStateForTest(FIXTURE_STATE);
  __setBridgeForTest(null);
});

it("a new session waits on the id-less address for the fresh one, then names it", async () => {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({
    appVersion: "test",
    platform: "test",
    connect: () => {},
    subscribe: () => {},
    send: (json: string) => { sent.push(JSON.parse(json) as ClientMessage); },
  } as unknown as ArkeBridge);
  __setStateForTest(stateWith(worldSession(OLD, "The old one", "a lagoon at night")));
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${OLD}`]}>
        <App />
      </MemoryRouter>,
    );
  });
  assert.match(container.textContent ?? "", /The old one/);

  // The bin: a new session. The coordinator has not answered yet, so the store still holds the old one.
  const bin = container.querySelector('button.fy-bench__clear[title^="Clear the bench"]') as HTMLButtonElement | null;
  assert.ok(bin, "the world bench's bin is on screen");
  sent.length = 0;
  await act(async () => bin.click());
  assert.deepEqual(sent.map((message) => message.kind), ["bench-new-session"], "only the new session is asked for, not the old one again");
  assert.match(container.textContent ?? "", /Opening the bench…/, "the old session is not shown as the new one");

  // The fresh session lands: the screen shows it, and opens nothing else on the way.
  await act(async () => __setStateForTest(stateWith(worldSession(FRESH, "The fresh one", ""))));
  assert.match(container.textContent ?? "", /The fresh one/);
  assert.doesNotMatch(container.textContent ?? "", /Opening the bench…/);
  const opened = sent.filter((message): message is Extract<ClientMessage, { kind: "bench-open" }> => message.kind === "bench-open");
  assert.deepEqual(opened.map((message) => message.sessionId), [FRESH], "the address now names the fresh session");
});
