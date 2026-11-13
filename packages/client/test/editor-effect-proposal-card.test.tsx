import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { applyTimelineCommands, createEffectProposalFamily, effectProposalFamilyView, type EffectHumanIntent, type EffectProposalVersion, type EffectVersionRef } from "@arke-studio/contracts";
import { EffectProposalCard, type EffectProposalCardProps } from "../src/components/editor-effect-proposal-card.js";
import { effectCardRef, effectPropertyDifferences } from "../src/lib/editor-effect-proposal-presentation.js";
import { appendEffectProposalTestHuman, appendEffectProposalTestModel, effectProposalFixture, effectProposalTestFence, EFFECT_REVIEW_TEST_AT } from "./effect-proposal-fixture.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; dom.document.body.replaceChildren(); });

async function mount(overrides: Partial<EffectProposalCardProps> = {}) {
  const fixture = effectProposalFixture(), events: Array<{ kind: string; ref: EffectVersionRef; intent?: EffectHumanIntent; effectId?: string }> = [];
  const props: Omit<EffectProposalCardProps, "expanded" | "onExpandedChange"> = {
    family: fixture.view, version: fixture.version, timeline: fixture.timeline, frameRate: 24, activeReview: null, busy: false, readOnly: false,
    onReview: ref => { events.push({ kind: "review", ref }); }, onIntent: (ref, intent) => { events.push({ kind: "intent", ref, intent }); },
    onInspect: (ref, effectId) => { events.push({ kind: "inspect", ref, effectId }); }, onUpdate: ref => { events.push({ kind: "update", ref }); },
    onRetry: ref => { events.push({ kind: "retry", ref }); }, onDiscard: ref => { events.push({ kind: "discard", ref }); }, ...overrides,
  };
  function Harness() { const [expanded, setExpanded] = useState(true); return <EffectProposalCard {...props} expanded={expanded} onExpandedChange={setExpanded} />; }
  const host = dom.document.createElement("div"); dom.document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<Harness />));
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label);
  const press = async (label: string) => { const found = button(label); assert.ok(found, label); assert.equal(found.disabled, false, label); await act(async () => found.click()); };
  return { ...fixture, host, events, button, press, props };
}

test("card arrival and expanded details do not review; explicit Review names the exact version", async () => {
  const view = await mount();
  assert.equal(view.events.length, 0);
  assert.match(view.host.textContent!, /Ready · not previewing/);
  assert.match(view.host.textContent!, /Visual target/); assert.match(view.host.textContent!, /Requested range/); assert.match(view.host.textContent!, /Audio reaction/);
  const existing = view.host.querySelector('[aria-label="Change Floating dust"]')!;
  assert.match(existing.textContent!, /Amount/); assert.match(existing.textContent!, /30%/); assert.match(existing.textContent!, /15%/);
  assert.equal(view.button("Inspect effect")?.disabled, true);
  assert.equal([...view.host.querySelectorAll("button")].some(button => /^(Accept|Approve|Apply)/.test(button.textContent ?? "")), false);
  await view.press("Review in timeline");
  assert.deepEqual(view.events, [{ kind: "review", ref: effectCardRef(view.view, view.version) }]);
});

test("Keep current and Exclude emit identity-scoped human decisions without generic acceptance", async () => {
  const view = await mount();
  await view.press("Keep current Amount");
  const segment = view.view.identities.segments.find(row => row.clipId === view.effect.id)!;
  assert.deepEqual(view.events[0]?.intent, { kind: "keep-current", entityId: segment.segmentId, scope: { kind: "property", property: "appearance.amount" } });
  await view.press("Exclude effect");
  const addition = view.view.identities.origins.find(row => row.kind === "addition")!;
  assert.deepEqual(view.events[1]?.intent, { kind: "exclude", originId: addition.originId });
  assert.ok(view.events.every(event => event.ref.candidateHash === view.version.candidateHash));
});

test("Protected, retained manual adjustment and Release on Apply remain distinct and scoped", async () => {
  const fixture = effectProposalFixture();
  const timeline = applyTimelineCommands(fixture.timeline, [{ kind: "effect-protect", rule: { id: "pr_colour", lineageId: fixture.effect.lineageId, kind: "property", property: "appearance.colour", scope: { kind: "whole" } } }], { effectAuthority: "human" });
  let family = createEffectProposalFamily({ id: fixture.family.id, productionId: "saltlight", conversationId: fixture.family.conversationId, scope: fixture.family.scope,
    base: timeline, timelineHash: effectProposalTestFence(timeline).base.timelineHash, baseId: "base_protected", at: EFFECT_REVIEW_TEST_AT });
  family = appendEffectProposalTestModel(family, timeline, { summary: "Quieter dust", identities: [], commands: [{ kind: "effect-patch", clipId: fixture.effect.id, patch: { appearance: { amount: .15 } } }] });
  family = appendEffectProposalTestHuman(family, timeline, { kind: "protect", rule: { id: "pr_amount", lineageId: fixture.effect.lineageId, kind: "property", property: "appearance.amount", scope: { kind: "whole" } } });
  family = appendEffectProposalTestHuman(family, timeline, { kind: "adjust", commands: [{ kind: "effect-patch", clipId: fixture.effect.id, patch: { appearance: { amount: .42 } } }] });
  family = appendEffectProposalTestHuman(family, timeline, { kind: "release", ruleId: "pr_colour" });
  const version = family.versions.at(-1)!, view = await mount({ family: effectProposalFamilyView(family), version, timeline });
  assert.match(view.host.textContent!, /Protected/); assert.match(view.host.textContent!, /Adjusted by you · retained in revisions/); assert.match(view.host.textContent!, /Release on Apply/);
  assert.match(view.host.textContent!, /Protect on Apply · 42%/);
  await view.press("Allow Arke to revise Amount");
  const decision = family.decisions.find(row => row.kind === "adjust")!;
  assert.deepEqual(view.events[0]?.intent, { kind: "permit-revision", adjustmentIds: [decision.id], scopes: [{ kind: "property", property: "appearance.amount" }] });
  await view.press("Release Amount · whole effect on Apply");
  assert.deepEqual(view.events[1]?.intent, { kind: "release", ruleId: "pr_amount" });
  assert.equal(view.events.some(event => event.kind === "review"), false, "Release asks for a new candidate without entering it");
});

test("discarded versions retain protection, decisions and release history without pending actions or instructions", async () => {
  const fixture = effectProposalFixture();
  const timeline = applyTimelineCommands(fixture.timeline, [{ kind: "effect-protect", rule: { id: "pr_end", lineageId: fixture.effect.lineageId, kind: "boundary", boundary: "end" } }], { effectAuthority: "human" });
  let family = createEffectProposalFamily({ id: fixture.family.id, productionId: "saltlight", conversationId: fixture.family.conversationId, scope: fixture.family.scope,
    base: timeline, timelineHash: effectProposalTestFence(timeline).base.timelineHash, baseId: "base_protected", at: EFFECT_REVIEW_TEST_AT });
  family = appendEffectProposalTestModel(family, timeline, { summary: "Quieter dust", identities: [], commands: [{ kind: "effect-patch", clipId: fixture.effect.id, patch: { appearance: { amount: .15 } } }] });
  family = appendEffectProposalTestHuman(family, timeline, { kind: "protect", rule: { id: "pr_amount", lineageId: fixture.effect.lineageId,
    kind: "property", property: "appearance.amount", scope: { kind: "whole" } } });
  family = appendEffectProposalTestHuman(family, timeline, { kind: "adjust", commands: [{ kind: "effect-patch", clipId: fixture.effect.id, patch: { appearance: { amount: .42 } } }] });
  family = appendEffectProposalTestHuman(family, timeline, { kind: "release", ruleId: "pr_end" });
  const version = { ...family.versions.at(-1)!, conflicts: [{ id: "recorded", kind: "scope" as const, reason: "Earlier passage could not be changed", remedies: ["Ask Arke for a corrected revision"] }],
    requestedActions: [{ kind: "release" as const, ruleId: "pr_amount", reason: "A requested Amount release" }] };
  const view = await mount({ family: { ...effectProposalFamilyView(family), status: "discarded" }, version, timeline,
    currentStale: true, dependencyStatus: "stale", statusReason: "Current changed · Update proposal", readOnly: true,
    activeReview: { ref: effectCardRef(effectProposalFamilyView(family), version), comparison: "suggested" } });
  assert.match(view.host.textContent!, /Discarded/); assert.match(view.host.textContent!, /Adjusted by you/);
  assert.match(view.host.textContent!, /Proposed protection · 42%/); assert.match(view.host.textContent!, /Proposed releases/);
  assert.match(view.host.textContent!, /Recorded preparation issues/); assert.match(view.host.textContent!, /Earlier passage could not be changed/);
  assert.match(view.host.textContent!, /A requested Amount release/);
  assert.equal(view.host.querySelector("[data-reviewing]"), null);
  assert.doesNotMatch(view.host.textContent!, /Current changed|Update proposal|Suggested is active|Editing is unavailable|Release on Apply|Protect on Apply|Ask Arke for a corrected revision|Arke is asking for your decision/);
  assert.ok([...view.host.querySelectorAll("button")].every(button => button.textContent?.endsWith("Hide details")));
  assert.deepEqual(view.events, []);
});

test("an earlier card retains its own decisions while an arriving version does not become active", async () => {
  const fixture = effectProposalFixture(), family = appendEffectProposalTestHuman(fixture.family, fixture.timeline,
    { kind: "adjust", commands: [{ kind: "effect-patch", clipId: fixture.effect.id, patch: { appearance: { amount: .42 } } }] });
  const view = await mount({ family: effectProposalFamilyView(family), version: fixture.version });
  assert.doesNotMatch(view.host.textContent!, /Adjusted by you/);
  assert.match(view.host.textContent!, /Earlier human decisions · inspection only/);
  assert.equal(view.button("Keep current effect")?.disabled, true);
  assert.equal(view.button("Review in timeline")?.disabled, false);
  assert.equal(view.events.length, 0);
  await view.press("Review in timeline");
  assert.equal(view.events[0]?.ref.versionId, fixture.version.id); assert.equal(view.events[0]?.ref.decisionRevision, family.decisionRevision);
});

test("retained adjustment rows match the compiler after a later manual edit and partial point permission", async () => {
  const fixture = effectProposalFixture();
  let family = appendEffectProposalTestHuman(fixture.family, fixture.timeline, { kind: "adjust", commands: [
    { kind: "effect-patch", clipId: fixture.effect.id, patch: { appearance: { amount: .42 } } },
  ] });
  family = appendEffectProposalTestHuman(family, fixture.timeline, { kind: "adjust", commands: [
    { kind: "effect-patch", clipId: fixture.effect.id, patch: { appearance: { amount: .55 }, intensityCurve: { points: [{ id: "ep_manual", offsetFrames: 24, value: .7, interpolation: "linear" }] } } },
  ] });
  const decision = family.decisions.filter(row => row.kind === "adjust").at(-1)!;
  const point = family.identities.points.find(row => row.authoredId === "ep_manual")!;
  family = appendEffectProposalTestHuman(family, fixture.timeline, { kind: "permit-revision", adjustmentIds: [decision.id], scopes: [
    { kind: "point", curve: "intensityCurve", entityId: point.entityId, fields: ["value"] },
  ] });
  const view = await mount({ family: effectProposalFamilyView(family), version: family.versions.at(-1)! });
  const retained = view.host.querySelector('[aria-label="Human decisions for this version"]')!;
  assert.match(retained.textContent!, /55%/); assert.doesNotMatch(retained.textContent!, /42%/);
  const permission = [...retained.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.startsWith("Allow Arke to revise Intensity point"))!;
  assert.ok(permission); assert.doesNotMatch(permission.textContent!, /value/);
  await view.press(permission.textContent!);
  const intent = view.events[0]!.intent;
  assert.equal(intent?.kind, "permit-revision");
  if (intent?.kind === "permit-revision") {
    assert.deepEqual(intent.adjustmentIds, [decision.id]);
    assert.ok(intent.scopes.every(scope => scope.kind === "point" && !scope.fields.includes("value")));
  }
});

test("retained details remain readable when Current cannot be resolved, without inventing a timeline", async () => {
  const view = await mount({ timeline: null, statusReason: "Current timeline is invalid. Restore it before editing." });
  assert.match(view.host.textContent!, /Current timeline is invalid/); assert.match(view.host.textContent!, /30%/); assert.match(view.host.textContent!, /15%/);
  assert.equal(view.button("Keep current Amount")?.disabled, true); assert.equal(view.button("Update proposal")?.disabled, true);
  await view.press("Review in timeline");
  assert.equal(view.events[0]?.kind, "review", "explicit blocked-version inspection remains a coordinator decision");
});

for (const dependencyStatus of ["checking", "stale"] as const) test(`dependency ${dependencyStatus} blocks edits while retaining explicit Review and Update`, async () => {
  const view = await mount({ dependencyStatus, ...(dependencyStatus === "stale" ? { statusReason: "The selected source changed without a timeline edit. Update this proposal." } : {}) });
  assert.match(view.host.textContent!, dependencyStatus === "checking" ? /Checking sources and render settings/ : /selected source changed without a timeline edit/);
  assert.match(view.host.textContent!, /30%/); assert.match(view.host.textContent!, /15%/);
  assert.equal(view.button("Keep current Amount")?.disabled, true); assert.equal(view.button("Exclude effect")?.disabled, true);
  assert.equal(view.button("Update proposal")?.disabled, false);
  await view.press("Review in timeline"); await view.press("Update proposal");
  assert.deepEqual(view.events.map(event => event.kind), ["review", "update"]);
});

test("exact boundary labels use all split segments of the same logical effect", async () => {
  const fixture = effectProposalFixture();
  const timeline = applyTimelineCommands(fixture.timeline, [
    { kind: "effect-protect", rule: { id: "pr_end", lineageId: fixture.effect.lineageId, kind: "boundary", boundary: "end" } },
    { kind: "effect-split", clipId: fixture.effect.id, atFrame: 120, newClipId: "cl_right" },
  ], { effectAuthority: "human" });
  let family = createEffectProposalFamily({ id: fixture.family.id, productionId: "saltlight", conversationId: fixture.family.conversationId, scope: fixture.family.scope,
    base: timeline, timelineHash: effectProposalTestFence(timeline).base.timelineHash, baseId: "base_split", at: EFFECT_REVIEW_TEST_AT });
  family = appendEffectProposalTestModel(family, timeline, { summary: "Quiet split dust", identities: [], commands: [{ kind: "effect-patch", clipId: fixture.effect.id, patch: { appearance: { amount: .15 } } }] });
  const view = await mount({ family: effectProposalFamilyView(family), version: family.versions.at(-1)!, timeline });
  const protection = view.host.querySelector('[aria-label="Preserved protection"]')!;
  assert.match(protection.textContent!, /Protected · 00:00:10:00/);
});

test("conflicted and unready versions remain inspectable, while Current comparison cannot open a pending Inspector", async () => {
  const fixture = effectProposalFixture();
  const version: EffectProposalVersion = { ...fixture.version, conflicts: [{ id: "conflict_scope", kind: "scope", reason: "Retain the earlier passage", remedies: ["Ask Arke for a corrected revision"] }],
    dependencies: { ...fixture.version.dependencies, reactions: [{ effectId: fixture.effect.id, status: "unavailable", reason: "Audio file missing" }] } };
  const view = await mount({ version, activeReview: { ref: effectCardRef(fixture.view, version), comparison: "current" } });
  assert.match(view.host.textContent!, /Retain the earlier passage/); assert.match(view.host.textContent!, /Audio file missing/);
  assert.equal(view.button("Inspect effect")?.disabled, true);
  await view.press("Retry preparation"); assert.equal(view.events[0]?.kind, "retry");
  await view.press("Review version 1 again"); assert.equal(view.events[1]?.kind, "review");
});

test("all changed curve points remain reachable, including same-count replacements and the final point", () => {
  const fixture = effectProposalFixture(), before = structuredClone(fixture.effect), after = structuredClone(fixture.effect);
  before.intensityCurve.points = Array.from({ length: 2000 }, (_, index) => ({ id: `ep_${index}`, offsetFrames: index, value: .25, interpolation: "linear" }));
  after.intensityCurve.points = before.intensityCurve.points.map(point => ({ ...point, value: .75 }));
  const rows = effectPropertyDifferences({ kind: "effect-result", trackId: "tr_effects", before, after, provenance: [] }, fixture.view, fixture.timeline, 24);
  assert.equal(rows.filter(row => row.key.startsWith("intensityCurve:")).length, 2000);
  assert.match(rows.find(row => row.key === "intensityCurve:ep_1999")!.after, /1999 frames.*75%/);
});

test("a removed Current effect can be kept", async () => {
  const fixture = effectProposalFixture(), family = appendEffectProposalTestModel(fixture.family, fixture.timeline,
    { summary: "Remove existing dust", identities: [], commands: [{ kind: "effect-remove", clipId: fixture.effect.id }] });
  const view = await mount({ family: effectProposalFamilyView(family), version: family.versions.at(-1)! });
  assert.match(view.host.querySelector('[aria-label="Remove Floating dust"]')?.textContent ?? "", /Keep current effect/);
  await view.press("Keep current effect"); assert.equal(view.events[0]?.intent?.kind, "keep-current");
});

test("an empty coherent candidate has no Apply action or invented change", async () => {
  const fixture = effectProposalFixture();
  let family = appendEffectProposalTestHuman(fixture.family, fixture.timeline, { kind: "keep-current", entityId: "segment:cl_existing", scope: { kind: "whole-effect" } });
  family = appendEffectProposalTestHuman(family, fixture.timeline, { kind: "exclude", originId: family.identities.origins.find(row => row.kind === "addition")!.originId });
  const version = family.versions.at(-1)!;
  assert.equal(version.delta.length, 0);
  const view = await mount({ family: effectProposalFamilyView(family), version });
  assert.match(view.host.textContent!, /No changes to apply/); assert.match(view.host.textContent!, /0 changes/);
  assert.equal([...view.host.querySelectorAll("button")].some(button => button.textContent?.startsWith("Apply")), false);
});
