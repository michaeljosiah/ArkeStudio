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
  const second = { ...structuredClone(novel), meta: { ...novel.meta, id: "undertow", title: "Undertow" }, chapters: [chapter("one", 1, 1000)] };
  state.world!.productions = [...state.world!.productions, novel, second, drama] as never;
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
    assert.deepEqual([...adapt.options].map(o => o.textContent), ["Nothing · an original drama", "Low Water · book · 2 chapters · 7,500 words", "Undertow · book · 1 chapter · 1,000 words"],
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

  it("an untouched name follows the chosen story; a typed one stays (codex on PR 1866)", async () => {
    const m = await mount(withStories(), { pathname: NEW, state: { adapt: { productionId: "low-water" } } });
    const name = () => m.container.querySelector<HTMLInputElement>("#production-name")!;
    const adapt = () => m.container.querySelector<HTMLSelectElement>("select[aria-label='Adapt from']")!;
    assert.equal(name().value, "Low Water");
    await choose(adapt(), "undertow");
    assert.equal(name().value, "Undertow", "B's drama is not named after A");
    await choose(adapt(), "");
    assert.equal(name().value, "", "an original drama starts unnamed");
    await fire(name(), "onChange", "Salt Road");
    await choose(adapt(), "low-water");
    assert.equal(name().value, "Salt Road", "what the author typed is theirs");
  });

  it("an original audio drama is created directly, as a story of its kind with no frame", async () => {
    const m = await mount(withStories(), { pathname: NEW, state: { adapt: { productionId: "low-water" } } });
    await choose(m.container.querySelector<HTMLSelectElement>("select[aria-label='Adapt from']")!, "");
    assert.equal(button(m.container, "Plan with Arke"), undefined);
    await fire(m.container.querySelector<HTMLInputElement>("#production-name")!, "onChange", "Low Water");
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

  it("a seeded setup reopened without the door's state still asks, once (codex on PR 1866)", async () => {
    const m = await mount(inSetup(dramaSetup()), `/w/${FIXTURE_WORLD_ID}/productions/setup/${SETUP}`);
    assert.deepEqual(m.setup()[0]!.action, { operation: "resume" });
    await answer(m.setup()[0]!, dramaSetup());
    assert.deepEqual(m.setup().filter(command => command.action.operation === "send").map(command => command.action),
      [{ operation: "send", text: "An audio drama of Low Water." }]);
  });

  it("a setup a turn or the author has touched waits for the author", async () => {
    const m = await mount(inSetup(dramaSetup(2)), `/w/${FIXTURE_WORLD_ID}/productions/setup/${SETUP}`);
    await answer(m.setup()[0]!, dramaSetup(2));
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
    assert.equal(m.container.querySelector("[data-testid='models-card']"), null, "no picture or film models for the ear (issue 1883)");
    assert.doesNotMatch(m.container.textContent!, /No media generation starts here/, "and no caption under the composer");
    await click(m.container, "Change");
    await fire(card.querySelector<HTMLInputElement>("input[type=number]")!, "onBlur", "8");
    const update = m.setup().at(-1)!;
    assert.equal(update.action.operation, "update");
    assert.deepEqual(update.action.operation === "update" && update.action.update, { expectedRevision: 4, fields: { audioDrama: { ...plan, episodes: 8 } } },
      "the plan is replaced whole, so nothing else in it is lost");
  });

  it("under Arke's plan, Start the pilot reviews and creates, and Change the plan opens the card (230c, issue 1883)", async () => {
    const plan = { episodes: 4, minutes: 20, narrator: "narrated", keptFromListener: [], pilot: { title: "The tide turns", chapters: [1] } };
    const said = [{ id: "msg_01J8F3K2QW9VZX4N7M0RTYB6HD", turnId: "turn_01J8F3K2QW9VZX4N7M0RTYB6HE", role: "studio", text: "Here is the plan.", receipts: [], refusals: [], createdAt: AT }];
    const m = await mount(inSetup(dramaSetup(4, plan), said), `/w/${FIXTURE_WORLD_ID}/productions/setup/${SETUP}`);
    await act(async () => {
      __setStateForTest(inSetup(dramaSetup(4, plan), said), { connection: "open" });
      __applyEventForTest({ type: "production-setup.result", at: AT, worldId: FIXTURE_WORLD_ID, setupId: m.setup()[0]!.setupId, requestId: m.setup()[0]!.requestId, state: dramaSetup(4, plan) });
    });
    const choices = m.container.querySelector("[aria-label='The plan'][role='group']")!;
    assert.ok(choices, "the two ways on stand under the reply");
    await click(choices as HTMLElement, "Change the plan");
    assert.ok(m.container.querySelector(".fy-ad-plan input[type=number]"), "the plan card opens to edit");
    await click(choices as HTMLElement, "Start the pilot");
    const review = m.setup().at(-1)!;
    assert.deepEqual(review.action, { operation: "review", expectedRevision: 4 });
    const REVIEW = "01J8F3K2QW9VZX4N7M0RTYB6HF";
    const reviewed = ProductionSetupStateSchema.parse({ ...dramaSetup(4, plan), status: "reviewed", review: {
      id: REVIEW, sourceDigest: `sha256:${"a".repeat(64)}`,
      plan: {
        production: { id: "low-water-2", title: "Low Water", format: "story", medium: "story", kind: "audio-drama", status: "in-progress", created: AT, updated: AT, failureModes: [] },
        initialSeason: null, series: { operation: "none" },
        initialContent: { worldId: FIXTURE_WORLD_ID, setupId: SETUP, revision: 4, narrative: { version: 1 }, scenes: [], episodes: [], audioDrama: { version: 1, source: { productionId: "low-water" }, plan } },
      } } });
    await answer(review, reviewed);
    const create = m.setup().at(-1)!;
    assert.deepEqual(create.action, { operation: "create", expectedRevision: 4, reviewId: REVIEW }, "and creates once the review is in");
    // Created, the pilot drafts (R-9, 230d): Arke is asked once, in the conversation that carries on.
    const created = ProductionSetupStateSchema.parse({ ...reviewed, status: "created", productionId: "low-water-2" });
    await answer(create, created);
    const asked = m.sent.filter((message): message is Extract<ClientMessage, { kind: "world-chat-send" }> => message.kind === "world-chat-send");
    assert.equal(asked.length, 1);
    assert.deepEqual([asked[0]!.conversationId, asked[0]!.text], [SETUP, "Draft the pilot scene, “The tide turns”, from chapter 1, as episode 1's script."]);
    await act(async () => { __applyEventForTest({ type: "production-setup.result", at: AT, worldId: FIXTURE_WORLD_ID, setupId: SETUP, requestId: create.requestId, state: created }); });
    assert.equal(m.sent.filter((message) => message.kind === "world-chat-send").length, 1, "never asked twice");
  });

  it("leaving the kind drops the plan and restores a frame", async () => {
    const m = await mount(inSetup(dramaSetup(2)), `/w/${FIXTURE_WORLD_ID}/productions/setup/${SETUP}`);
    await answer(m.setup()[0]!, dramaSetup(2));
    await choose(m.container.querySelector<HTMLSelectElement>(".fy-production-setup__fields select")!, "film");
    const update = m.setup().at(-1)!;
    assert.deepEqual(update.action.operation === "update" && update.action.update.fields, { kind: "film", aspect: "16:9", audioDrama: null });
  });
});

describe("a book offers Adapt… (SPEC-057 R-4)", () => {
  it("its ⋯ opens Tell a story's step two holding the book, as an audio drama", async () => {
    const container = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      __setStateForTest(withStories(), { connection: "open" });
      root!.render(<MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/p/low-water`]}><App /></MemoryRouter>);
    });
    const more = container.querySelector<HTMLButtonElement>(".fy-story-more__btn")!;
    assert.ok(more, "the book's heading carries a ⋯");
    await act(async () => more.dispatchEvent(new dom.Event("click", { bubbles: true })));
    await click(container, "Adapt…");
    assert.match(container.textContent!, /What kind of story\?/);
    assert.equal(container.querySelector<HTMLSelectElement>("select[aria-label='Adapt from']")!.value, "low-water");
    assert.ok(button(container, "Plan with Arke"));
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
    assert.match(html, /Pilot.*The tide turns · chapter 1.*Episodes/s, "the pilot stands apart: the plan names no episode for it");
    assert.doesNotMatch(html, /pilot · The tide turns/, "and it is never placed under Episode 1");
    assert.match(html, /Episodes 1–6 · not planned/, "the episodes not yet planned are one row");
    assert.match(html, /<p>Audio drama · from Low Water<\/p>/, "the hero says the count once, in the plan line (issue 1883)");
    assert.match(html, /Kept from the listener.*Ilo is alive.*until ep 5/s);
    assert.match(html, /Adapts.*Low Water/s);
    assert.doesNotMatch(html, /Day one\.|Find the spine together/, "not a book's dashboard");
    assert.doesNotMatch(html, />Chapters</, "no chapters on its rail");
    assert.doesNotMatch(html, />Generate<|>Cut</, "and nothing of a video's");
  });
});

describe("issue 1883: a new drama's way to its pilot (R-9)", () => {
  it("Start the pilot, the pilot and the not-planned row each open episode 1's script", async () => {
    for (const label of ["Start the pilot", "The tide turns · chapter 1", "Episodes 1–6 · not planned"]) {
      const container = dom.document.createElement("div") as unknown as HTMLElement;
      dom.document.body.append(container);
      root = createRoot(container);
      await act(async () => {
        __setStateForTest(withStories(), { connection: "open" });
        root!.render(<MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/p/low-water-drama`]}><App /></MemoryRouter>);
      });
      const found = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
      assert.ok(found, `${label} is offered`);
      await act(async () => found.dispatchEvent(new dom.Event("click", { bubbles: true })));
      assert.match(container.textContent!, /No script yet/, `${label} opens episode 1`);
      await act(async () => root?.unmount());
      root = null;
      container.remove();
    }
  });
});
