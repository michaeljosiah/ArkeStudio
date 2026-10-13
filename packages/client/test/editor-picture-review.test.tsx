import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { pictureAppearanceState, pictureVersionRef, type ClientMessage, type ClientState, type PictureProposalVersion, type PictureProposalFamily } from "@arke-studio/contracts";
import { usePictureReview } from "../src/lib/editor-picture-review.js";
import { useStore, __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { effectProposalFixture, effectProposalTestFence } from "./effect-proposal-fixture.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });

test("picture card arrival stays inert, explicit Review selects a version, and pending release needs fresh Review", async () => {
  const fixture = effectProposalFixture(), state = structuredClone(FIXTURE_STATE) as ClientState;
  const production = state.world!.productions[0]!, worldId = state.world!.meta.worldId;
  production.timeline = { status: "ready", timeline: fixture.timeline };
  const version: PictureProposalVersion = { id: "pv_first", number: 1, origin: "model", summary: "Lighten picture", createdAt: "2026-10-12T00:00:00Z",
    baseRevision: fixture.timeline.revision, baseHash: "base", candidateHash: "first", model: { summary: "Lighten picture", commands: [{ kind: "picture-appearance", clipId: "cl_picture", patch: { blendMode: "screen" } }] },
    sticky: [], before: pictureAppearanceState(fixture.timeline), pictures: pictureAppearanceState(fixture.timeline), conflicts: [], notes: [], dependencies: effectProposalTestFence(fixture.timeline) };
  const family: PictureProposalFamily = { id: "pictures-review", productionId: production.meta.id, conversationId: "cv_01J8G0000000000000000000C1", status: "pending", versions: [version], headVersionId: version.id, undo: [], redo: [], grants: [] };
  production.pictureFamilies = [family];
  const sent: ClientMessage[] = [];
  __setStateForTest(state); __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json: string) { sent.push(JSON.parse(json)); } });
  let latest!: ReturnType<typeof usePictureReview>;
  const active = () => latest.active;
  function Probe() { const studio = useStore(); latest = usePictureReview(worldId, studio.state?.world?.productions[0]); return null; }
  const host = document.createElement("div"), root = createRoot(host); document.body.append(host);
  try {
    await act(async () => root.render(<Probe />)); assert.equal(active(), null); assert.equal(sent.length, 0);
    const ref = pictureVersionRef(family.id, version);
    await act(async () => latest.operate({ kind: "review", ref }));
    const request = sent.at(-1)!; assert.equal(request.kind, "editor-picture-proposal"); if (request.kind !== "editor-picture-proposal") return;
    assert.equal(active(), null, "sending Review waits for the coordinator");
    const result = { type: "editor-picture.proposal-result" as const, worldId, productionId: production.meta.id, at: version.createdAt, requestId: request.requestId, outcome: "reviewed" as const, ref, reviewId: "review-first" };
    await act(async () => __applyEventForTest(result)); assert.equal(active()?.version.id, version.id); assert.equal(active()?.comparison, "suggested");
    const successor = { ...version, id: "pv_release", number: 2, candidateHash: "release", origin: "release" as const };
    const next = structuredClone(state); next.world!.productions[0]!.pictureFamilies![0]!.versions.push(successor); next.world!.productions[0]!.pictureFamilies![0]!.headVersionId = successor.id;
    await act(async () => __setStateForTest(next)); assert.equal(active()?.version.id, version.id, "arrival does not swap the reviewed version");
    await act(async () => latest.operate({ kind: "edit", ref, commands: [{ kind: "picture-release", ruleId: "vp_blend" }] }));
    const release = sent.at(-1)!; if (release.kind !== "editor-picture-proposal") throw new Error("Wrong command");
    await act(async () => __applyEventForTest({ ...result, requestId: release.requestId, outcome: "updated", ref: pictureVersionRef(family.id, successor), reviewId: undefined }));
    assert.equal(active()?.version.id, version.id); assert.match(latest.error!, /Choose Review/);
    await act(async () => latest.operate({ kind: "review", ref: pictureVersionRef(family.id, successor) }));
    const explicit = sent.at(-1)!; if (explicit.kind !== "editor-picture-proposal") throw new Error("Wrong command");
    await act(async () => __applyEventForTest({ ...result, requestId: explicit.requestId, ref: pictureVersionRef(family.id, successor), reviewId: "review-release" }));
    assert.equal(active()?.version.id, successor.id);
  } finally { await act(async () => { latest.close(); root.unmount(); }); host.remove(); __setBridgeForTest(null); }
});
