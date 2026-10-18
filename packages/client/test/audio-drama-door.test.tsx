import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { ProductionSetupStateSchema, WorldChatWorkspaceSchema, type ClientMessage, type ClientState, type ProductionSetupState } from "@arke-studio/contracts";
import { ProductionSetupScreen } from "../src/screens/production-setup.js";
import { DOOR_CHOICES, KINDS_BY_DOOR, KIND_PLATES, NewProductionScreen, STORY_KIND_CHOICES } from "../src/screens/world.js";
import { productionPages } from "../src/lib/production-navigation.js";
import { App } from "../src/App.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/**
 * The audio drama's way in (design turn 230a–c, SPEC-057 R-1..R-9): a kind under Tell a story,
 * Adapt from on its step two, Plan with Arke into a setup that already knows the story, and one
 * plan to accept or change. Then the production's own rail and Episodes page.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1360, innerHeight: 900 });
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {} });
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const AT = "2026-10-18T09:00:00.000Z";
const NEW = `/w/${FIXTURE_WORLD_ID}/productions/new`;
const chapter = (id: string, order: number, words: number) => ({ id, order, title: `Chapter ${order}`, file: `${id}.md`, words, status: "drafted" });

/** The fixture world, holding a novel to adapt and an audio drama already made from it. */
function withStories(): ClientState {
  const state = structuredClone(FIXTURE_STATE);
  const base = state.world!.productions[0]!;
  const novel = { ...structuredClone(base), meta: { ...base.meta, id: "low-water", title: "Low Water", format: "story", medium: "story", kind: undefined },
    chapters: [chapter("tide", 1, 4000), chapter("bell", 2, 3500)], scenes: [], episodes: [], takes: [] };
  const drama = { ...structuredClone(base), meta: { ...base.meta, id: "low-water-drama", title: "Low Water, for the ear", format: "story", medium: "story", kind: "audio-drama" },
    chapters: [], scenes: [], episodes: [], takes: [],
    audioDrama: { version: 1, source: { productionId: "low-water" }, plan: {
      episodes: 6, minutes: 25, narrator: "narrated",
      keptFromListener: [{ fact: "Ilo is alive", revealEpisode: 5 }],
      pilot: { title: "The tide turns", chapters: [1] },
    } } };
  state.world!.productions = [...state.world!.productions, novel, drama] as never;
  return state;
}

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null; __setBridgeForTest(null); __setStateForTest(FIXTURE_STATE);
  dom.document.body.innerHTML = "";
});

async function mount(state: ClientState, entry: string | { pathname: string; state: unknown }) {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send: (json: string) => { sent.push(JSON.parse(json)); } } satisfies ArkeBridge);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    __setStateForTest(state, { connection: "open" });
    root!.render(<MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/w/:worldId/productions/new" element={<NewProductionScreen />} />
        <Route path="/w/:worldId/productions/setup/:setupId" element={<ProductionSetupScreen />} />
        <Route path="/w/:worldId/productions" element={<p>Saved production setups</p>} />
      </Routes>
    </MemoryRouter>);
  });
  return { container, sent, setup: () => sent.filter((m): m is Extract<ClientMessage, { kind: "production-setup" }> => m.kind === "production-setup") };
}
const button = (container: HTMLElement, label: string) => [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === label);
async function click(container: HTMLElement, label: string) {
  const found = button(container, label);
  assert.ok(found, `${label} is offered`);
  await act(async () => found.dispatchEvent(new dom.Event("click", { bubbles: true })));
}
// linkedom clears the selected option whenever any option's `selected` is set, so only the chosen
// one is touched; its setter deselects the rest.
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    [...select.querySelectorAll("option")].find(option => option.value === value)!.selected = true;
    select.dispatchEvent(new dom.Event("change", { bubbles: true }));
  });
}
/** A handler as React holds it: linkedom raises no input or blur event React listens for. */
async function fire(el: HTMLInputElement, handler: "onChange" | "onBlur", value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
    if (setter) setter.call(el, value); else el.value = value;
    const key = Object.keys(el).find(candidate => candidate.startsWith("__reactProps$"))!;
    (el as unknown as Record<string, Record<string, (event: { target: HTMLInputElement; currentTarget: HTMLInputElement }) => void>>)[key]![handler]!({ target: el, currentTarget: el });
  });
}

describe("Tell a story asks what kind of story (design turn 230b)", () => {
  it("offers a novel, an audio drama or neither, and names audio drama on the card", () => {
    assert.deepEqual(STORY_KIND_CHOICES.map(k => [k.id, k.label, k.body]), [
      ["book", "Novel", "Chapters, to read."],
      ["audio-drama", "Audio drama", "Episodes, for the ear."],
      ["other", "Other", "Nothing assumed."],
    ]);
    assert.equal(KINDS_BY_DOOR.write, STORY_KIND_CHOICES);
    const write = DOOR_CHOICES.find(d => d.id === "write")!;
    assert.match(write.body, /audio drama/);
    assert.match(write.body, /audiobook/, "the audiobook still rides under WRITE");
    assert.deepEqual(DOOR_CHOICES.map(d => d.label), ["Tell a story", "Make a film", "Make it interactive"], "no fourth door (revision 2)");
  });

  it("a novel and an audio drama are chosen by their plates; Other is the empty box", () => {
    const plates = fileURLToPath(new URL("../public/video-kinds/", import.meta.url));
    for (const kind of STORY_KIND_CHOICES) {
      assert.equal(existsSync(`${plates}${kind.id}.webp`), KIND_PLATES.has(kind.id), `${kind.id}'s plate matches what the screen asks for`);
    }
    assert.ok(KIND_PLATES.has("audio-drama") && KIND_PLATES.has("book"));
  });

  it("Adapt… arrives on step two with the story set, and Plan with Arke seeds the setup with it", async () => {
    const m = await mount(withStories(), { pathname: NEW, state: { adapt: { productionId: "low-water" } } });
    const text = m.container.textContent!;
    assert.match(text, /What kind of story\?/);
    assert.match(text, /Novel/);
    assert.match(m.container.querySelector(".fy-radio--on")!.textContent!, /Audio drama/, "the drama is the kind already chosen");
    const adapt = m.container.querySelector<HTMLSelectElement>("select[aria-label='Adapt from']")!;
    assert.equal(adapt.value, "low-water");
    assert.deepEqual([...adapt.options].map(o => o.textContent), ["Nothing · an original drama", "Low Water · 2 chapters · 7,500 words"],
      "the drama made from it is never offered as a story to adapt");
    assert.doesNotMatch(text, /DEFAULTS · CHANGE LATER|FRAME|RATE|LENGTH/, "no frame, rate, episodes or length for a story for the ear");
    assert.equal(button(m.container, "Create"), undefined, "nothing is created before Arke has read it");
    await click(m.container, "Plan with Arke");
    assert.equal(m.sent.some(message => message.kind === "create-production"), false);
    const start = m.setup().at(-1)!;
    assert.equal(start.action.operation, "start");
    assert.deepEqual(start.action.operation === "start" && start.action.seed, { kind: "audio-drama", source: { productionId: "low-water" }, title: "Low Water" },
      "the name follows the story until the author types one");
  });

  it("an original audio drama is created directly, as a story of its kind with no frame", async () => {
    const m = await mount(withStories(), { pathname: NEW, state: { adapt: { productionId: "low-water" } } });
    await choose(m.container.querySelector<HTMLSelectElement>("select[aria-label='Adapt from']")!, "");
    assert.equal(button(m.container, "Plan with Arke"), undefined);
    await click(m.container, "Create");
    const create = m.sent.find((message): message is Extract<ClientMessage, { kind: "create-production" }> => message.kind === "create-production")!;
    assert.equal(create.medium, "story");
    assert.equal(create.productionKind, "audio-drama");
    assert.equal(create.title, "Low Water");
    assert.equal("aspect" in create, false);
    assert.equal("frameRate" in create, false);
  });

  it("a novel still opens day one, and writes no kind", async () => {
    const m = await mount(withStories(), NEW);
    const write = [...m.container.querySelectorAll("button")].find(b => b.textContent?.includes("Tell a story"))!;
    await act(async () => write.dispatchEvent(new dom.Event("click", { bubbles: true })));
    assert.match(m.container.querySelector(".fy-radio--on")!.textContent!, /Novel/, "an untouched step two writes what it always did");
    assert.equal(m.container.querySelector("select[aria-label='Adapt from']"), null, "a novel adapts nothing");
    await fire(m.container.querySelector<HTMLInputElement>("#production-name")!, "onChange", "Undertow");
    await click(m.container, "Create and open day one");
    const create = m.sent.find((message): message is Extract<ClientMessage, { kind: "create-production" }> => message.kind === "create-production")!;
    assert.equal(create.medium, "story");
    assert.equal("productionKind" in create, false);
  });
});

const SETUP = "cv_01J8F3K2QW9VZX4N7M0RTYB6HC";
function dramaSetup(revision = 1, plan?: object): ProductionSetupState {
  return ProductionSetupStateSchema.parse({
    status: "draft", review: null,
    draft: { schemaVersion: 1, setupId: SETUP, worldId: FIXTURE_WORLD_ID, revision, title: "Low Water", kind: "audio-drama", aspect: "16:9", frameRate: 24,
      narrative: {}, arcs: [], references: [], openQuestions: [], episodes: [], scenes: [], source: { productionId: "low-water" },
      audioDrama: plan ?? { episodes: 6, minutes: 25, keptFromListener: [] } },
  });
}
function inSetup(setup: ProductionSetupState, messages: unknown[] = []): ClientState {
  const state = withStories();
  state.world!.conversations = [{
    id: SETUP, title: "Low Water", status: "open", updatedAt: AT, pointCount: 0, openProposalCount: 0,
    notCarried: [], entryContext: { kind: "production-setup", setupId: SETUP }, setupStatus: setup.status,
  }];
  state.worldChat = WorldChatWorkspaceSchema.parse({ conversationId: SETUP, status: "open", messages, points: [], productionSetup: setup });
  return state;
}
async function answer(command: Extract<ClientMessage, { kind: "production-setup" }>, setup: ProductionSetupState) {
  await act(async () => {
    __setStateForTest(inSetup(setup), { connection: "open" });
    __applyEventForTest({ type: "production-setup.result", at: AT, worldId: FIXTURE_WORLD_ID, setupId: command.setupId, requestId: command.requestId, state: setup });
  });
}

describe("setup asks one question and proposes one plan (design turn 230c)", () => {
  it("a seeded setup starts by asking for the story, once", async () => {
    const state = withStories();
    const m = await mount(state, { pathname: `/w/${FIXTURE_WORLD_ID}/productions/setup/${SETUP}`, state: { seed: { kind: "audio-drama", source: { productionId: "low-water" } } } });
    const start = m.setup()[0]!;
    assert.deepEqual(start.action, { operation: "start", seed: { kind: "audio-drama", source: { productionId: "low-water" } } });
    await answer(start, dramaSetup());
    const asks = m.setup().filter(command => command.action.operation === "send");
    assert.equal(asks.length, 1);
    assert.deepEqual(asks[0]!.action, { operation: "send", text: "An audio drama of Low Water." });
    await answer(asks[0]!, dramaSetup());
    assert.equal(m.setup().filter(command => command.action.operation === "send").length, 1, "never twice");
  });

  it("an unseeded setup waits for the author", async () => {
    const m = await mount(inSetup(dramaSetup()), `/w/${FIXTURE_WORLD_ID}/productions/setup/${SETUP}`);
    await answer(m.setup()[0]!, dramaSetup());
    assert.equal(m.setup().some(command => command.action.operation === "send"), false);
  });

  it("reads back Story · audio drama with no frame, and one plan to accept or change", async () => {
    const plan = { episodes: 6, minutes: 25, narrator: "narrated", keptFromListener: [{ fact: "Ilo is alive", revealEpisode: 5 }], pilot: { title: "The tide turns", chapters: [3] } };
    const m = await mount(inSetup(dramaSetup(4, plan)), `/w/${FIXTURE_WORLD_ID}/productions/setup/${SETUP}`);
    await answer(m.setup()[0]!, dramaSetup(4, plan));
    const format = m.container.querySelector<HTMLSelectElement>(".fy-production-setup__fields select")!;
    assert.equal(format.value, "audio-drama");
    assert.equal([...format.options].find(option => option.value === format.value)!.textContent, "Story · audio drama");
    assert.equal(m.container.querySelector(".fy-production-setup__delivery"), null, "no aspect or frame rate");
    const card = m.container.querySelector(".fy-ad-plan")!;
    assert.match(card.textContent!, /Episodes6, about 25 minutes each/);
    assert.match(card.textContent!, /NarratorWhere the ear needs one/);
    assert.match(card.textContent!, /PilotThe tide turns · chapter 3/);
    assert.match(card.textContent!, /Kept from the listener.*Ilo is alive.*until ep 5/);
    assert.doesNotMatch(m.container.textContent!, /Step 1|step list/i);
    await click(m.container, "Change");
    await fire(card.querySelector<HTMLInputElement>("input[type=number]")!, "onBlur", "8");
    const update = m.setup().at(-1)!;
    assert.equal(update.action.operation, "update");
    assert.deepEqual(update.action.operation === "update" && update.action.update, { expectedRevision: 4, fields: { audioDrama: { ...plan, episodes: 8 } } },
      "the plan is replaced whole, so nothing else in it is lost");
  });

  it("leaving the kind drops the plan and restores a frame", async () => {
    const m = await mount(inSetup(dramaSetup(2)), `/w/${FIXTURE_WORLD_ID}/productions/setup/${SETUP}`);
    await answer(m.setup()[0]!, dramaSetup(2));
    await choose(m.container.querySelector<HTMLSelectElement>(".fy-production-setup__fields select")!, "film");
    const update = m.setup().at(-1)!;
    assert.deepEqual(update.action.operation === "update" && update.action.update.fields, { kind: "film", aspect: "16:9", audioDrama: null });
  });
});

describe("an audio drama's own pages (design turn 230 revision 3)", () => {
  it("its page strip is Episodes, Cast and Artifacts", () => {
    assert.deepEqual(productionPages({ hasChapters: false, isEpisodic: false, isBranching: false, isAudioDrama: true }).map(([, label]) => label), ["Episodes", "Cast", "Artifacts"]);
  });

  it("opens on its episodes, the pilot among them, and what the listener is not told yet", () => {
    __setStateForTest(withStories());
    const html = renderToString(<MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/p/low-water-drama`]}><App /></MemoryRouter>).replace(/<!-- -->/g, "");
    __setStateForTest(FIXTURE_STATE);
    assert.match(html, /6 episodes · about 25 minutes each · where the ear needs one/);
    assert.match(html, /Episode 1.*pilot · The tide turns · chapter 1/s);
    assert.match(html, /Episode 6/);
    assert.match(html, /Kept from the listener.*Ilo is alive.*until ep 5/s);
    assert.match(html, /Adapts.*Low Water/s);
    assert.doesNotMatch(html, /Day one\.|Find the spine together/, "not a book's dashboard");
    assert.doesNotMatch(html, />Chapters</, "no chapters on its rail");
    assert.doesNotMatch(html, />Generate<|>Cut</, "and nothing of a video's");
  });
});
