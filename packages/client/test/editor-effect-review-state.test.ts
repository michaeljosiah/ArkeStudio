import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { effectProposalFamilyView, type EffectProposalFamily, type EffectReviewResult } from "@arke-studio/contracts";
import { EffectReviewSession, parseEffectReviewSavedState, type EffectReviewSavedState } from "../src/lib/editor-effect-review-state.js";
import { appendEffectProposalTestHuman, appendEffectProposalTestModel, effectProposalFixture,
  effectProposalTestRef, grantEffectProposalTestReview, EFFECT_REVIEW_TEST_AT } from "./effect-proposal-fixture.js";

function result(requestId: string, values: Partial<EffectReviewResult>): EffectReviewResult {
  return { type: "editor-effect.proposal-result", worldId: "01J8G000000000000000000000", productionId: "saltlight",
    at: EFFECT_REVIEW_TEST_AT, requestId, outcome: "reviewed", ...values };
}
function review(session: EffectReviewSession, family: EffectProposalFamily, requestId = "review") {
  const reviewed = grantEffectProposalTestReview(family);
  session.observe([effectProposalFamilyView(reviewed.family)], 0);
  assert.equal(session.begin(requestId, { kind: "review", ref: reviewed.ref }), true);
  session.receive(result(requestId, { ref: reviewed.ref, grant: reviewed.grant }));
  assert.equal(session.getSnapshot().active?.version.id, reviewed.ref.versionId);
  return reviewed.family;
}
describe("explicit effect review state (SPEC-053 R-29–38)", () => {
  it("ignores arrival, unsolicited results and new versions while another version is reviewed", () => {
    const fixture = effectProposalFixture(), session = new EffectReviewSession();
    session.observe([fixture.view], 0);
    const grant = grantEffectProposalTestReview(fixture.family);
    session.receive(result("other-window", { ref: grant.ref, grant: grant.grant }));
    assert.equal(session.getSnapshot().active, null);
    const family = review(session, fixture.family);
    const revised = appendEffectProposalTestModel(family, fixture.timeline, { summary: "Less busy", identities: [], commands: [
      { kind: "effect-patch", clipId: fixture.effect.id, patch: { appearance: { size: 0.2 } } }] });
    session.observe([effectProposalFamilyView(revised)], 0);
    assert.equal(session.getSnapshot().active!.version.id, fixture.version.id);
    assert.equal(session.getSnapshot().active!.activationSerial, 1);
  });
  it("waits for the exact response-before-snapshot candidate and grant", () => {
    const fixture = effectProposalFixture(), activations: string[] = [];
    const session = new EffectReviewSession(() => {}, null, active => activations.push(active.version.id));
    session.observe([fixture.view], 0);
    const reviewed = grantEffectProposalTestReview(fixture.family);
    session.begin("review", { kind: "review", ref: reviewed.ref });
    session.receive(result("review", { ref: reviewed.ref, grant: reviewed.grant }));
    assert.equal(session.getSnapshot().active, null); assert.ok(session.getSnapshot().pending);
    session.observe([fixture.view], 0);
    assert.equal(session.getSnapshot().active, null);
    session.observe([effectProposalFamilyView(reviewed.family)], 0);
    assert.equal(session.getSnapshot().active!.version.id, fixture.version.id);
    assert.equal(session.getSnapshot().pending, null); assert.deepEqual(activations, [fixture.version.id]);
  });
  it("continues an authenticated pending adjustment without navigating or changing comparison/position", () => {
    const fixture = effectProposalFixture(), session = new EffectReviewSession();
    const family = review(session, fixture.family);
    session.compare("current"); session.rememberPosition({ selectedEffectId: fixture.effect.id, playheadFrame: 125, scrollLeft: 80 });
    const before = session.getSnapshot().active!;
    const intent = { kind: "adjust" as const, commands: [{ kind: "effect-patch" as const, clipId: fixture.effect.id, patch: { appearance: { amount: 0.24 } } }] };
    const adjusted = grantEffectProposalTestReview(appendEffectProposalTestHuman(family, fixture.timeline, intent));
    session.begin("adjust", { kind: "edit", ref: before.ref, intent, reviewId: before.grant.id });
    session.receive(result("adjust", { outcome: "updated", ref: adjusted.ref, grant: adjusted.grant }));
    session.observe([effectProposalFamilyView(adjusted.family)], 0);
    const active = session.getSnapshot().active!;
    assert.equal(active.version.id, adjusted.ref.versionId); assert.equal(active.comparison, "current");
    assert.deepEqual(active.position, before.position); assert.equal(active.activationSerial, before.activationSerial);
    assert.ok(active.authoringEpoch > before.authoringEpoch); assert.equal(session.getSnapshot().canUndo, true);
  });
  it("never follows Release, Update or Retry even if a result supplies a grant", () => {
    for (const kind of ["release", "update", "retry"] as const) {
      const fixture = effectProposalFixture(), session = new EffectReviewSession(), family = review(session, fixture.family);
      const active = session.getSnapshot().active!;
      const revised = grantEffectProposalTestReview(appendEffectProposalTestHuman(family, fixture.timeline, { kind: "adjust", commands: [
        { kind: "effect-patch", clipId: fixture.effect.id, patch: { appearance: { amount: 0.24 } } }] }));
      session.begin(kind, kind === "release" ? { kind: "edit", ref: active.ref, intent: { kind: "release", ruleId: "pr_colour" }, reviewId: active.grant.id }
        : { kind, ref: active.ref });
      session.receive(result(kind, { outcome: "updated", ref: revised.ref, grant: revised.grant }));
      session.observe([effectProposalFamilyView(revised.family)], 0);
      assert.equal(session.getSnapshot().active!.version.id, fixture.version.id, kind);
      assert.match(session.getSnapshot().statusReason!, /Human decisions changed/);
    }
  });
  it("follows pending history only when its request names the active review grant", () => {
    for (const valid of [false, true]) {
      const fixture = effectProposalFixture(), session = new EffectReviewSession(), family = review(session, fixture.family);
      const active = session.getSnapshot().active!;
      const revised = grantEffectProposalTestReview(appendEffectProposalTestHuman(family, fixture.timeline, { kind: "adjust", commands: [
        { kind: "effect-patch", clipId: fixture.effect.id, patch: { appearance: { amount: 0.24 } } }] }));
      session.begin("undo", { kind: "history", ref: active.ref, direction: "undo", reviewId: valid ? active.grant.id : "foreign-review" });
      session.observe([effectProposalFamilyView(revised.family)], 0);
      session.receive(result("undo", { outcome: "updated", ref: revised.ref, grant: revised.grant }));
      assert.equal(session.getSnapshot().active!.version.id, valid ? revised.ref.versionId : fixture.version.id);
    }
  });
  it("restores only the persisted exact reviewed reference without an activation signal", () => {
    const fixture = effectProposalFixture(); let saved: EffectReviewSavedState | null = null;
    const session = new EffectReviewSession(value => { saved = value; });
    const family = review(session, fixture.family); session.rememberPosition({ selectedEffectId: fixture.effect.id, playheadFrame: 83 });
    assert.ok(saved);
    const restored = new EffectReviewSession(() => {}, parseEffectReviewSavedState(JSON.stringify(saved)), () => assert.fail("restore cannot navigate"));
    restored.observe([effectProposalFamilyView(family)], 0);
    assert.equal(restored.getSnapshot().active!.version.id, fixture.version.id);
    assert.equal(restored.getSnapshot().active!.position!.playheadFrame, 83); assert.equal(restored.getSnapshot().active!.activationSerial, 0);
    const unreviewed = new EffectReviewSession(() => {}, parseEffectReviewSavedState(JSON.stringify(saved)));
    unreviewed.observe([fixture.view], 0); assert.equal(unreviewed.getSnapshot().active, null);
    assert.equal(parseEffectReviewSavedState("{"), null);
  });
  it("retains older inspection but refuses application after a newer manual decision", () => {
    const fixture = effectProposalFixture();
    const changed = appendEffectProposalTestHuman(fixture.family, fixture.timeline, { kind: "adjust", commands: [
      { kind: "effect-patch", clipId: fixture.effect.id, patch: { appearance: { amount: 0.24 } } }] });
    const older = grantEffectProposalTestReview(changed, fixture.version);
    assert.notEqual(older.ref.decisionRevision, older.grant.decisionRevision);
    const session = new EffectReviewSession(); session.observe([effectProposalFamilyView(older.family)], 0);
    session.begin("older", { kind: "review", ref: older.ref }); session.receive(result("older", { ref: older.ref, grant: older.grant }));
    assert.equal(session.getSnapshot().active!.version.id, fixture.version.id); assert.match(session.getSnapshot().statusReason!, /Human decisions changed/);
    assert.equal(session.getSnapshot().canUndo, false);
  });
  it("does not activate a late result after Close or accept another candidate under a request ID", () => {
    const fixture = effectProposalFixture(), reviewed = grantEffectProposalTestReview(fixture.family), session = new EffectReviewSession();
    session.observe([effectProposalFamilyView(reviewed.family)], 0);
    session.begin("review", { kind: "review", ref: reviewed.ref }); session.close();
    session.receive(result("review", { ref: reviewed.ref, grant: reviewed.grant })); assert.equal(session.getSnapshot().active, null);
    session.begin("review2", { kind: "review", ref: reviewed.ref });
    session.receive(result("review2", { ref: { ...reviewed.ref, versionId: "another-version" }, grant: reviewed.grant }));
    assert.equal(session.getSnapshot().active, null);
  });
  it("scopes Inspector and Back signals to the reviewed candidate and preserves refusal reasons", () => {
    const fixture = effectProposalFixture(), session = new EffectReviewSession();
    assert.equal(session.inspect(effectProposalTestRef(fixture.family), fixture.effect.id), false);
    review(session, fixture.family); const active = session.getSnapshot().active!;
    assert.equal(session.inspect(active.ref, fixture.effect.id), true);
    session.backToProposal(); assert.deepEqual(session.getSnapshot().cardFocus!.ref, active.ref);
    session.begin("failed", { kind: "retry", ref: active.ref }); session.receive(result("failed", { outcome: "refused", reason: "World is read-only" }));
    assert.equal(session.getSnapshot().active!.version.id, active.version.id);
    assert.equal(session.getSnapshot().error!.requestId, "failed"); assert.equal(session.getSnapshot().error!.reason, "World is read-only");
    const epoch = active.authoringEpoch; session.observe([active.family], 1);
    assert.ok(session.getSnapshot().active!.authoringEpoch > epoch); assert.match(session.getSnapshot().statusReason!, /Current changed/);
  });
});
