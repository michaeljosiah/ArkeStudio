import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { parseHTML } from "linkedom";
import { StartupScreen } from "../src/screens/launch.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const localAi = { ready: true, engines: {
  comfyui: { installed: true, healthy: true, detail: null },
  ollama: { installed: true, healthy: true, detail: null },
} };

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
let where = "";
function Where() { where = useLocation().pathname; return null; }
afterEach(() => __setStateForTest(FIXTURE_STATE));

async function mount() {
  const element = document.createElement("div"); document.body.append(element);
  const root = createRoot(element);
  await act(async () => {
    root.render(<MemoryRouter><StartupScreen /><Where /></MemoryRouter>);
    await flush();
  });
  return { element, unmount: async () => { await act(async () => root.unmount()); element.remove(); } };
}

it("accepts Continue before the snapshot, holds the press, then enters the ready studio", async () => {
  __setStateForTest(FIXTURE_STATE, { connection: "connecting", state: null });
  const { element, unmount } = await mount();
  try {
    const button = element.querySelector<HTMLButtonElement>(".fy-launch__action")!;
    assert.equal(button.disabled, false);
    await act(async () => { button.click(); await flush(); });
    assert.equal(where, "/starting");
    assert.ok(element.textContent?.includes("Connecting"));
    await act(async () => { __setStateForTest(FIXTURE_STATE); await flush(); });
    assert.equal(where, "/worlds");
  } finally { await unmount(); }
});

for (const componentState of ["queued", "downloading", "paused", "installing"] as const) {
  it("keeps " + componentState + " setup on the surface until settled", async () => {
    const state = structuredClone(FIXTURE_STATE);
    state.app.setup = { localAi, running: false, diskFreeMb: 100000, diskCheckedAt: null, components: [{
      id: "voxa-kokoro", displayName: "Voxa", state: componentState, purpose: "Voice", sizeMb: 88,
      installLocation: "models", bytesDone: 20, bytesTotal: 100, bytesPerSecond: null, pauseSupported: true,
    }] };
    __setStateForTest(state);
    const { element, unmount } = await mount();
    try {
      assert.ok(!element.textContent?.includes("Setting up your studio"), "setup waits for Continue");
      await act(async () => { element.querySelector<HTMLButtonElement>(".fy-launch__action")!.click(); await flush(); });
      assert.equal(where, "/starting");
      assert.ok(element.textContent?.includes("Setting up your studio"));
      assert.equal(element.querySelector<HTMLButtonElement>(".fy-launch__once button")!.disabled, false);
      await act(async () => { __setStateForTest(FIXTURE_STATE); await flush(); });
      assert.equal(where, "/worlds");
    } finally { await unmount(); }
  });
}

it("skips the setup panel when its running flag has no fetching components", async () => {
  const state = structuredClone(FIXTURE_STATE);
  state.app.setup = { localAi, running: true, diskFreeMb: 100000, diskCheckedAt: null, components: [] };
  __setStateForTest(state);
  const { element, unmount } = await mount();
  try {
    await act(async () => { element.querySelector<HTMLButtonElement>(".fy-launch__action")!.click(); await flush(); });
    assert.equal(where, "/worlds");
    assert.ok(!element.textContent?.includes("Setting up your studio"));
  } finally { await unmount(); }
});

for (const engine of ["comfyui", "ollama"] as const) {
  it("holds local setup with installed files until " + engine + " becomes healthy", async () => {
    const state = structuredClone(FIXTURE_STATE);
    const checks = structuredClone(localAi);
    checks.ready = false;
    checks.engines[engine] = { installed: true, healthy: false, detail: null };
    state.app.setup = { localAi: checks, running: false, diskFreeMb: 100000, diskCheckedAt: null, components: [] };
    __setStateForTest(state);
    const { element, unmount } = await mount();
    try {
      await act(async () => { element.querySelector<HTMLButtonElement>(".fy-launch__action")!.click(); await flush(); });
      assert.equal(where, "/starting");
      assert.ok(element.textContent?.includes("Setting up your studio"));
      assert.ok(!element.textContent?.includes("100%"));
      assert.equal(element.querySelector<HTMLButtonElement>(".fy-launch__once button")!.disabled, true);
      assert.ok(element.textContent?.includes("Runtime settings"));
      await act(async () => {
        state.app.setup!.localAi = localAi;
        __setStateForTest(state); await flush();
      });
      assert.equal(where, "/worlds");
    } finally { await unmount(); }
  });
}

it("fails closed while runtime checks are missing, even when no download is running", async () => {
  const state = structuredClone(FIXTURE_STATE);
  state.app.setup = { running: false, diskFreeMb: 100000, diskCheckedAt: null, components: [] };
  __setStateForTest(state);
  const { element, unmount } = await mount();
  try {
    await act(async () => { element.querySelector<HTMLButtonElement>(".fy-launch__action")!.click(); await flush(); });
    assert.equal(where, "/starting");
    assert.equal(element.querySelector<HTMLButtonElement>(".fy-launch__once button")!.disabled, true);
  } finally { await unmount(); }
});
