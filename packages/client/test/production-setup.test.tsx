import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { ProductionSetupStateSchema, WorldChatWorkspaceSchema, presetTarget, type ClientMessage, type ClientState, type ProductionSetupState } from "@arke-studio/contracts";
import { ProductionSetupScreen } from "../src/screens/production-setup.js";
import { NewProductionScreen } from "../src/screens/world.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {} });
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});
const ID = "cv_01J8F3K2QW9VZX4N7M0RTYB6HC";
const AT = "2026-09-08T09:00:00.000Z";
const REVIEW_ID = "01J8F3K2QW9VZX4N7M0RTYB6HD";
function draft(): ProductionSetupState {
  return ProductionSetupStateSchema.parse({
    status: "draft", review: null,
    draft: { schemaVersion: 1, setupId: ID, worldId: FIXTURE_WORLD_ID, revision: 3,
      title: "The crossing", kind: "film", aspect: "16:9", frameRate: 24,
      narrative: { direction: "A return becomes a departure." }, arcs: [], references: [],
      openQuestions: ["What happens next?"], episodes: [], scenes: [{ key: "arrival", title: "Arrival", synopsis: "The boat returns." }],
    },
  });
}
function fixture(setup: ProductionSetupState): ClientState {
  const state = structuredClone(FIXTURE_STATE);
  state.world!.conversations = [{
    id: ID, title: "The crossing", status: "open", updatedAt: AT, pointCount: 0, openProposalCount: 0,
    notCarried: [], entryContext: { kind: "production-setup", setupId: ID }, setupStatus: setup.status,
  }];
  state.worldChat = WorldChatWorkspaceSchema.parse({
    conversationId: ID, status: "open", messages: [], points: [], productionSetup: setup,
  });
  return state;
}
let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null; __setBridgeForTest(null); __setStateForTest(FIXTURE_STATE);
  dom.document.body.innerHTML = "";
});
async function mount(state = fixture(draft()), door = false) {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send: (json: string) => { sent.push(JSON.parse(json)); } } satisfies ArkeBridge);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    __setStateForTest(state, { connection: "open" });
    root!.render(<MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/productions/${door ? "new" : `setup/${ID}`}`]}>
      <Routes>
        <Route path="/w/:worldId/productions/new" element={<NewProductionScreen />} />
        <Route path="/w/:worldId/productions/setup/:setupId" element={<ProductionSetupScreen />} />
        <Route path="/w/:worldId/p/:prodId" element={<p>Created production workspace</p>} />
        <Route path="/w/:worldId/productions" element={<p>Saved production setups</p>} />
      </Routes>
    </MemoryRouter>);
  });
  return { container, sent, commands: () => sent.filter((message): message is Extract<ClientMessage, { kind: "production-setup" }> => message.kind === "production-setup") };
}
async function click(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === label);
  assert.ok(button, `Button ${label} is present`);
  await act(async () => button.dispatchEvent(new dom.Event("click", { bubbles: true })));
}
async function answer(command: Extract<ClientMessage, { kind: "production-setup" }>, setup: ProductionSetupState) {
  await act(async () => {
    __setStateForTest(fixture(setup), { connection: "open" });
    __applyEventForTest({ type: "production-setup.result", at: AT, worldId: FIXTURE_WORLD_ID,
      setupId: command.setupId, requestId: command.requestId, state: setup });
  });
}

describe("production setup interaction (issue #976)", () => {
  it("offers the running harness catalog and can reset a removed explicit model (#1123)", async () => {
    const state = fixture(draft());
    state.app.health.harness = { status: "healthy" };
    state.app.harnessInfo = { generation: "claude", source: "path", version: "2.0.0", beta: false };
    state.app.harnessModelStatus = { status: "ready" };
    state.app.harnessModels = [{ provider: "anthropic", id: "opus[1m]", displayName: "Opus" }];
    const m = await mount(state);
    assert.ok(m.sent.some(message => message.kind === "list-harness-models"));
    // The model is a chip in the composer's row, with no row, select or scope word of its own
    // (design turn 190e). A setup is not yet a production, so the chip has no press that
    // remembers a choice: it picks for this conversation and lets go of it. Its menu is drawn on
    // the body, out of the composer's clip.
    assert.equal(m.container.querySelector("select[aria-label='Writing model'], .fy-production-setup__model"), null);
    const chip = () => m.container.querySelector<HTMLButtonElement>(".fy-cx__bar button.fy-mchip__btn")!;
    const open = async () => { if (!dom.document.body.querySelector(".fy-mchip__menu")) await act(async () => chip().click()); };
    await open();
    const items = [...dom.document.body.querySelectorAll<HTMLButtonElement>(".fy-mchip__menu [data-model]")];
    assert.ok(items.some(item => item.getAttribute("data-model") === "anthropic/opus[1m]"));
    assert.deepEqual([...dom.document.body.querySelectorAll(".fy-mchip__menu .fy-mpick__foot button")].map(item => item.textContent), ["Manage models"], "nothing to remember the choice in");
    await act(async () => items.find(item => item.getAttribute("data-model") === "anthropic/opus[1m]")!.click());
    assert.ok(chip().className.includes("fy-mchip__btn--set"), "the choice is this conversation's");
    await act(async () => __setStateForTest({
      ...state, app: { ...state.app, harnessModels: [], harnessModelStatus: { status: "error", reason: "Discovery failed." } },
    }));
    assert.equal(chip().disabled, false);
    await open();
    assert.match(dom.document.body.querySelector(".fy-mchip__menu")!.textContent!, /anthropic\/opus\[1m\]\s*unavailable/);
    assert.match(m.container.textContent!, /Discovery failed/, "the catalogue's trouble is said while there is trouble");
    const reset = [...dom.document.body.querySelectorAll<HTMLElement>(".fy-mchip__menu [role=option]:not([data-model])")].find(item => /Use the default/.test(item.textContent!))!;
    await act(async () => reset.click());
    assert.equal(chip().className.includes("fy-mchip__btn--set"), false);
    await open();
    assert.doesNotMatch(dom.document.body.querySelector(".fy-mchip__menu")!.textContent!, /unavailable/);
  });

  it("says nothing of the model catalogue while it is simply fine", async () => {
    const state = fixture(draft());
    state.app.health.harness = { status: "healthy" };
    state.app.harnessInfo = { generation: "claude", source: "path", version: "2.0.0", beta: false };
    state.app.harnessModelStatus = { status: "ready" };
    state.app.harnessModels = [{ provider: "anthropic", id: "opus[1m]", displayName: "Opus" }];
    const m = await mount(state);
    assert.doesNotMatch(m.container.textContent!, /models? from /);
  });

  it("offers Stop for a live turn and Retry and Review after interruption (#1030)", async () => {
    const m = await mount();
    await answer(m.commands()[0]!, draft());
    const live = fixture(draft());
    live.worldChat!.runStatus = "running";
    live.worldChat!.runStartedAt = AT;
    await act(async () => __setStateForTest(live, { connection: "open" }));
    assert.ok([...m.container.querySelectorAll("button")].find(button => button.textContent === "Review production")!.disabled);
    await click(m.container, "Stop esc");
    assert.deepEqual(m.commands().at(-1)!.action, { operation: "cancel" });
    await answer(m.commands().at(-1)!, draft());

    const recovered = fixture(draft());
    const turnId = "turn_01J8F3K2QW9VZX4N7M0RTYB6HC";
    recovered.worldChat!.lastFailure = { turnId, status: "interrupted" };
    await act(async () => __setStateForTest(recovered, { connection: "open" }));
    assert.match(m.container.textContent!, /turn was interrupted/);
    assert.ok(![...m.container.querySelectorAll("button")].find(button => button.textContent === "Review production")!.disabled);
    await click(m.container, "Try that again");
    assert.deepEqual(m.commands().at(-1)!.action, { operation: "retry", turnId });
  });

  it("shows every inherited scene field in the outline the author reviews", async () => {
    const setup = draft();
    setup.draft.scenes[0]!.inherits = { location: "the-crossing", timeOfDay: "Before sunrise", tone: "Quiet unease" };
    const m = await mount(fixture(setup));
    await answer(m.commands()[0]!, setup);
    assert.match(m.container.textContent!, /Location: the-crossing/);
    assert.match(m.container.textContent!, /Time: Before sunrise/);
    assert.match(m.container.textContent!, /Tone: Quiet unease/);
  });

  it("the film door opens a private conversation without sending create-production", async () => {
    const m = await mount(FIXTURE_STATE, true);
    const film = [...m.container.querySelectorAll("button")].find(button => button.textContent?.includes("Make a film"));
    assert.ok(film);
    await act(async () => film.dispatchEvent(new dom.Event("click", { bubbles: true })));
    assert.equal(m.commands().at(-1)?.action.operation, "start");
    assert.equal(m.sent.some(message => message.kind === "create-production"), false);
    assert.match(m.container.textContent!, /Production so far/);
  });

  it("reviews the shown revision, then creates exactly the frozen review and navigates by returned id", async () => {
    const m = await mount();
    await answer(m.commands()[0]!, draft());
    await click(m.container, "Review production");
    const review = m.commands().at(-1)!;
    assert.deepEqual(review.action, { operation: "review", expectedRevision: 3 });
    const reviewed: ProductionSetupState = {
      ...draft(), status: "reviewed", review: {
        id: REVIEW_ID, sourceDigest: `sha256:${"a".repeat(64)}`,
        plan: {
          production: { id: "the-crossing-2", title: "The crossing", format: "video", status: "in-progress",
            created: AT, updated: AT, aspect: "16:9", frameRate: 24, failureModes: [] },
          initialSeason: null, series: { operation: "none" },
          initialContent: { worldId: FIXTURE_WORLD_ID, setupId: ID, revision: 3, narrative: { version: 1, direction: "A return becomes a departure." }, scenes: [], episodes: [] },
        },
      },
    };
    await answer(review, reviewed);
    assert.match(m.container.textContent!, /Ready to create/);
    await click(m.container, "Create production");
    const create = m.commands().at(-1)!;
    assert.deepEqual(create.action, { operation: "create", expectedRevision: 3, reviewId: REVIEW_ID });
    await answer(create, { ...reviewed, status: "created", productionId: "the-crossing-2" });
    assert.match(m.container.textContent!, /Created production workspace/);
  });

  it("switches narrow-panel tabs without losing the composer or outline", async () => {
    const m = await mount();
    await answer(m.commands()[0]!, draft());
    const composer = m.container.querySelector('[role="textbox"]')!;
    assert.ok(composer);
    await click(m.container, "Production so far");
    assert.equal(m.container.querySelector('[data-active]')!.getAttribute("data-active"), "outline");
    assert.match(m.container.textContent!, /The boat returns/);
    await click(m.container, "Conversation");
    assert.equal(m.container.querySelector('[role="textbox"]'), composer);
  });

  it("a stale-review refusal leaves the outline and draft open for revision", async () => {
    const m = await mount();
    await answer(m.commands()[0]!, draft());
    await click(m.container, "Review production");
    const request = m.commands().at(-1)!;
    await act(async () => __applyEventForTest({ type: "production-setup.result", at: AT,
      worldId: FIXTURE_WORLD_ID, setupId: ID, requestId: request.requestId, detail: "The world changed after review." }));
    assert.match(m.container.textContent!, /world changed/);
    assert.match(m.container.textContent!, /The boat returns/);
    assert.ok([...m.container.querySelectorAll("button")].some(button => button.textContent === "Review production" && !button.disabled));
  });

  // Adapt from (design turn 205, SPEC-052 R-1): the world's stories with chapters, under the format,
  // for a film or a micro drama; choosing one or Nothing is the same draft update Arke could make.
  it("offers the world's stories under Adapt from and sends the choice as the draft's source", async () => {
    const withStory = (setup: ProductionSetupState) => {
      const state = fixture(setup);
      const video = state.world!.productions[0]!;
      const chapter = (id: string, order: number, words: number) => ({ id, file: id, order, title: id, status: "draft", version: 1, words });
      state.world!.productions.push({ ...structuredClone(video), meta: { ...video.meta, id: "na-love", title: "Na love or Juju", format: "story", medium: "story", kind: "book" },
        chapters: [chapter("gold-on-gold", 1, 4_100), chapter("suya-at-midnight", 2, 3_600)], scenes: [] });
      return state;
    };
    const m = await mount(withStory(draft()));
    await answer(m.commands()[0]!, draft());
    await act(async () => { __setStateForTest(withStory(draft()), { connection: "open" }); });
    const select = () => [...m.container.querySelectorAll("label")].find(label => label.textContent?.startsWith("Adapt from"))?.querySelector("select");
    assert.ok(select(), "Adapt from stands under the format for a film");
    assert.deepEqual([...select()!.querySelectorAll("option")].map(option => option.textContent),
      ["Nothing — start from an idea", "Na love or Juju · book · 2 chapters · 7,700 words"]);
    Object.defineProperty(select()!, "value", { value: "na-love", configurable: true });
    await act(async () => select()!.dispatchEvent(new dom.Event("change", { bubbles: true })));
    const chosen = m.commands().at(-1)!;
    assert.deepEqual(chosen.action, { operation: "update", update: { expectedRevision: 3, fields: { source: { productionId: "na-love" } } } });
    const sourced = draft();
    sourced.draft.source = { productionId: "na-love" };
    await answer(chosen, sourced);
    await act(async () => { __setStateForTest(withStory(sourced), { connection: "open" }); });
    Object.defineProperty(select()!, "value", { value: "", configurable: true });
    await act(async () => select()!.dispatchEvent(new dom.Event("change", { bubbles: true })));
    assert.deepEqual(m.commands().at(-1)!.action, { operation: "update", update: { expectedRevision: 3, fields: { source: null } } });
    const music = draft();
    music.draft.kind = "music-video";
    await act(async () => { __setStateForTest(withStory(music), { connection: "open" }); });
    assert.equal(select(), undefined, "a music video adapts nothing");
  });

  // The Target (design turn 205, SPEC-052 R-6..R-9): where it will be watched first, then the
  // numbers a preset filled, each with what it comes to; a preset sends its target and its defaults.
  it("shows a micro drama's Target with what each row comes to, and a preset sends its numbers", async () => {
    const micro = draft();
    const global = presetTarget("global-app");
    micro.draft.kind = "microdrama";
    micro.draft.target = global.target;
    micro.draft.defaults = { ...global.defaults, hookWindowSec: 3 };
    const m = await mount(fixture(micro));
    await answer(m.commands()[0]!, micro);
    const card = m.container.querySelector('[aria-label="Target"]');
    assert.ok(card, "the Target stands in the rail for a micro drama");
    const text = card!.textContent ?? "";
    for (const end of ["2 seasons", "120 min", "then paid", "one drop"]) assert.ok(text.includes(end), end);
    const audience = card!.querySelector("#target-audience") as HTMLSelectElement;
    assert.ok([...audience.querySelectorAll("option")].some(option => option.textContent === "Nigeria · free vertical · 40–60 × 60–90 s · free"));
    Object.defineProperty(audience, "value", { value: "nigeria-free-vertical", configurable: true });
    await act(async () => audience.dispatchEvent(new dom.Event("change", { bubbles: true })));
    const nigeria = presetTarget("nigeria-free-vertical");
    assert.deepEqual(m.commands().at(-1)!.action, { operation: "update", update: { expectedRevision: 3, fields: {
      target: nigeria.target, defaults: { ...micro.draft.defaults, ...nigeria.defaults },
    } } });
    const film = draft();
    await act(async () => { __setStateForTest(fixture(film), { connection: "open" }); });
    assert.equal(m.container.querySelector('[aria-label="Target"]'), null, "a film has no Target here");
  });
});
