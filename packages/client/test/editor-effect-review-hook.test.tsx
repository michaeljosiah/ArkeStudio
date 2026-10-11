import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { parseHTML } from "linkedom";
import { effectProposalFamilyView, type ClientMessage, type ClientState, type EffectReviewResult } from "@arke-studio/contracts";
import { useEffectProposalReview, useEffectReviewNavigation } from "../src/screens/editor-effect-review.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { effectProposalFixture, effectProposalTestRef, grantEffectProposalTestReview, EFFECT_REVIEW_TEST_AT } from "./effect-proposal-fixture.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
let latest: ReturnType<typeof useEffectProposalReview> | undefined;
afterEach(async () => { await act(async () => { latest?.close(); for (const root of roots.splice(0)) root.unmount(); });
  latest = undefined; document.body.replaceChildren(); __setBridgeForTest(null); });

describe("effect review transport and navigation", () => {
  it("stays inert when a conversation mounts before its world and production exist", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState; state.world = null; __setStateForTest(state);
    function Probe() { latest = useEffectProposalReview(undefined, undefined); return null; }
    const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); roots.push(root);
    await act(async () => root.render(<Probe />));
    assert.equal(latest!.active, null); assert.equal(latest!.readOnly, true);
    assert.equal(latest!.review(effectProposalTestRef(effectProposalFixture().family)), false);
  });
  it("registers before sending, waits for snapshot, and navigates only explicit Review to the actual Cut", async () => {
    const fixture = effectProposalFixture(), state = structuredClone(FIXTURE_STATE) as ClientState, production = state.world!.productions[0]!;
    production.meta.id = fixture.family.productionId; production.timeline = { status: "ready", timeline: fixture.timeline };
    production.effectFamilies = [fixture.view]; const worldId = state.world!.meta.worldId, productionId = production.meta.id;
    const sent: ClientMessage[] = []; let pathname = "";
    __setStateForTest(state); __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json: string) { sent.push(JSON.parse(json) as ClientMessage); } });
    function Probe() { latest = useEffectProposalReview(worldId, productionId); useEffectReviewNavigation(worldId, productionId);
      pathname = useLocation().pathname; return null; }
    const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); roots.push(root);
    const story = `/w/${worldId}/p/${productionId}/story`, cut = `/w/${worldId}/p/${productionId}/cut`;
    await act(async () => root.render(<MemoryRouter initialEntries={[story]}><Probe /></MemoryRouter>));
    assert.equal(pathname, story); assert.equal(latest!.active, null); assert.equal(sent.length, 0);
    await act(async () => { assert.equal(latest!.review(effectProposalTestRef(fixture.family)), true); });
    const command = sent.at(-1)!; assert.equal(command.kind, "editor-effect-proposal"); if (command.kind !== "editor-effect-proposal") return;
    const reviewed = grantEffectProposalTestReview(fixture.family);
    const response: EffectReviewResult = { type: "editor-effect.proposal-result", worldId, productionId, at: EFFECT_REVIEW_TEST_AT,
      requestId: command.requestId, outcome: "reviewed", ref: reviewed.ref, grant: reviewed.grant };
    await act(async () => __applyEventForTest(response));
    assert.equal(pathname, story); assert.equal(latest!.active, null); assert.equal(latest!.busy, true);
    const next = structuredClone(state); next.world!.productions[0]!.effectFamilies = [effectProposalFamilyView(reviewed.family)];
    await act(async () => __setStateForTest(next));
    assert.equal(pathname, cut); assert.equal(latest!.active!.version.id, fixture.version.id); assert.equal(latest!.busy, false);
    const serial = latest!.active!.activationSerial;
    await act(async () => { latest!.compare("current"); latest!.backToProposal(); });
    assert.equal(pathname, cut); assert.equal(latest!.active!.activationSerial, serial); assert.equal(sent.length, 1);
    await act(async () => { assert.equal(latest!.update(reviewed.ref), true); });
    const update = sent.at(-1)!; assert.equal(update.kind, "editor-effect-proposal"); if (update.kind !== "editor-effect-proposal") return;
    await act(async () => __applyEventForTest({ ...response, requestId: update.requestId, outcome: "refused",
      reason: "Media changed during staging. Update the proposal." }));
    assert.equal(latest!.statusReason, "Media changed during staging. Update the proposal.");
    assert.equal(latest!.apply(), false); assert.equal(latest!.active!.version.id, fixture.version.id);
    const other = { ...reviewed.ref, versionId: "other-version", candidateHash: "a".repeat(64) };
    await act(async () => { assert.equal(latest!.review(other), true); });
    const unrelated = sent.at(-1)!; if (unrelated.kind !== "editor-effect-proposal") return;
    await act(async () => __applyEventForTest({ ...response, requestId: unrelated.requestId, outcome: "refused", ref: other,
      reason: "This other card is unavailable." }));
    assert.notEqual(latest!.statusReason, "This other card is unavailable.");
    assert.equal(latest!.active!.version.id, fixture.version.id); assert.equal(latest!.active!.activationSerial, serial);
  });
});
