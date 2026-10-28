import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { parseHTML } from "linkedom";
import { NEW_ONBOARDING, type ClientMessage, type OnboardingPlan } from "@arke-studio/contracts";
import { OnboardingScreen } from "../src/screens/onboarding.js";
import { __setBridgeForTest, __setStateForTest, __handleFrameForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import type { ArkeBridge } from "../src/arke-bridge.js";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
let where = "", commands: ClientMessage[] = [];
function Where() { where = useLocation().pathname; return null; }
afterEach(() => { __setBridgeForTest(null); __setStateForTest(FIXTURE_STATE); commands = []; });

async function mount(plan: OnboardingPlan = NEW_ONBOARDING, delayed = false) {
  const state = structuredClone(FIXTURE_STATE);
  state.app.onboarding = { plan, workspace: { path: "C:/Test/Arke", ready: true, detail: null }, localModel: null };
  state.app.runtime = null; state.app.harness = { engine: "opencode", claudePath: null, codexPath: null, harnesses: [] };
  __setStateForTest(state, delayed ? { connection: "connecting", state: null } : {});
  __setBridgeForTest({ send: (raw: string) => commands.push(JSON.parse(raw) as ClientMessage) } as unknown as ArkeBridge);
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  await act(async () => { root.render(<MemoryRouter initialEntries={["/setup"]}><OnboardingScreen /><Where /></MemoryRouter>); await flush(); });
  return { element, state, unmount: async () => { await act(async () => root.unmount()); element.remove(); } };
}
async function click(element: Element, label: string) {
  const button = [...element.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes(label));
  assert.ok(button, label); assert.equal(button.disabled, false, `${label} should be enabled`);
  await act(async () => { button.click(); await flush(); });
}
async function acknowledge() {
  const command = commands.findLast(c => c.kind === "save-onboarding");
  assert.ok(command?.kind === "save-onboarding");
  await act(async () => { __handleFrameForTest({ kind: "event", seq: commands.length, event: { at: "2026-10-28T12:00:00Z", type: "onboarding.changed",
    onboarding: { plan: command.plan, workspace: { path: "C:/Test/Arke", ready: true, detail: null }, localModel: null } } }); await flush(); });
}

it("Lightweight enters Worlds with no installation command or account requirement", async () => {
  const { element, unmount } = await mount();
  try {
    await click(element, "Start lightweight"); await acknowledge();
    assert.match(element.textContent!, /Extra downloadsNone/);
    assert.doesNotMatch(element.textContent!, /Ollama|ComfyUI|Ming|Voxa/);
    await click(element, "Start using Arke"); await acknowledge();
    assert.equal(where, "/worlds");
    assert.equal(commands.some(c => c.kind === "save-onboarding" && c.action === "install"), false);
  } finally { await unmount(); }
});

it("unknown hardware offers online/manual writing and only the approved account shortlist", async () => {
  const { element, unmount } = await mount({ ...NEW_ONBOARDING, persona: "guided", step: "writing" });
  try {
    assert.doesNotMatch(element.textContent!, /Works offline after setup/);
    assert.match(element.textContent!, /Online writing is a better fit/);
    await click(element, "Use an online account"); await acknowledge();
    assert.match(element.textContent!, /Set up your AI writing agent/);
    assert.match(element.textContent!, /ChatGPT/); assert.match(element.textContent!, /GitHub Copilot/);
    const future = [...element.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes("Coming later"));
    assert.equal(future?.disabled, true);
    await click(element, "Set up writing later"); await acknowledge();
    await click(element, "Start using Arke"); await acknowledge(); assert.equal(where, "/worlds");
  } finally { await unmount(); }
});

it("a delayed earlier check cannot undo a newly submitted setup choice", async () => {
  const { element, state, unmount } = await mount();
  try {
    await click(element, "Start lightweight");
    await act(async () => { __setStateForTest(structuredClone(state)); await flush(); });
    assert.match(element.textContent!, /Start small/);
    assert.match(element.textContent!, /Saving your choices/);
    await acknowledge(); assert.doesNotMatch(element.textContent!, /Saving your choices/);
  } finally { await unmount(); }
});

it("restores the saved step when the opening snapshot arrives after the screen mounts", async () => {
  const { element, state, unmount } = await mount({ ...NEW_ONBOARDING, persona: "guided", writing: "account", account: "github-copilot", step: "account" }, true);
  try {
    await act(async () => { __setStateForTest(state); await flush(); });
    assert.match(element.textContent!, /Connect GitHub Copilot/);
    assert.doesNotMatch(element.textContent!, /Make Arke yours/);
  } finally { await unmount(); }
});

it("failed downloads and an unavailable AI model do not trap manual authoring", async () => {
  const { element, state, unmount } = await mount({ ...NEW_ONBOARDING, persona: "advanced", writing: "account", account: "openai", step: "progress" });
  try {
    state.app.health.harness = { status: "unavailable", reason: "offline" };
    await act(async () => { __setStateForTest(state); await flush(); });
    assert.match(element.textContent!, /Not ready/);
    await click(element, "Start using Arke"); await acknowledge(); assert.equal(where, "/worlds");
  } finally { await unmount(); }
});
