import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { OPENCODE_AVAILABILITY, type ClientMessage, type ClientState } from "@arke-studio/contracts";
import { AgentsPanel } from "../src/screens/agents.js";
import { SettingsHarnessScreen, SettingsLayout } from "../src/screens/shell.js";
import { ProductionConversation } from "../src/components/conversation.js";
import { __applyEventForTest, __clearWorldChatHoldsForTest, __setBridgeForTest, __setStateForTest, __stateForTest } from "../src/lib/store.js";
import { dialogRoot } from "./dialog-root.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
dom.HTMLElement.prototype.scrollIntoView = () => {};
// linkedom has no innerText; the composer reads and writes its editor through it.
Object.defineProperty(dom.HTMLElement.prototype, "innerText", {
  configurable: true,
  get() { return this.textContent; },
  set(value: string) { this.textContent = value; },
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const CLAUDE = "anthropic/sonnet";
const OPUS = "anthropic/opus[1m]";
const SPARK = "openai/gpt-5.3-codex-spark";
const CV = "cv_01J8F3K2QW9VZX4N7M0RTYB6HC";

function modelState(): ClientState {
  return {
    ...FIXTURE_STATE,
    app: {
      ...FIXTURE_STATE.app,
      manifest: { ...FIXTURE_STATE.app.manifest!, models: [...FIXTURE_STATE.app.manifest!.models] },
      health: { ...FIXTURE_STATE.app.health, harness: { status: "healthy" } },
      harnessModelStatus: { status: "ready" },
      harnessInfo: { generation: "claude", source: "path", version: "2.0.0", beta: false },
      harnessModels: [
        { id: "sonnet", provider: "anthropic", displayName: "Sonnet", aliases: ["claude-sonnet-5"] },
        { id: "opus[1m]", provider: "anthropic", displayName: "Opus", inputModalities: ["text", "image"] },
        { id: "gpt-5.3-codex-spark", provider: "openai", displayName: "Spark", inputModalities: ["text"] },
      ],
      agents: ["world-builder", "stage-designer"].map((name) => ({
        name, description: name === "world-builder" ? "Chat" : "Build a Stage", brief: "Shipped brief",
        shippedBrief: "Shipped brief", edited: false,
      })),
    },
    world: {
      ...FIXTURE_STATE.world!,
      productions: FIXTURE_STATE.world!.productions.map((production) => production.meta.id === "saltlight"
        ? { ...production, meta: { ...production.meta, models: { llm: CLAUDE } } }
        : production),
      conversations: [{
        id: CV, title: "Production conversation", status: "open", updatedAt: "2026-09-13T00:00:00Z",
        pointCount: 0, openProposalCount: 0, notCarried: [], entryContext: { kind: "production", productionId: "saltlight" },
      }],
    },
    // Loaded: a thread still loading takes nothing said into it.
    worldChat: workspaceAt(1),
  };
}

function workspaceAt(seq: number): NonNullable<ClientState["worldChat"]> {
  return {
    conversationId: CV as never, status: "open", initiative: "collaborate", hasMore: false, runStatus: null,
    runStartedAt: null, retrievalUnavailable: false, attachments: [], seq, actions: [], messages: [], points: [],
  };
}

let root: Root | undefined;
let container: HTMLDivElement;
let sent: ClientMessage[];
async function mount(state: ClientState, children: ReactNode, path = "/settings/harness", waitingForSnapshot: boolean | "closed" = false) {
  __setStateForTest(state, waitingForSnapshot ? { state: null, connection: waitingForSnapshot === "closed" ? "closed" : "connecting" } : {});
  sent = [];
  __setBridgeForTest({
    appVersion: "test", platform: "test", connect: () => {}, subscribe: () => {},
    send: (json) => sent.push(JSON.parse(json) as ClientMessage),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>));
}

afterEach(async () => {
  __clearWorldChatHoldsForTest();
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
  __setBridgeForTest(null);
  __setStateForTest(FIXTURE_STATE);
});

function select(label: string): HTMLSelectElement {
  const element = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  assert.ok(element, label);
  return element;
}

async function choose(label: string, value: string) {
  const element = select(label);
  await act(async () => {
    // linkedom exposes a getter-only select value; dispatch a real bubbling change after
    // supplying the browser's selected value, so the component and store both participate.
    Object.defineProperty(element, "value", { configurable: true, value });
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/**
 * The chat's model is a chip in the composer's row; its menu holds the models and the two presses
 * (design turn 190e). The menu is drawn on the body, out of the composer's clip, so it is looked
 * for there.
 */
function chip(): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>("button.fy-mchip__btn");
  assert.ok(element, "the model chip");
  return element;
}
async function openChip() {
  if (!dialogRoot(container).querySelector(".fy-mchip__menu")) await act(async () => chip().click());
}
function modelItems(): HTMLElement[] {
  return [...dialogRoot(container).querySelectorAll<HTMLElement>(".fy-mchip__menu [data-model]")];
}
/** A model this chat cannot pick is struck and `aria-disabled`; it stays on the page so its card can say why (design turn 195). */
const off = (item: Element) => item.getAttribute("aria-disabled") === "true";
function modelItem(id: string): HTMLElement {
  const item = modelItems().find((candidate) => candidate.getAttribute("data-model") === id);
  assert.ok(item, id);
  return item;
}
async function pickModel(id: string) {
  await openChip();
  const item = modelItem(id);
  await act(async () => item.click());
}
function menuPress(label: RegExp): HTMLElement | undefined {
  return [...dialogRoot(container).querySelectorAll<HTMLElement>(".fy-mchip__menu button, .fy-mchip__menu [role=option]:not([data-model])")].find((candidate) => label.test(candidate.textContent ?? ""));
}
async function chipPress(label: RegExp) {
  await openChip();
  const button = menuPress(label);
  assert.ok(button, String(label));
  assert.equal(off(button), false, `${label} is enabled`);
  await act(async () => button.click());
}
const isSet = () => chip().className.includes("fy-mchip__btn--set");

async function press(label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === label);
  assert.ok(button, label);
  assert.equal(button.disabled, false, `${label} is enabled`);
  await act(async () => button.click());
}

function conversation() {
  return <ProductionConversation
    worldId={FIXTURE_STATE.world!.meta.worldId}
    productionId="saltlight"
    placeholder="Say something"
    emptyLine="Nothing said yet"
    dock={{ title: "Arke", subject: "Production", prompts: ["Explain the scene"] }}
  />;
}

/** The same conversation as a page rather than a dock: Develop's production and episode chats. */
function pageConversation() {
  return <ProductionConversation
    worldId={FIXTURE_STATE.world!.meta.worldId}
    productionId="saltlight"
    placeholder="Say something"
    emptyLine="Nothing said yet"
    contextSummary="3 scenes"
    heading="What happens in this one?"
  />;
}

const props = (element: HTMLElement) => {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, Record<string, (event: never) => void>>)[key]!;
};
/** Says a line through the composer, as a person does: type it, then press send. */
async function say(text: string) {
  const editor = container.querySelector<HTMLElement>(".fy-cx__editor")!;
  editor.innerText = text;
  await act(async () => props(editor).onInput!({ currentTarget: editor } as never));
  await act(async () => container.querySelector<HTMLButtonElement>(".fy-cx__send")!.click());
}

describe("live harness model controls (#1123, #1124)", () => {
  it("opens Advanced from a valid agent link and focuses that model once discovery settles", async () => {
    const state = modelState();
    state.app.harnessModelStatus = { status: "loading" };
    const originalFocus = dom.HTMLElement.prototype.focus;
    const focused: HTMLElement[] = [];
    dom.HTMLElement.prototype.focus = function () { focused.push(this); };
    try {
      await mount(state, <SettingsHarnessScreen />, "/settings/harness?agent=stage-designer");
      const advanced = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Advanced ·"))!;
      assert.equal(advanced.getAttribute("aria-expanded"), "true");
      assert.ok(select("Model for stage-designer"));
      assert.equal(focused.length, 0, "wait for the available choices before moving focus");
      await act(async () => __setStateForTest({ ...state, app: { ...state.app, harnessModelStatus: { status: "ready" } } }));
      assert.equal(focused.at(-1)?.getAttribute("aria-label"), "Model for stage-designer");
      const count = focused.length;
      await act(async () => __setStateForTest({ ...state, app: { ...state.app, harnessModelStatus: { status: "ready" }, version: "another snapshot" } }));
      assert.equal(focused.length, count, "later snapshots must not steal focus from an edit");
    } finally { dom.HTMLElement.prototype.focus = originalFocus; }
  });

  it("keeps Advanced collapsed for an unknown agent link", async () => {
    await mount(modelState(), <SettingsHarnessScreen />, "/settings/harness?agent=unknown-agent");
    const advanced = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Advanced ·"))!;
    assert.equal(advanced.getAttribute("aria-expanded"), "false");
  });

  it("discovers engines when a cold file page receives its first connected snapshot", async () => {
    const state = modelState();
    await mount(state, <SettingsHarnessScreen />, "/settings/harness", true);
    assert.equal(sent.some(message => message.kind === "detect-harnesses"), false);
    await act(async () => __setStateForTest(state, { state: null, connection: "open" }));
    assert.equal(sent.some(message => message.kind === "detect-harnesses"), false, "an open socket still needs the authenticated snapshot");
    await act(async () => __setStateForTest(state));
    assert.equal(sent.filter(message => message.kind === "detect-harnesses").length, 1);
    await act(async () => __setStateForTest({ ...state, app: { ...state.app, version: "another snapshot" } }));
    assert.equal(sent.filter(message => message.kind === "detect-harnesses").length, 1, "ordinary snapshots must not start repeated subprocess discovery");
    await press("Check again");
    assert.equal(sent.filter(message => message.kind === "detect-harnesses").length, 2, "unfinished discovery has an explicit retry");
    await act(async () => __setStateForTest(state, { connection: "connecting" }));
    await act(async () => __setStateForTest(state));
    assert.equal(sent.filter(message => message.kind === "detect-harnesses").length, 3, "a request lost during reconnect can recover");
    await act(async () => __setStateForTest({ ...state, app: { ...state.app, harness: {
      engine: "claude", claudePath: null, codexPath: null, launchOverride: null,
      harnesses: [OPENCODE_AVAILABILITY, { ...OPENCODE_AVAILABILITY, id: "codex", label: "Codex", bundled: false }],
    } } }));
    assert.match(container.textContent!, /Codex/);
    assert.equal(sent.filter(message => message.kind === "detect-harnesses").length, 3);
    await act(async () => __setStateForTest({ ...state, app: { ...state.app, harness: {
      engine: "opencode", claudePath: null, codexPath: null, launchOverride: null, harnesses: [OPENCODE_AVAILABILITY],
    } } }));
    await press("Check again");
    assert.equal(sent.filter(message => message.kind === "detect-harnesses").length, 4, "an empty external discovery result must remain retryable from OpenCode");
  });

  it("discovers Claude models and persists different choices for chat and Stage", async () => {
    await mount(modelState(), <AgentsPanel />);
    assert.ok(sent.some((message) => message.kind === "list-harness-models"));
    assert.match(container.textContent!, /models from Claude Code/);
    await choose("Model for world-builder", CLAUDE);
    await choose("Model for stage-designer", OPUS);
    assert.deepEqual(sent.filter((message) => message.kind === "set-agent-config"), [
      { kind: "set-agent-config", agent: "world-builder", model: CLAUDE },
      { kind: "set-agent-config", agent: "stage-designer", model: OPUS },
    ]);
  });

  it("allows text-only chat, disables it for Stage and labels unknown image support", async () => {
    await mount(modelState(), <AgentsPanel />);
    const chat = [...select("Model for world-builder").options].find((option) => option.value === SPARK)!;
    const stage = [...select("Model for stage-designer").options].find((option) => option.value === SPARK)!;
    assert.equal(chat.hasAttribute("disabled"), false);
    assert.equal(stage.hasAttribute("disabled"), true);
    assert.match(stage.textContent!, /Stage needs images/);
    const unknown = [...select("Model for stage-designer").options].find((option) => option.value === CLAUDE)!;
    assert.equal(unknown.hasAttribute("disabled"), false);
    assert.match(unknown.textContent!, /image support unreported/);
  });

  it("retains a vanished agent choice and can clear it during a discovery error", async () => {
    const state = modelState();
    state.app.agents[1]!.model = "anthropic/retired";
    state.app.harnessModels = [];
    state.app.harnessModelStatus = { status: "error", reason: "Claude login expired. Sign in and retry." };
    await mount(state, <AgentsPanel />);
    assert.match(container.textContent!, /anthropic\/retired · unavailable/);
    assert.match(container.textContent!, /Claude login expired/);
    assert.equal(select("Model for stage-designer").hasAttribute("disabled"), false);
    await choose("Model for stage-designer", "");
    assert.ok(sent.some((message) => message.kind === "set-agent-config" && message.agent === "stage-designer" && message.model === null));
    await press("Retry models");
    assert.equal(sent.filter((message) => message.kind === "list-harness-models").length, 2);
  });

  it("disables models without reported text support in every writing picker and blocks a saved production choice", async () => {
    const state = modelState();
    state.app.harnessModels.push(
      { id: "image-only", provider: "custom", displayName: "Image only", inputModalities: ["image"] },
      { id: "no-inputs", provider: "custom", displayName: "No inputs", inputModalities: [] },
    );
    state.world!.productions.find(production => production.meta.id === "saltlight")!.meta.models = { llm: "custom/image-only" };
    await mount(state, <><AgentsPanel />{conversation()}</>);
    for (const label of ["Model for world-builder", "Model for stage-designer"]) {
      const options = [...select(label).options];
      for (const value of ["custom/image-only", "custom/no-inputs"]) {
        const option = options.find(option => option.value === value)!;
        assert.equal(option.hasAttribute("disabled"), true, `${label}: ${value}`);
        assert.match(option.textContent!, /cannot read text/);
      }
    }
    await openChip();
    for (const value of ["custom/image-only", "custom/no-inputs"]) {
      const item = modelItem(value);
      assert.equal(off(item), true, `chip: ${value}`);
      assert.match(item.getAttribute("aria-label")!, /cannot read text/, "the reason is on the card and in the option's name");
      assert.doesNotMatch(item.textContent!, /cannot read text/, "the row itself no longer prints it");
    }
    const prompt = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Explain the scene")!;
    assert.equal(prompt.disabled, true, "a previously saved model without text input cannot dispatch");
    await chipPress(/Clear the production/);
    assert.ok(sent.some(message => message.kind === "set-production-model" && message.modelId === null));
  });

  it("uses the live production catalog even when no media manifest entry exists", async () => {
    await mount(modelState(), conversation());
    await openChip();
    const values = modelItems().map((item) => item.getAttribute("data-model"));
    assert.ok(values.includes(OPUS));
    assert.ok(values.includes(SPARK));
    assert.ok(!values.includes("seedance-2.0"));
    await pickModel(OPUS);
    assert.equal(isSet(), true, "this chat's own choice carries the dot");
    await chipPress(/Every chat in this production/);
    assert.ok(sent.some((message) => message.kind === "set-production-model" && message.modelId === OPUS && message.capability === "llm"));
  });

  it("resolves saved aliases without requiring a media API key, while respecting disabled models", async () => {
    const state = modelState();
    state.app.providers = [];
    state.app.manifest!.models.push({
      id: "legacy-sonnet", provider: "anthropic", providerModelId: "claude-sonnet-5", capability: "llm",
      displayName: "Legacy Sonnet", accepts: { referenceImages: 0, startFrame: false, endFrame: false },
      limits: {}, pricing: { kind: "unmetered" },
    });
    state.app.agents[0]!.model = "anthropic/claude-sonnet-5";
    await mount(state, <AgentsPanel />);
    const saved = [...select("Model for world-builder").options].find((option) => option.value === "anthropic/claude-sonnet-5")!;
    assert.match(saved.textContent!, /Sonnet · saved/);
    const available = [...select("Model for world-builder").options].find((option) => option.value === CLAUDE)!;
    assert.equal(available.hasAttribute("disabled"), false, "Claude's login does not require an Arke media key");
    await act(async () => __setStateForTest({ ...state, app: { ...state.app, models: { disabled: ["legacy-sonnet"] } } }));
    const disabled = [...select("Model for world-builder").options].find((option) => option.value === CLAUDE)!;
    assert.equal(disabled.hasAttribute("disabled"), true);
    assert.match(disabled.textContent!, /turned off/);
  });

  it("distinguishes loading from an empty catalog and keeps clearing available", async () => {
    const state = modelState();
    state.app.agents[0]!.model = CLAUDE;
    state.app.harnessModelStatus = { status: "loading" };
    await mount(state, <AgentsPanel />);
    assert.match(container.textContent!, /Loading models from Claude Code/);
    const options = [...select("Model for world-builder").options];
    assert.equal(options.find((option) => option.value === "")!.hasAttribute("disabled"), false);
    assert.equal(options.find((option) => option.value === OPUS)!.hasAttribute("disabled"), true);
    await act(async () => __setStateForTest({ ...state, app: { ...state.app, harnessModelStatus: { status: "ready" }, harnessModels: [] } }));
    assert.match(container.textContent!, /The harness returned no models/);
    assert.doesNotMatch(container.textContent!, /not running/);
    await choose("Model for world-builder", "");
    assert.ok(sent.some((message) => message.kind === "set-agent-config" && message.model === null));
  });

  it("sends only a turn override and preserves the remembered choice for later turns", async () => {
    await mount(modelState(), conversation());
    await press("Explain the scene");
    const inherited = sent.findLast((message) => message.kind === "world-chat-send");
    assert.ok(inherited && inherited.kind === "world-chat-send");
    assert.equal(inherited.modelId, undefined, "the coordinator resolves the inherited production choice");
    // Taken, and the thread shows it, before the next is said.
    await act(async () => __applyEventForTest({ at: "2026-09-13T00:00:01Z", type: "world-chat.send-result", conversationId: CV as never, requestId: inherited.requestId, admitted: true }));
    await act(async () => __setStateForTest({ ...modelState(), worldChat: workspaceAt(2) }));
    await pickModel(OPUS);
    await press("Explain the scene");
    const explicit = sent.findLast((message) => message.kind === "world-chat-send");
    assert.ok(explicit && explicit.kind === "world-chat-send");
    assert.equal(explicit.modelId, OPUS);
    assert.equal(isSet(), false, "the turn override is spent; the production's choice is back");
    assert.match(chip().textContent ?? "", /Sonnet/);
    assert.equal(sent.some((message) => message.kind === "set-production-model"), false);
  });

  it("a line held for a world that closes is not held when that world opens again (codex on PR 1232)", async () => {
    await mount(modelState(), conversation());
    await press("Explain the scene");
    assert.equal(Object.keys(__stateForTest().worldChatHolds).length, 1, "held until its answer comes");
    const elsewhere = modelState();
    elsewhere.world = { ...elsewhere.world!, meta: { ...elsewhere.world!.meta, worldId: "wld_elsewhere" as never } };
    await act(async () => __setStateForTest(elsewhere));
    await act(async () => __setStateForTest(modelState()));
    assert.deepEqual(__stateForTest().worldChatHolds, {}, "its answer belonged to the session that closed");
  });

  it("shows the chat agent override ahead of an unavailable production choice", async () => {
    const state = modelState();
    state.app.agents[0]!.model = OPUS;
    state.world!.productions.find((production) => production.meta.id === "saltlight")!.meta.models = { llm: "old/removed" };
    await mount(state, conversation());
    assert.match(chip().textContent ?? "", /Opus/, "the chat agent's model, ahead of the unavailable production choice");
    assert.doesNotMatch(container.textContent!, /old\/removed/);
    await press("Explain the scene");
    assert.ok(sent.some((message) => message.kind === "world-chat-send" && message.modelId === undefined));
  });

  it("can clear a saved production choice while catalog discovery has failed", async () => {
    const state = modelState();
    state.app.harnessModels = [];
    state.app.harnessModelStatus = { status: "error", reason: "The harness did not answer." };
    await mount(state, conversation());
    await openChip();
    assert.match(dialogRoot(container).querySelector(".fy-mchip__menu")!.textContent ?? "", /anthropic\/sonnet\s*unavailable/);
    await chipPress(/Clear the production/);
    assert.ok(sent.some((message) => message.kind === "set-production-model" && message.modelId === null));
    await press("Retry models");
  });

  it("disables retained catalog choices when the running harness stops", async () => {
    const state = modelState();
    await mount(state, conversation());
    await act(async () => __setStateForTest({ ...state, app: {
      ...state.app, harnessModelStatus: { status: "idle" },
      health: { ...state.app.health, harness: { status: "unavailable", reason: "The harness exited." } },
    } }));
    assert.match(container.textContent!, /The harness exited/);
    await openChip();
    assert.equal(off(modelItem(OPUS)), true);
    const prompt = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Explain the scene")!;
    assert.equal(prompt.disabled, true);
    await chipPress(/Clear the production/);
  });

  it("keeps retained idle models unverified until fresh catalog state arrives", async () => {
    const state = modelState();
    await mount(state, <><AgentsPanel />{conversation()}</>);
    await pickModel(OPUS);
    await act(async () => __setStateForTest({ ...state, app: { ...state.app, harnessModelStatus: { status: "idle" } } }));
    assert.match(container.textContent!, /Models need to be refreshed/);
    assert.doesNotMatch(container.textContent!, /3 models from Claude Code/);
    for (const label of ["Model for world-builder", "Model for stage-designer"]) {
      const options = [...select(label).options];
      assert.equal(options.find(option => option.value === OPUS)!.hasAttribute("disabled"), true, label);
      assert.equal(options.find(option => option.value === "")!.hasAttribute("disabled"), false, "clearing remains available");
    }
    await openChip();
    assert.equal(off(modelItem(OPUS)), true);
    assert.ok(menuPress(/Use the saved choice/), "clearing remains available");
    const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === label)!;
    assert.equal(button("Explain the scene").disabled, true);
    assert.equal(menuPress(/Every chat in this production/), undefined, "a choice that cannot be checked is not offered to the production");
    assert.equal(off(menuPress(/Clear the production/)!), false);
    const requests = sent.filter(message => message.kind === "list-harness-models").length;
    await press("Retry models");
    assert.equal(sent.filter(message => message.kind === "list-harness-models").length, requests + 1);
    await act(async () => __setStateForTest({ ...state, app: { ...state.app,
      harnessModelStatus: { status: "ready" }, harnessModels: [state.app.harnessModels[1]!],
    } }));
    await openChip();
    assert.equal(off(modelItem(OPUS)), false);
    assert.equal(button("Explain the scene").disabled, false);
    await chipPress(/Every chat in this production/);
    assert.ok(sent.some(message => message.kind === "set-production-model" && message.modelId === OPUS));
  });

  it("labels a pending engine separately and routes Codex executable controls to Codex", async () => {
    const state = modelState();
    state.app.harness = {
      engine: "codex", claudePath: "C:/tools/claude.exe", codexPath: "C:/tools/codex.exe", launchOverride: "claude",
      harnesses: [OPENCODE_AVAILABILITY,
        { ...OPENCODE_AVAILABILITY, id: "claude", label: "Claude Code", bundled: false },
        { ...OPENCODE_AVAILABILITY, id: "codex", label: "Codex", bundled: false }],
    };
    await mount(state, <SettingsHarnessScreen />);
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    assert.match(tabs.find((tab) => tab.textContent!.includes("Claude Code"))!.textContent!, /running now/);
    assert.match(tabs.find((tab) => tab.textContent!.includes("Codex"))!.textContent!, /next restart/);
    assert.match(container.textContent!, /Selected for the next restart/);
    assert.match(container.textContent!, /ARKE_HARNESS selects Claude Code at launch/);
    assert.match(container.textContent!, /C:\/tools\/codex.exe/);
    assert.doesNotMatch(container.textContent!, /C:\/tools\/claude.exe/);
    await press("Choose…");
    await press("Clear");
    assert.ok(sent.some((message) => message.kind === "choose-codex-executable"));
    assert.ok(sent.some((message) => message.kind === "clear-codex-executable"));
    await press("Advanced · which model runs each writing agent");
    assert.match(container.textContent!, /models from Claude Code/, "the pending selection must not relabel the running catalog");
  });



  it("shows a failed launch without metadata on its attempted engine after the saved choice changes", async () => {
    const state = modelState();
    state.app.harnessInfo = null;
    state.app.health.harness = { status: "unavailable", reason: "Claude Code could not start. Check its executable." };
    state.app.harness = {
      engine: "claude", launchEngine: "claude", claudePath: null, codexPath: null,
      harnesses: [OPENCODE_AVAILABILITY,
        { ...OPENCODE_AVAILABILITY, id: "claude", label: "Claude Code", bundled: false, installed: false, blocked: "Claude Code was not found." },
        { ...OPENCODE_AVAILABILITY, id: "codex", label: "Codex", bundled: false }],
    };
    await mount(state, <SettingsHarnessScreen />, "/settings/harness?harness=claude");
    const tab = (label: string) => [...container.querySelectorAll('[role="tab"]')].find(element => element.textContent!.includes(label))!;
    assert.match(tab("Claude Code").textContent!, /unavailable/);
    assert.match(container.textContent!, /Harness unavailable/);
    assert.match(container.textContent!, /Claude Code could not start/);
    assert.doesNotMatch(container.textContent!, /next restart/);
    await act(async () => __setStateForTest({ ...state, app: { ...state.app, harness: { ...state.app.harness!, engine: "codex" } } }));
    assert.match(tab("Claude Code").textContent!, /unavailable/);
    assert.match(tab("Codex").textContent!, /next restart/);
    assert.match(container.textContent!, /Claude Code could not start/, "the launch failure stays attached to Claude after selecting Codex");
    assert.match(container.textContent!, /Harness unavailable/);
  });

  it("attaches a failed environment-selected launch to that engine even with another saved preference", async () => {
    const state = modelState();
    state.app.harnessInfo = null;
    state.app.health.harness = { status: "unavailable", reason: "Codex could not initialize. Sign in and restart." };
    state.app.harness = {
      engine: "claude", launchEngine: "codex", launchOverride: "codex", claudePath: null, codexPath: null,
      harnesses: [OPENCODE_AVAILABILITY,
        { ...OPENCODE_AVAILABILITY, id: "claude", label: "Claude Code", bundled: false },
        { ...OPENCODE_AVAILABILITY, id: "codex", label: "Codex", bundled: false }],
    };
    await mount(state, <SettingsHarnessScreen />, "/settings/harness?harness=codex");
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    assert.match(tabs.find(tab => tab.textContent!.includes("Codex"))!.textContent!, /unavailable/);
    assert.match(tabs.find(tab => tab.textContent!.includes("Claude Code"))!.textContent!, /next restart/);
    assert.match(container.textContent!, /Codex could not initialize/);
    assert.match(container.textContent!, /ARKE_HARNESS selects Codex at launch/);
    assert.doesNotMatch(container.textContent!, /Selected for the next restart/);
  });
});

describe("round-64 harness regressions (#1154)", () => {
  it("shows a desktop startup state without inventing an engine before the snapshot", async () => {
    const previous = window.arke;
    window.arke = { appVersion: "0.5.49" } as typeof window.arke;
    try {
      await mount(modelState(), <SettingsHarnessScreen />, "/settings/harness", true);
      assert.match(container.textContent!, /Starting Arke Studio/);
      assert.doesNotMatch(container.textContent!, /dev:coordinator|OpenCode|next restart|0\.1\.0/);
    } finally { window.arke = previous; }
  });

  it("labels an installed but blocked engine as needing attention", async () => {
    const state = modelState();
    state.app.harness = { engine: "opencode", claudePath: null, codexPath: null, harnesses: [OPENCODE_AVAILABILITY,
      { ...OPENCODE_AVAILABILITY, id: "codex", label: "Codex", bundled: false, installed: false, version: "0.144.0", source: null, blocked: "Codex is installed, but a newer version is needed." }], };
    await mount(state, <SettingsHarnessScreen />, "/settings/harness?harness=codex");
    const tab = [...container.querySelectorAll('[role="tab"]')].find(element => element.textContent!.includes("Codex"))!;
    assert.match(tab.textContent!, /needs attention/);
    assert.doesNotMatch(tab.textContent!, /not here/);
    assert.match(container.textContent!, /newer version is needed/);
    const absent = structuredClone(state);
    absent.app.harness!.harnesses[1] = { ...absent.app.harness!.harnesses[1]!, version: null, source: null, blocked: "Codex was not found." };
    await act(async () => __setStateForTest(absent));
    assert.match(tab.textContent!, /not here/);
    assert.match(container.textContent!, /Not found on this machine/);

  });

  it("keeps a replacement for a legacy saved model visible until its save arrives", async () => {
    const state = modelState();
    state.world!.productions[0]!.meta.models = { llm: "claude-sonnet-5" };
    await mount(state, conversation());
    await pickModel(OPUS);
    await chipPress(/Every chat in this production/);
    assert.match(chip().textContent ?? "", /Opus/, "the replacement stays until its save arrives");
    assert.equal(isSet(), true);
    const saved = structuredClone(state);
    saved.world!.productions[0]!.meta.models = { llm: OPUS };
    await act(async () => __setStateForTest(saved));
    assert.match(chip().textContent ?? "", /Opus/);
    assert.equal(isSet(), false, "saved: the production's choice, no longer this chat's alone");
  });

  it("retains an explicit turn choice equal to the production default ahead of an agent override", async () => {
    const state = modelState();
    state.app.agents[0]!.model = OPUS;
    await mount(state, conversation());
    await pickModel(CLAUDE);
    assert.match(chip().textContent ?? "", /Sonnet/, "an explicit choice ahead of the agent's override");
    assert.equal(isSet(), false, "equal to the production's own, so no dot");
  });
});

/**
 * The page keeps what the dock keeps (design turn 190e): the model a chip in the composer's own
 * row, this chat's choice apart from the production's, and a word about the catalogue only while
 * there is trouble with it. The row above the composer, its scope words and its links went from
 * both.
 */
describe("the model chip on a conversation page (turn 190e)", () => {
  const OLD_ROW = /THIS TURN|CHAT AGENT|THIS PRODUCTION|DEFAULT|Ask the harness|Use saved choice|Remember for this production|Clear production default|models? from Claude Code/;

  it("is a chip in the composer's row, with no select, row or scope word above it", async () => {
    await mount(modelState(), pageConversation());
    assert.ok(container.querySelector(".fy-cx__bar button.fy-mchip__btn"), "in the tool row beside attach and voice");
    assert.equal(container.querySelector('select[aria-label="Language model"]'), null);
    assert.equal(container.querySelector(".fy-arke__model"), null);
    assert.doesNotMatch(container.textContent!, OLD_ROW);
    assert.match(chip().textContent ?? "", /Sonnet/, "the production's remembered choice");
    assert.equal(isSet(), false);
  });

  it("sends a pick as this turn's only, and lets the production keep its own", async () => {
    await mount(modelState(), pageConversation());
    await say("What changes in scene two?");
    const inherited = sent.findLast((message) => message.kind === "world-chat-send");
    assert.ok(inherited && inherited.kind === "world-chat-send");
    assert.equal(inherited.modelId, undefined, "the coordinator resolves the production's choice");
    await act(async () => __applyEventForTest({ at: "2026-09-13T00:00:01Z", type: "world-chat.send-result", conversationId: CV as never, requestId: inherited.requestId, admitted: true }));
    await act(async () => __setStateForTest({ ...modelState(), worldChat: workspaceAt(2) }));
    await pickModel(OPUS);
    assert.equal(isSet(), true, "a dot says the choice is this chat's alone");
    await say("And scene three?");
    const explicit = sent.findLast((message) => message.kind === "world-chat-send");
    assert.ok(explicit && explicit.kind === "world-chat-send");
    assert.equal(explicit.modelId, OPUS);
    assert.equal(isSet(), false, "spent; the production's choice is back");
    assert.match(chip().textContent ?? "", /Sonnet/);
    assert.equal(sent.some((message) => message.kind === "set-production-model"), false);
  });

  it("remembers a pick for every chat in the production, and lets the production's choice go", async () => {
    await mount(modelState(), pageConversation());
    assert.equal(menuPress(/Every chat in this production/), undefined);
    await pickModel(OPUS);
    await chipPress(/Every chat in this production/);
    assert.ok(sent.some((message) => message.kind === "set-production-model" && message.capability === "llm" && message.modelId === OPUS));
    await chipPress(/Clear the production/);
    assert.ok(sent.some((message) => message.kind === "set-production-model" && message.modelId === null));
    assert.equal(isSet(), false);
  });

  it("offers Every chat in this production with nothing chosen and nothing kept, keeping the model in force (195b, local.15)", async () => {
    const state = modelState();
    state.app.harnessModels = state.app.harnessModels.map((model) => (model.id === "opus[1m]" ? { ...model, isDefault: true } : model));
    state.world!.productions.find((production) => production.meta.id === "saltlight")!.meta.models = {};
    await mount(state, pageConversation());
    assert.equal(isSet(), false, "the harness's default is in force, chosen by nobody");
    await openChip();
    assert.deepEqual([...dialogRoot(container).querySelectorAll(".fy-mpick__foot button")].map((button) => button.textContent), ["Manage models", "Every chat in this production"], "Clear is offered only once the production keeps one");
    await chipPress(/Every chat in this production/);
    assert.ok(sent.some((message) => message.kind === "set-production-model" && message.capability === "llm" && message.modelId === OPUS), "the default becomes the production's choice");
  });

  describe("the effort (design turn 195)", () => {
    /** Opus offers three efforts, none of them the harness's default. */
    function effortState(production?: { llm: string; kept?: Record<string, string> }): ClientState {
      const state = modelState();
      state.app.harnessModels = state.app.harnessModels.map((model) => model.id === "opus[1m]" ? { ...model, variants: { names: ["low", "high", "max"] } } : model);
      if (production !== undefined) {
        state.world!.productions = state.world!.productions.map((entry) => entry.meta.id === "saltlight"
          ? { ...entry, meta: { ...entry.meta, models: { llm: production.llm }, ...(production.kept ? { llmVariants: production.kept } : {}) } }
          : entry);
      }
      return state;
    }
    const effortChip = () => [...container.querySelectorAll<HTMLButtonElement>(".fy-cx__bar button.fy-mchip__btn")].find((candidate) => candidate.getAttribute("aria-label") === "Effort");
    async function chooseEffort(label: string) {
      await act(async () => effortChip()!.click());
      const item = [...dialogRoot(container).querySelectorAll<HTMLButtonElement>(".fy-mchip__menu--effort button")].find((candidate) => candidate.textContent === label);
      assert.ok(item, label);
      await act(async () => item.click());
    }

    it("is drawn only for a model that offers one, and goes with the model it was chosen for", async () => {
      await mount(effortState(), pageConversation());
      assert.equal(effortChip(), undefined, "Sonnet declares none");
      await pickModel(OPUS);
      assert.equal(effortChip()?.textContent, "Effort", "nothing chosen and no default stated");
      await chooseEffort("High");
      assert.equal(effortChip()?.textContent, "High");
      assert.equal(isSet(), true, "an effort chosen here is this chat's own");
      await say("Explain the scene");
      const turn = sent.findLast((message) => message.kind === "world-chat-send");
      assert.ok(turn?.kind === "world-chat-send");
      assert.equal(turn.modelId, OPUS);
      assert.equal(turn.variant, "high", "the harness's own name, not the plain word");
      // Spent with the turn, as the model's own choice is.
      assert.equal(effortChip(), undefined);
      assert.equal(isSet(), false);
    });

    it("keeps an effort per model and shows it again when the model comes back", async () => {
      await mount(effortState(), pageConversation());
      await pickModel(OPUS);
      await chooseEffort("Highest");
      await pickModel(CLAUDE);
      assert.equal(effortChip(), undefined);
      await pickModel(OPUS);
      assert.equal(effortChip()?.textContent, "Highest", "max, in plain words");
    });

    it("is kept for every chat in the production with the model, in the same press", async () => {
      await mount(effortState(), pageConversation());
      await pickModel(OPUS);
      await chooseEffort("High");
      await chipPress(/Every chat in this production/);
      const kept = sent.findLast((message) => message.kind === "set-production-model");
      assert.ok(kept?.kind === "set-production-model");
      assert.equal(kept.modelId, OPUS);
      assert.equal(kept.variant, "high");
    });

    it("shows the production's kept effort, sends none of its own, and can change it alone", async () => {
      await mount(effortState({ llm: OPUS, kept: { [OPUS]: "max" } }), pageConversation());
      assert.equal(effortChip()?.textContent, "Highest");
      assert.equal(isSet(), false);
      await say("Explain the scene");
      const turn = sent.findLast((message) => message.kind === "world-chat-send");
      assert.ok(turn?.kind === "world-chat-send");
      assert.equal(turn.variant, undefined, "the coordinator resolves what the production kept");
      assert.equal(turn.modelId, undefined);
    });

    it("sends a different effort on the production's own model without naming the model", async () => {
      await mount(effortState({ llm: OPUS, kept: { [OPUS]: "max" } }), pageConversation());
      await chooseEffort("Low");
      assert.equal(isSet(), true, "a different effort on the production's own model is this chat's");
      await say("Explain the scene");
      const turn = sent.findLast((message) => message.kind === "world-chat-send");
      assert.ok(turn?.kind === "world-chat-send");
      assert.equal(turn.variant, "low");
      assert.equal(turn.modelId, undefined, "the model was not chosen here");
    });

    it("lets the production keep a different effort for its own model without choosing a model", async () => {
      await mount(effortState({ llm: OPUS, kept: { [OPUS]: "max" } }), pageConversation());
      await chooseEffort("Low");
      await chipPress(/Every chat in this production/);
      const kept = sent.findLast((message) => message.kind === "set-production-model");
      assert.ok(kept?.kind === "set-production-model");
      assert.equal(kept.modelId, OPUS);
      assert.equal(kept.variant, "low");
    });
  });

  it("shows a saved choice the harness no longer offers, disabled, and keeps it clearable", async () => {
    const state = modelState();
    state.app.harnessModels = [];
    state.app.harnessModelStatus = { status: "error", reason: "The harness did not answer." };
    await mount(state, pageConversation());
    await openChip();
    assert.match(dialogRoot(container).querySelector(".fy-mchip__menu")!.textContent ?? "", /anthropic\/sonnet\s*unavailable/);
    assert.equal(off(modelItem(CLAUDE)), true);
    assert.match(container.textContent!, /The harness did not answer/, "the catalogue's trouble is said, below the title and above the composer");
    await chipPress(/Clear the production/);
    assert.ok(sent.some((message) => message.kind === "set-production-model" && message.modelId === null));
  });

  it("says nothing of the catalogue while it is fine, and a word while it loads", async () => {
    const state = modelState();
    await mount(state, pageConversation());
    assert.doesNotMatch(container.textContent!, /models? from |Loading models/);
    await act(async () => __setStateForTest({ ...state, app: { ...state.app, harnessModelStatus: { status: "loading" } } }));
    assert.match(container.textContent!, /Loading models from Claude Code/);
  });
});

it("shows one startup warning and the bundled version on a closed desktop connection", async () => {
  const previous = window.arke;
  window.arke = { appVersion: "0.5.49" } as typeof window.arke;
  try {
    await mount(modelState(), <Routes><Route path="/settings" element={<SettingsLayout />}><Route path="harness" element={<SettingsHarnessScreen />} /></Route></Routes>, "/settings/harness", "closed");
    assert.equal(dialogRoot(container).textContent!.split("Starting Arke Studio").length - 1, 1);
    assert.equal(dialogRoot(container).querySelector(".fy-settings__version")?.textContent, "0.5.49", "bare, as the rail is drawn (issue 1216)");
  } finally { window.arke = previous; }
});
