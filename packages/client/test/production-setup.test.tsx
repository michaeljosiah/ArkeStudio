import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { ProductionSetupStateSchema, WorldChatWorkspaceSchema, type ClientMessage, type ClientState, type ProductionSetupState } from "@arke-studio/contracts";
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
});
