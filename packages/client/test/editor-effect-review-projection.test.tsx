import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { buildRenderPlan, defaultExportPreset } from "@arke-studio/contracts";
import { useEffectReviewProjection } from "../src/screens/editor-effect-review-projection.js";
import type { ActiveEffectReview } from "../src/lib/editor-effect-review-state.js";
import { effectArrangementFixture } from "./effect-arrangement-fixture.js";
import { effectProposalFixture, grantEffectProposalTestReview } from "./effect-proposal-fixture.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount(); }); document.body.replaceChildren(); });

function reviewed(): ActiveEffectReview {
  const fixture = effectProposalFixture(), { grant, ref } = grantEffectProposalTestReview(fixture.family);
  return { ref, grant, family: fixture.view, version: fixture.version, comparison: "suggested", position: null,
    authoringEpoch: 1, activationSerial: 1 };
}
async function harness() {
  let result!: ReturnType<typeof useEffectReviewProjection>;
  function Probe(props: Parameters<typeof useEffectReviewProjection>[0]) { result = useEffectReviewProjection(props); return null; }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); roots.push(root);
  return async (props: Parameters<typeof useEffectReviewProjection>[0]) => { await act(async () => root.render(<Probe {...props} />)); return result; };
}

test("review projects only effects, retains canonical audio/delivery, and freezes only Suggested reaction", async () => {
  const { context } = effectArrangementFixture(), { production, timeline, artifacts, worldId } = context;
  production.cut = { ...production.cut, overlays: [] };
  production.timeline = { status: "ready", timeline };
  const planned = buildRenderPlan({ production, artifacts, timeline: production.timeline,
    scope: { kind: "production" }, preset: defaultExportPreset(production.meta) });
  assert.ok(planned.ok); const canonical = planned.plan, before = JSON.stringify({ production, artifacts });
  const render = await harness(), inputs = { worldId, production, artifacts, current: timeline, canonical, frameRate: 24 as const };
  const ordinary = await render({ ...inputs, active: null });
  assert.equal(ordinary.plan, canonical); assert.equal(ordinary.timeline, timeline); assert.equal(ordinary.context?.frozen, undefined);
  const active = reviewed(), pending = await render({ ...inputs, active });
  assert.ok(pending.plan?.effectRender); assert.equal(pending.plan.audio, canonical.audio);
  assert.equal(pending.plan.items, canonical.items); assert.equal(pending.plan.subtitles, canonical.subtitles);
  assert.equal(pending.plan.totalSec, canonical.totalSec); assert.equal(pending.plan.range, canonical.range);
  assert.equal(pending.context?.frozen?.dependencies, active.version.dependencies);
  assert.equal(pending.context?.frozen?.ref, active.ref);
  const tick = await render({ ...inputs, active: { ...active, position: { playheadFrame: 99 } } });
  assert.equal(tick.plan, pending.plan, "playhead reports cannot rebuild the preview or soundtrack");
  const current = await render({ ...inputs, active: { ...active, comparison: "current" } });
  assert.equal(current.plan, canonical); assert.equal(current.context?.frozen, undefined);
  const stale = await render({ ...inputs, active, staleReason: "The accepted picture changed. Update proposal." });
  assert.match(stale.context!.frozen!.staleReason!, /accepted picture changed/);
  assert.equal(JSON.stringify({ production, artifacts }), before, "projection never writes Current or its history");
});

test("review can project an unopened song and its migrated pictures without materialising Current", async () => {
  const { context } = effectArrangementFixture(), { production, artifacts, worldId } = context;
  production.timeline = { status: "absent" };
  production.cut.overlays = [{ id: "ov_01J8G000000000000000000001", artifactId: "ar_still", startSec: 1.5, endSec: 4, lane: 1, audio: "keep" }];
  const scene = production.scenes[0]!;
  assert.ok("shots" in scene);
  production.spine = { schemaVersion: 1, revision: 1, trackArtifactId: "ar_audio", markers: [],
    anchors: { [scene.shots[0]!.id]: { startSec: 2, endSec: 5, clipAudio: { mode: "mute" } } }, updatedAt: "2026-10-11T00:00:00.000Z" };
  const before = JSON.stringify(production), render = await harness();
  const inputs = { worldId, production, artifacts, current: null, canonical: null, frameRate: 24 as const };
  assert.equal((await render({ ...inputs, active: null })).canonicalPlan, null);
  const active = reviewed(), pending = await render({ ...inputs, active });
  assert.ok(pending.canonicalPlan); assert.ok(pending.plan?.effectRender);
  assert.ok(pending.timeline?.tracks.some(track => track.id === "tr_lane-1"), "legacy picture placements join the same review base");
  const current = await render({ ...inputs, active: { ...active, comparison: "current" } });
  assert.equal(current.plan, pending.canonicalPlan);
  assert.equal(current.plan!.audio, pending.plan.audio);
  assert.equal(JSON.stringify(production), before);
});
