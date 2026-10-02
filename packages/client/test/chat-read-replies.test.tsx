import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { parseHTML } from "linkedom";
import { ProductionSetupStateSchema, WorldChatWorkspaceSchema, type ClientMessage, type ClientState, type DomainEvent } from "@arke-studio/contracts";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { WorldChatScreen } from "../src/screens/world-chat.js";
import { ProductionSetupScreen } from "../src/screens/production-setup.js";
import { ProductionConversation } from "../src/components/conversation.js";
import { __applyEventForTest, __connectionStatusForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { dismissPlayback, setAudioFactoryForTest } from "../src/lib/audio.js";
import { resetReadRepliesForTest, setReadReplies } from "../src/lib/reply-reads.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { CHAT_ID, chatArtifactsFixture } from "./chat-artifacts-fixture.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Every chat reads Arke's replies (design turn 183). Listen is under every one of Arke's replies
 * — World Chat on a desktop and a phone, a production's dock, production setup — and never under
 * the author's own line. Read replies is offered only while the narrator reads unasked, reads a
 * reply that finishes while the chat is on screen, and switches itself off when the narrator
 * changes to one that would ask. One read plays at a time: starting another stops the first.
 */

let phone = false;
const stored = new Map<string, string>();
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, {
  innerWidth: 1280, innerHeight: 800,
  matchMedia: (query: string) => ({ matches: phone && query.includes("max-width") && !query.includes("min-width"), addEventListener() {}, removeEventListener() {} }),
  getComputedStyle: () => ({ direction: "ltr" }),
  localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) },
});
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {} });
// linkedom's innerText has no setter, and the composer writes its box through it.
Object.defineProperty(dom.HTMLElement.prototype, "innerText", {
  configurable: true,
  get(this: HTMLElement) { return this.textContent ?? ""; },
  set(this: HTMLElement, value: string) { this.textContent = value; },
});
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const sent: ClientMessage[] = [];
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  dom.document.body.replaceChildren();
  sent.length = 0;
  phone = false;
  stored.clear();
  resetReadRepliesForTest();
  dismissPlayback();
  setAudioFactoryForTest(null);
  __setBridgeForTest(null);
  __setStateForTest(FIXTURE_STATE);
});

const silentAudio = { playbackRate: 1, src: "", currentTime: 0, duration: NaN, play: async () => {}, pause() {}, load() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {} };

async function mount(state: ClientState, element: React.ReactNode, path: string) {
  setAudioFactoryForTest(() => silentAudio as never);
  __setStateForTest(state, { connection: "open" });
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() { return () => {}; }, send(raw: string) { sent.push(JSON.parse(raw)); } } as unknown as ArkeBridge);
  __connectionStatusForTest("open");
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => root!.render(<MemoryRouter initialEntries={[path]}>{element}</MemoryRouter>));
  return container as unknown as HTMLElement;
}

const worldChat = (state: ClientState) => mount(state, <Routes>
  <Route path="/w/:worldId/chat/:conversationId" element={<WorldChatScreen />} />
</Routes>, `/w/${state.world!.meta.worldId}/chat/${CHAT_ID}`);

const reads = () => sent.filter((message): message is Extract<ClientMessage, { kind: "read-prose" }> => message.kind === "read-prose");
const turns = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>(".fy-chat__turn")];
const listenIn = (turn: Element) => turn.querySelector<HTMLButtonElement>(".fy-replyacts__btn");
const readRepliesButton = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>(".fy-cx__tool")].find((button) => button.textContent === "Read replies") ?? null;
const click = async (node: HTMLElement | null) => { assert.ok(node); await act(async () => node.click()); };

/** The fixture with its narrator, and the manifest rows that price it. */
function withNarrator(state: ClientState, narrator: ClientState["app"]["narrator"], speechPlan?: "free-plan" | "free-credit"): ClientState {
  state.app.narrator = narrator;
  state.app.manifest = {
    ...state.app.manifest!,
    models: [
      ...state.app.manifest!.models,
      { id: "voxtral-mini-tts", provider: "mistral", capability: "voice-tts", displayName: "Voxtral", pricing: { kind: "perCharacter", microUsdPerCharacter: 16 }, ...(speechPlan ? { speechPlan } : {}) } as never,
    ],
  };
  return state;
}
const PAUL = { provider: "mistral", model: "voxtral-mini-tts", voiceId: "en_paul_neutral", label: "Paul" };

function landed(requestId: string, file = ".cache/voice/reply.wav"): DomainEvent {
  return {
    type: "voice.audio", at: "2026-10-02T12:00:00.000Z", requestId, worldId: FIXTURE_WORLD_ID, sheetVersion: 1, purpose: "prose",
    sectionHeading: "Arke", provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george", format: "wav", status: "ready",
    file, cached: false, characterCount: 40, estimatedMicroUsd: 0,
  } as DomainEvent;
}

describe("Listen on every chat's replies", () => {
  it("World Chat on a desktop: Listen under each of Arke's replies, never the author's, read by address", async () => {
    const state = chatArtifactsFixture();
    const container = await worldChat(state);
    const all = turns(container);
    const studio = all.filter((turn) => turn.classList.contains("fy-chat__turn--studio"));
    const user = all.filter((turn) => turn.classList.contains("fy-chat__turn--user"));
    assert.equal(studio.length, 2);
    for (const turn of studio) assert.equal(listenIn(turn)?.textContent, "Listen");
    for (const turn of user) assert.equal(turn.querySelector(".fy-replyacts"), null, "the author's own line is never offered");

    await click(listenIn(studio[0]!));
    assert.deepEqual(reads().map((read) => read.source), [{ of: "reply", conversationId: CHAT_ID, messageId: state.worldChat!.messages[1]!.id }]);
    assert.equal(listenIn(studio[0]!)?.textContent, "Listening");
    await act(async () => __applyEventForTest(landed(reads()[0]!.requestId)));
    const player = studio[0]!.querySelector(".fy-replyplay");
    assert.ok(player, "the player sits under the reply it reads");
    assert.match(player.textContent ?? "", /George · this machine/);
    await click(player.querySelector<HTMLButtonElement>('[aria-label="Stop"]'));
    assert.equal(studio[0]!.querySelector(".fy-replyplay"), null);
    assert.equal(listenIn(studio[0]!)?.textContent, "Listen");
  });

  it("World Chat on a phone: a speaker in the reply's own action row", async () => {
    phone = true;
    const container = await worldChat(chatArtifactsFixture());
    const studio = turns(container).filter((turn) => turn.classList.contains("fy-chat__turn--studio"));
    assert.equal(studio.length, 2);
    for (const turn of studio) {
      assert.ok(turn.querySelector('.fy-replyacts [aria-label="Listen"]'));
      assert.ok(turn.querySelector('.fy-replyacts [aria-label="Copy"]'));
    }
    await click(studio[1]!.querySelector<HTMLButtonElement>('[aria-label="Listen"]'));
    assert.ok(studio[1]!.querySelector('[aria-label="Stop reading"]'), "the lit speaker stops the read");
    assert.equal(reads().length, 1);
  });

  it("a production's dock: Listen under the reply, read from that thread", async () => {
    const cv = "cv_01J8F3K2QW9VZX4N7M0RTYB6PD";
    const state = structuredClone(FIXTURE_STATE);
    state.world!.conversations = [{ id: cv, title: "Scene 4", status: "open", updatedAt: "2026-10-02T12:00:00Z", pointCount: 0, openProposalCount: 0, notCarried: [],
      entryContext: { kind: "scene", productionId: "saltlight", sceneId: "sc_04" } }];
    state.worldChat = WorldChatWorkspaceSchema.parse({
      conversationId: cv, status: "open", points: [],
      messages: [
        { id: "msg_01J8F3K2QW9VZX4N7M0RTYB6P1", turnId: "turn_01J8F3K2QW9VZX4N7M0RTYB6P1", role: "user", text: "Is Ife too cold here?", createdAt: "2026-10-02T12:00:00Z", receipts: [], refusals: [] },
        { id: "msg_01J8F3K2QW9VZX4N7M0RTYB6P2", turnId: "turn_01J8F3K2QW9VZX4N7M0RTYB6P1", role: "studio", text: "Not too cold — controlled.", createdAt: "2026-10-02T12:00:00Z", receipts: [], refusals: [] },
      ],
    });
    const container = await mount(state, <ProductionConversation worldId={FIXTURE_WORLD_ID} productionId="saltlight"
      entry={{ kind: "scene", productionId: "saltlight", sceneId: "sc_04" }} dock={{ title: "Arke · Scene 4", subject: "Scene 4", conversationFirst: true }}
      emptyLine="Nothing yet." placeholder="Ask about scene 4" />, `/w/${FIXTURE_WORLD_ID}/p/saltlight/scenes/sc_04`);
    const studio = turns(container).filter((turn) => turn.classList.contains("fy-chat__turn--studio"));
    assert.equal(studio.length, 1);
    assert.equal(container.querySelectorAll(".fy-replyacts").length, 1);
    await click(listenIn(studio[0]!));
    assert.deepEqual(reads()[0]!.source, { of: "reply", conversationId: cv, messageId: "msg_01J8F3K2QW9VZX4N7M0RTYB6P2" });
  });

  it("production setup: Listen under Arke's replies", async () => {
    const id = "cv_01J8F3K2QW9VZX4N7M0RTYB6HC";
    const setup = ProductionSetupStateSchema.parse({ status: "draft", review: null, draft: { schemaVersion: 1, setupId: id, worldId: FIXTURE_WORLD_ID, revision: 1,
      title: "", kind: "film", aspect: "16:9", frameRate: 24, narrative: {}, arcs: [], references: [], openQuestions: [], episodes: [], scenes: [] } });
    const state = structuredClone(FIXTURE_STATE);
    state.world!.conversations = [{ id, title: "New production", status: "open", updatedAt: "2026-10-02T12:00:00Z", pointCount: 0, openProposalCount: 0, notCarried: [],
      entryContext: { kind: "production-setup", setupId: id }, setupStatus: "draft" }];
    state.worldChat = WorldChatWorkspaceSchema.parse({ conversationId: id, status: "open", points: [], productionSetup: setup, messages: [
      { id: "msg_01J8F3K2QW9VZX4N7M0RTYB6S1", turnId: "turn_01J8F3K2QW9VZX4N7M0RTYB6S1", role: "user", text: "A heist.", createdAt: "2026-10-02T12:00:00Z", receipts: [], refusals: [] },
      { id: "msg_01J8F3K2QW9VZX4N7M0RTYB6S2", turnId: "turn_01J8F3K2QW9VZX4N7M0RTYB6S1", role: "studio", text: "A heist on the lighthouse, then.", createdAt: "2026-10-02T12:00:00Z", receipts: [], refusals: [] },
    ] });
    const container = await mount(state, <Routes><Route path="/w/:worldId/productions/setup/:setupId" element={<ProductionSetupScreen />} /></Routes>,
      `/w/${FIXTURE_WORLD_ID}/productions/setup/${id}`);
    assert.equal(container.querySelectorAll(".fy-replyacts").length, 1);
    await click(listenIn(turns(container).find((turn) => turn.classList.contains("fy-chat__turn--studio"))!));
    assert.deepEqual(reads()[0]!.source, { of: "reply", conversationId: id, messageId: "msg_01J8F3K2QW9VZX4N7M0RTYB6S2" });
  });
});

describe("Read replies", () => {
  it("is offered for the voice on this machine, a Free plan or a free credit with room, and absent for a priced narrator", async () => {
    const cases: [string, ClientState, boolean][] = [
      ["shipped voice", chatArtifactsFixture(), true],
      ["Free plan", withNarrator(chatArtifactsFixture(), PAUL, "free-plan"), true],
      ["free credit", withNarrator(chatArtifactsFixture(), PAUL, "free-credit"), true],
      ["priced", withNarrator(chatArtifactsFixture(), PAUL), false],
    ];
    for (const [name, state, offered] of cases) {
      const container = await worldChat(state);
      assert.equal(readRepliesButton(container) !== null, offered, name);
      await act(async () => root!.unmount());
      root = undefined;
      dom.document.body.replaceChildren();
    }
  });

  it("reads a reply that finishes while the chat is on screen, and none of the history it opened on", async () => {
    const state = chatArtifactsFixture();
    const container = await worldChat(state);
    const toggle = readRepliesButton(container)!;
    assert.equal(toggle.getAttribute("aria-pressed"), "false");
    await click(toggle);
    assert.equal(readRepliesButton(container)!.getAttribute("aria-pressed"), "true");
    assert.equal(stored.get("arke.chat.readReplies"), "on", "kept on this device");
    assert.equal(reads().length, 0, "the replies already there are history");

    const next = structuredClone(state);
    const turnId = "turn_01J8F3K2QW9VZX4N7M0RTYB6Q1";
    next.worldChat!.messages.push(
      { id: "msg_01J8F3K2QW9VZX4N7M0RTYB6Q1", turnId, role: "user", text: "And the lock?", createdAt: "2026-10-02T12:00:00Z", receipts: [], refusals: [] } as never,
      { id: "msg_01J8F3K2QW9VZX4N7M0RTYB6Q2", turnId, role: "studio", text: "Nobody guards it since the storm.", createdAt: "2026-10-02T12:00:00Z", receipts: [], refusals: [] } as never,
    );
    await act(async () => __setStateForTest(next, { connection: "open" }));
    assert.deepEqual(reads().map((read) => read.source), [{ of: "reply", conversationId: CHAT_ID, messageId: "msg_01J8F3K2QW9VZX4N7M0RTYB6Q2" }]);
    const last = turns(container).filter((turn) => turn.classList.contains("fy-chat__turn--studio")).at(-1)!;
    assert.equal(listenIn(last)?.textContent, "Reading");
  });

  it("switches itself off, saying why, when the narrator changes to one that asks", async () => {
    stored.set("arke.chat.readReplies", "on");
    const state = chatArtifactsFixture();
    const container = await worldChat(state);
    assert.equal(readRepliesButton(container)!.getAttribute("aria-pressed"), "true");
    await act(async () => __setStateForTest(withNarrator(structuredClone(state), PAUL), { connection: "open" }));
    assert.equal(readRepliesButton(container), null);
    assert.match(container.querySelector(".fy-cx")!.textContent ?? "", /Read replies off · Paul asks first/);
    assert.equal(stored.get("arke.chat.readReplies"), "off");
  });

  it("stops the read when a message is sent", async () => {
    setReadReplies(false);
    const state = chatArtifactsFixture();
    const container = await worldChat(state);
    const studio = turns(container).filter((turn) => turn.classList.contains("fy-chat__turn--studio"));
    await click(listenIn(studio[0]!));
    const requestId = reads()[0]!.requestId;
    await act(async () => __applyEventForTest(landed(requestId)));
    assert.ok(studio[0]!.querySelector(".fy-replyplay"));
    const editor = container.querySelector<HTMLElement>(".fy-cx__editor")!;
    await act(async () => { editor.textContent = "Keep going"; editor.dispatchEvent(new dom.Event("input", { bubbles: true })); });
    await click(container.querySelector<HTMLButtonElement>(".fy-cx__send"));
    assert.ok(sent.some((message) => message.kind === "world-chat-send"), "the message went");
    assert.equal(studio[0]!.querySelector(".fy-replyplay"), null, "sending stops the reply being read");
  });
});

describe("one read at a time", () => {
  it("starting a second reply's read stops the first outright, and its late piece never plays", async () => {
    const state = chatArtifactsFixture();
    const container = await worldChat(state);
    const studio = turns(container).filter((turn) => turn.classList.contains("fy-chat__turn--studio"));
    await click(listenIn(studio[0]!));
    const first = reads()[0]!.requestId;
    await click(listenIn(studio[1]!));
    const second = reads()[1]!.requestId;
    assert.notEqual(first, second);
    assert.ok(sent.some((message) => message.kind === "stop-prose-page" && message.requestId === first), "the coordinator stops making the first");
    assert.equal(listenIn(studio[0]!)?.textContent, "Listen");
    assert.equal(listenIn(studio[1]!)?.textContent, "Listening");
    await act(async () => __applyEventForTest(landed(first, ".cache/voice/first.wav")));
    assert.equal(studio[0]!.querySelector(".fy-replyplay"), null, "the first reply's late audio does not take the voice back");
    await act(async () => __applyEventForTest(landed(second, ".cache/voice/second.wav")));
    assert.ok(studio[1]!.querySelector(".fy-replyplay"));
  });
});

