import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import type { ClientMessage, ClientState, SceneRecord, WorldBundle } from "@arke-studio/contracts";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { CharacterDialog } from "../src/screens/scene-workspace/character-dialog.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest, generatePerformance, subscribeQueueResults } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * A character in the scene (SPEC-044 R-11..R-16; T-3..T-7). Every card press commits through a
 * command or a message, so the assertions are about what was sent, not about a save.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (time: number) => void) => setTimeout(() => cb(0), 0),
});

const LINE = "the verse, under the water";
const hashOf = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const P1 = "pf_01J8E0000000000000000000P1", P2 = "pf_01J8E0000000000000000000P2";
const HASH1 = `sha256:${"1".repeat(64)}`, HASH2 = `sha256:${"2".repeat(64)}`;
const AT = "2026-09-09T10:00:00.000Z";
const target = (authoredTextHash: string) => ({ productionId: "saltlight", sceneId: "sc_04", sceneVersion: 2, shotId: "sh_12", speakerSheetId: "maren-kest", authoredTextHash });
const read = (id: string, hash: string, durationSec: number, authored = hashOf(LINE)) => ({
  id, kind: "scratch", target: target(authored), file: `sha256-${hash.slice(7)}.wav`, createdAt: AT, recordedAt: AT,
  captureAcknowledgement: { basis: "self", statementVersion: 1, at: AT },
  provenance: { schemaVersion: 1, outputHash: hash, outputTechnical: { durationSec }, qualityReport: { checks: {} } },
});

/** The fixture world with Maren's kit dressed for the dialog: two looks, a sample, two reads. */
function stateFor(options: { voice?: unknown; sceneLook?: boolean; authored?: string } = {}): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const world = state.world!;
  const kit = world.referenceKits.find((candidate) => candidate.sheetId === "maren-kest")!;
  kit.looks = [
    { id: "council-coat", file: "looks/council-coat.png", kind: "costume", prompt: "Formal council coat", acceptedAt: AT, attachedTo: { kind: "production", productionId: "saltlight" } },
    ...(options.sceneLook === false ? [] : [{ id: "wet-coat", file: "looks/wet-coat.png", kind: "costume" as const, prompt: "Wet coat", acceptedAt: AT, attachedTo: { kind: "scene" as const, productionId: "saltlight", sceneId: "sc_04" } }]),
  ];
  kit.designatedVoiceSample = { schemaVersion: 1, operationId: "00000000-0000-4000-8000-000000000009", file: `voice/sha256-${"9".repeat(64)}.wav`, designatedAt: AT, warningCodes: [], attestations: [],
    provenance: { schemaVersion: 1, outputHash: `sha256:${"9".repeat(64)}`, outputTechnical: { durationSec: 8 }, qualityReport: { checks: {} } } } as never;
  const production = world.productions.find((candidate) => candidate.meta.id === "saltlight")!;
  production.performances = [read(P1, HASH1, 3.1, options.authored), read(P2, HASH2, 2.4)] as never;
  production.performanceReview = {
    reviews: [{ requestId: "01J8E0000000000000000000R1", ts: AT, performanceId: P1, target: target(hashOf(LINE)), decision: "accept", by: "user" }],
    selections: { "sc_04/sh_12/legacy": { performanceId: P1, target: target(hashOf(LINE)), selectedAt: AT, selectedBy: "user" } },
    reviewHash: "sha256:review", selectionHash: "sha256:selection",
  } as never;
  const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
  if (options.voice !== undefined) scene.cast = { "maren-kest": { added: AT, voice: options.voice as never } };
  return state;
}

const open: Array<{ container: HTMLElement; root: Root }> = [];
afterEach(async () => {
  for (const mounted of open.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  __setBridgeForTest(null);
});

function capture(sent: ClientMessage[]): ArkeBridge {
  return { appVersion: "test", platform: "test", connect: () => {}, subscribe: () => {}, send: (json: string) => { sent.push(JSON.parse(json) as ClientMessage); } } as unknown as ArkeBridge;
}

async function mount(state: ClientState, sent: ClientMessage[] = []) {
  __setBridgeForTest(capture(sent));
  __setStateForTest(state);
  const world = state.world as WorldBundle;
  const production = world.productions.find((candidate) => candidate.meta.id === "saltlight")!;
  const scene = production.scenes.find((candidate) => candidate.id === "sc_04") as SceneRecord;
  const writes: unknown[] = [], closes = { count: 0 };
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/"]}>
        <CharacterDialog world={world} production={production} scene={scene} sheetId="maren-kest" onClose={() => { closes.count += 1; }} onWrite={(command) => { writes.push(command); return true; }} />
      </MemoryRouter>,
    );
  });
  open.push({ container, root });
  // The lines' hashes arrive a tick later; settle them before reading the Lines row.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return { container, writes, closes, sent };
}
const cards = (container: HTMLElement, row: string) =>
  [...container.querySelector(`[aria-label="${row}"]`)!.querySelectorAll(".fy-chardialog__card")].map((card) => [card.getAttribute("aria-label"), card.getAttribute("aria-pressed")]);
const card = (container: HTMLElement, label: string) => container.querySelector(`.fy-chardialog__card[aria-label="${label}"]`) as HTMLButtonElement;
const click = async (element: Element | null) => act(async () => (element as HTMLElement).click());

describe("the character dialog (SPEC-044 R-11..R-16)", () => {
  it("shows the facts, the picture in use and the three rows from the record alone (T-3, T-10)", async () => {
    const { container } = await mount(stateFor({ voice: { kind: "performance", performanceId: P1, hash: HASH1 } }));
    assert.equal(container.querySelector(".fy-chardialog")?.getAttribute("aria-label"), "Maren Kest in scene 4");
    assert.equal(container.querySelector(".fy-chardialog__facts")?.textContent, "lead · sheet v4 · speaks in shot 12 · seen in shot 12");
    assert.match(container.querySelector(".fy-chardialog__picture img")?.getAttribute("src") ?? "", /looks\/wet-coat\.png/, "the scene's look is the picture");
    assert.deepEqual(cards(container, "Look"), [["Kit · portrait", "false"], ["Formal council coat · this production", "false"], ["Wet coat · this scene", "true"], ["Add a look · Looks page", null]]);
    assert.deepEqual(cards(container, "Voice"), [["Sample · Voice page · 8.0s", "false"], ["Line 12 · read · 3.1s", "true"], ["Line 12 · new", "false"], ["Record a line · your microphone", null], ["Generate a line · Voice page", null]]);
    const line = container.querySelector(".fy-chardialog__line")!;
    assert.match(line.textContent ?? "", /shot 12.*the verse, under the water.*read · 3\.1s/);
    assert.ok(line.querySelector('[aria-label="Play shot 12"]'), "the selected read plays from its line");
    assert.doesNotMatch(container.textContent ?? "", /sha256|sh_\d+|pf_/, "no hash, route id or shot id on the dialog");
  });

  it("rings the production's look only when no scene look exists, and Kit then belongs to the production", async () => {
    const { container, sent } = await mount(stateFor({ sceneLook: false }));
    assert.deepEqual(cards(container, "Look").slice(0, 2), [["Kit · held by the production", "false"], ["Formal council coat · this production", "true"]]);
    assert.match(container.querySelector(".fy-chardialog__picture img")?.getAttribute("src") ?? "", /council-coat/);
    assert.equal(card(container, "Kit · held by the production").disabled, true, "the Looks page owns the production's attachment");
    await click(card(container, "Formal council coat · this production"));
    assert.deepEqual(sent.filter((message) => message.kind === "attach-character-look"), [], "already in use: nothing to send");
  });

  it("a generated line's confirm is a queue request, so its result reaches the sheet that asked (T-7)", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    __setStateForTest(stateFor());
    const results: string[] = [];
    const off = subscribeQueueResults((result) => { results.push(result.requestId); });
    const requestId = generatePerformance({ worldId: FIXTURE_WORLD_ID, operationId: "00000000-0000-4000-8000-000000000001", confirmedMicroUsd: 20 });
    assert.ok(requestId, "sent");
    assert.equal(sent.at(-1)?.kind, "generate-performance");
    await act(async () => {
      __applyEventForTest({ at: AT, type: "queue.enqueue-result", requestId, command: "generate-performance", disposition: "accepted", requestedCount: 1, acceptedJobIds: [], failures: [] } as never);
    });
    off();
    assert.deepEqual(results, [requestId]);
  });

  it("presses commit: a look attaches to this scene, Kit detaches, a voice card writes the cast, new accepts and chooses, Remove clears (T-4, T-5, T-7)", async () => {
    const { container, writes, closes, sent } = await mount(stateFor({ voice: { kind: "sample" } }));
    // A production look is let through by detaching this scene's own, never moved here (R-12).
    await click(card(container, "Formal council coat · this production"));
    assert.deepEqual(sent.at(-1), { kind: "attach-character-look", worldId: FIXTURE_WORLD_ID, sheetId: "maren-kest", lookId: "wet-coat", scope: null });
    sent.length = 0;
    await click(card(container, "Kit · portrait"));
    assert.deepEqual(sent.at(-1), { kind: "attach-character-look", worldId: FIXTURE_WORLD_ID, sheetId: "maren-kest", lookId: "wet-coat", scope: null });
    await click(card(container, "Line 12 · read · 3.1s"));
    assert.deepEqual(writes.at(-1), { kind: "edit-scene", cast: { "maren-kest": { added: AT, voice: { kind: "performance", performanceId: P1, hash: HASH1 } } } });
    await click(card(container, "Sample · Voice page · 8.0s"));
    assert.deepEqual(writes.at(-1), { kind: "edit-scene", cast: { "maren-kest": { added: AT, voice: { kind: "sample" } } } });
    await click(card(container, "Line 12 · new"));
    const review = sent.at(-1);
    assert.ok(review && review.kind === "review-performance");
    assert.deepEqual({ ...review, requestId: "r" }, { kind: "review-performance", requestId: "r", worldId: FIXTURE_WORLD_ID, productionId: "saltlight", performanceId: P2, decision: "accept",
      expectedReviewHash: "sha256:review", expectedSelectionHash: "sha256:selection", select: true, expectedSceneVersion: 2 });
    await click([...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Remove from scene") ?? null);
    assert.deepEqual(writes.at(-1), { kind: "edit-scene", cast: { "maren-kest": null } });
    assert.equal(closes.count, 1);
  });

  it("says a stale choice as read missing with the sample riding, and a moved line as earlier wording (T-6, R-10, R-16)", async () => {
    const { container } = await mount(stateFor({ voice: { kind: "performance", performanceId: P1, hash: `sha256:${"f".repeat(64)}` }, authored: `sha256:${"0".repeat(64)}` }));
    assert.deepEqual(cards(container, "Voice")[1], ["read missing · the sample rides", "true"]);
    assert.equal(card(container, "read missing · the sample rides").disabled, true, "the next press on another card replaces it");
    assert.match(container.querySelector(".fy-chardialog__line")?.textContent ?? "", /read · earlier wording/);
    assert.ok(!cards(container, "Voice").some(([label]) => label === "Line 12 · read · 3.1s"), "a read of earlier wording is not offered as the voice");
  });

  it("closes on Done and on Escape, with nothing to save; a member with nothing chosen here cannot be removed (R-9, R-11)", async () => {
    const { container, closes, writes } = await mount(stateFor({ sceneLook: false }));
    const remove = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Remove from scene") as HTMLButtonElement;
    assert.equal(remove.disabled, true, "cited by a shot, no entry and no scene look: nothing to remove");
    await click([...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Done") ?? null);
    assert.equal(closes.count, 1);
    await act(async () => { container.querySelector(".fy-chardialog")!.dispatchEvent(new dom.window.Event("cancel", { bubbles: false, cancelable: true })); });
    assert.equal(closes.count, 2);
    assert.deepEqual(writes, []);
  });
});
