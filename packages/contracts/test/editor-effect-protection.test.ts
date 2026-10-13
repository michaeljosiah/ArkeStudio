import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultEffectClip, type EffectClip } from "../src/editor-effects.js";
import {
  assertEffectProtection, captureEffectProtectionRule, checkEffectProtection, duplicateEffectProtectionRules,
  EffectProtectionInputSchema, EffectProtectionRefused, refreshEffectProtectionRules,
  type EffectProtectedProperty, type EffectProtectionInput, type EffectProtectionRule,
} from "../src/editor-effect-protection.js";

function effect(): EffectClip {
  return defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", startFrame: 0, durationFrames: 240, seed: 37 });
}
function property(path: EffectProtectedProperty, passage?: [number, number]): EffectProtectionInput {
  return { id: "pr_property", lineageId: "ef_dust", kind: "property", property: path,
    scope: passage ? { kind: "passage", startFrame: passage[0], endFrame: passage[1] } : { kind: "whole" } };
}
function protect(input: EffectProtectionInput, before: EffectClip[] = [effect()]): EffectProtectionRule {
  return captureEffectProtectionRule(input, before, 7);
}
function change(original: EffectClip, alter: (copy: EffectClip) => void): EffectClip {
  const copy = structuredClone(original);
  alter(copy);
  return copy;
}
function split(original: EffectClip, at: number): EffectClip[] {
  return [change(original, copy => { copy.durationFrames = at - copy.startFrame; }),
    change(original, copy => { copy.id = "cl_tail"; copy.startFrame = at; copy.durationFrames = original.startFrame + original.durationFrames - at; })];
}

describe("SPEC-053 granular effect protection", () => {
  it("keeps exact boundary protection distinct from fixed passage coverage", () => {
    const before = effect(), shorter = change(before, copy => { copy.durationFrames = 216; });
    const boundary = protect({ id: "pr_end", lineageId: before.lineageId, kind: "boundary", boundary: "end" });
    const opening = protect({ id: "pr_opening", lineageId: before.lineageId, kind: "passage-coverage", startFrame: 0, endFrame: 24 });
    assert.deepEqual(checkEffectProtection([before], [shorter], [boundary]).map(item => item.code), ["boundary-changed"]);
    assert.deepEqual(checkEffectProtection([before], [shorter], [opening]), []);
    const fresh = refreshEffectProtectionRules([shorter], [opening], 8);
    assert.deepEqual(fresh, [opening]);
    const gap = split(before, 12);
    gap[1]!.startFrame = 13;
    gap[1]!.durationFrames--;
    assert.deepEqual(checkEffectProtection([before], gap, [boundary]), []);
    assert.equal(checkEffectProtection([before], gap, [opening])[0]!.code, "coverage-changed");
  });

  it("rejects passage Start/End checkboxes and invalid or extra protection fields", () => {
    assert.equal(EffectProtectionInputSchema.safeParse({ ...property("appearance.colour", [0, 24]), property: "startFrame" }).success, false);
    assert.equal(EffectProtectionInputSchema.safeParse({ id: "pr_bad", lineageId: "ef_dust", kind: "boundary", boundary: "end", startFrame: 0, endFrame: 24 }).success, false);
    assert.equal(EffectProtectionInputSchema.safeParse(property("appearance.colour", [24, 24])).success, false);
    assert.equal(EffectProtectionInputSchema.safeParse({ id: "pr_bad", lineageId: "ef_dust", kind: "passage-coverage", startFrame: 24, endFrame: 0 }).success, false);
    assert.equal(EffectProtectionInputSchema.safeParse({ ...property("appearance.colour"), human: true }).success, false);
  });

  it("protects colour independently while retaining a Release baseline after unrelated edits", () => {
    const before = effect(), rule = protect(property("appearance.colour"));
    const amount = change(before, copy => { copy.appearance.amount = 0.1; });
    assert.deepEqual(checkEffectProtection([before], [amount], [rule]), []);
    assert.deepEqual(refreshEffectProtectionRules([amount], [rule], 8), [rule]);
    const colour = change(before, copy => { copy.appearance.colour = "#0000ff"; });
    assert.equal(checkEffectProtection([before], [colour], [rule])[0]!.code, "property-changed");
    const refreshed = refreshEffectProtectionRules([colour], [rule], 8)[0]!;
    assert.equal(refreshed.baselineRevision, 8);
    assert.notEqual(refreshed.baselineFingerprint, rule.baselineFingerprint);
    assert.equal(refreshed.kind, "property");
    assert.equal(checkEffectProtection([colour], [before], [refreshed])[0]!.code, "property-changed");
  });

  it("preserves outer boundaries, curves and fingerprints across an equivalent split", () => {
    const before = effect();
    before.intensityCurve.points = [{ id: "ep_a", offsetFrames: 0, value: 0, interpolation: "smooth" },
      { id: "ep_b", offsetFrames: 240, value: 1, interpolation: "linear" }];
    const rules = [protect({ id: "pr_end", lineageId: "ef_dust", kind: "boundary", boundary: "end" }, [before]),
      protect(property("intensityCurve", [0, 200]), [before])];
    const after = split(before, 70);
    assert.deepEqual(checkEffectProtection([before], after, rules), []);
    assert.deepEqual(refreshEffectProtectionRules(after, rules, 8), rules);
  });

  it("checks smooth functions between endpoints, including a one-frame protected passage", () => {
    const before = effect();
    before.intensityCurve.points = [{ id: "ep_a", offsetFrames: 0, value: 0, interpolation: "linear" },
      { id: "ep_b", offsetFrames: 240, value: 1, interpolation: "linear" }];
    const after = change(before, copy => { copy.intensityCurve.points[0]!.interpolation = "smooth"; });
    for (const input of [property("intensityCurve", [0, 240]), property("intensityCurve", [60, 61]), property("intensityCurve")]) {
      assert.equal(checkEffectProtection([before], [after], [protect(input, [before])])[0]!.code, "property-changed");
    }
  });

  it("compares evaluated curves rather than point IDs or redundant linear knots", () => {
    const before = effect();
    before.intensityCurve.points = [{ id: "ep_a", offsetFrames: 0, value: 0, interpolation: "linear" },
      { id: "ep_b", offsetFrames: 240, value: 1, interpolation: "linear" }];
    const after = change(before, copy => { copy.intensityCurve.points.splice(1, 0, { id: "ep_middle", offsetFrames: 120, value: 0.5, interpolation: "linear" }); });
    assert.deepEqual(checkEffectProtection([before], [after], [protect(property("intensityCurve", [0, 240]), [before])]), []);
  });

  it("permits a binding change outside a protected passage while preserving its presence", () => {
    const before = effect(), after = split(before, 24), rule = protect(property("target", [0, 24]));
    after[1]!.target = { kind: "picture-track", trackId: "tr_video" };
    assert.deepEqual(checkEffectProtection([before], after, [rule]), []);
    after[0]!.durationFrames = 23;
    assert.equal(checkEffectProtection([before], after, [rule])[0]!.code, "property-changed");
  });

  it("keeps passage coordinates fixed after human moves and refreshes exact boundary baselines", () => {
    const before = effect(), after = change(before, copy => {
      copy.startFrame = 60; copy.simulationOriginFrame = 60; copy.fades.startFrame += 60; copy.fades.endFrame += 60;
    });
    const rules = [protect(property("appearance.colour", [0, 24])), protect({ id: "pr_end", lineageId: "ef_dust", kind: "boundary", boundary: "end" })];
    const fresh = refreshEffectProtectionRules([after], rules, 8);
    assert.equal(fresh[0]!.kind, "property");
    if (fresh[0]!.kind === "property") assert.deepEqual(fresh[0]!.scope, { kind: "passage", startFrame: 0, endFrame: 24 });
    assert.equal(fresh[1]!.baselineRevision, 8);
    assert.equal(checkEffectProtection([after], [before], fresh).some(conflict => conflict.code === "boundary-changed"), true);
    assert.deepEqual(checkEffectProtection([before], [after], [protect(property("appearance.colour"))]), []);
  });

  it("refuses delete, identity replacement, duplicate passage contribution and baseline forgery", () => {
    const before = effect(), rule = protect(property("appearance.colour"));
    assert.equal(checkEffectProtection([before], [], [rule])[0]!.code, "effect-removed");
    const replacement = change(before, copy => { copy.id = "cl_new"; copy.lineageId = "ef_new"; });
    assert.equal(checkEffectProtection([before], [replacement], [rule])[0]!.code, "effect-removed");
    assert.equal(checkEffectProtection([before], [before], [rule], [])[0]!.code, "rule-removed");
    assert.equal(checkEffectProtection([before], [before], [rule], [{ ...rule, baselineFingerprint: "model says allowed" }])[0]!.code, "rule-changed");
    assert.equal(checkEffectProtection([before], [before], [rule], [rule, rule])[0]!.code, "rule-changed");
    assert.equal(checkEffectProtection([before], [before], [], [rule])[0]!.code, "rule-added");
    const passage = protect(property("appearance.colour", [0, 24]));
    assert.equal(checkEffectProtection([before], [before, change(before, copy => { copy.id = "cl_duplicate"; })], [passage])[0]!.code, "property-changed");
    assert.throws(() => assertEffectProtection([before], [], [rule]), EffectProtectionRefused);
  });

  it("retires rules only for explicitly human-deleted lineages", () => {
    const rule = protect(property("appearance.colour"));
    assert.throws(() => refreshEffectProtectionRules([], [rule], 8), /explicit human deletion/);
    assert.deepEqual(refreshEffectProtectionRules([], [rule], 8, { retireLineages: ["ef_dust"] }), []);
    assert.throws(() => captureEffectProtectionRule(property("appearance.colour"), [], 8), /no longer exists/);
  });

  it("duplicates rules with a new lineage, remapped passages and new explicit boundary", () => {
    const duplicate = change(effect(), copy => {
      copy.id = "cl_copy"; copy.lineageId = "ef_copy"; copy.startFrame = 300; copy.simulationOriginFrame = 300;
      copy.fades.startFrame = 300; copy.fades.endFrame = 540; copy.seed = 48;
    });
    const rules = [protect(property("appearance.colour", [0, 24])),
      protect({ id: "pr_end", lineageId: "ef_dust", kind: "boundary", boundary: "end" }),
      protect({ id: "pr_coverage", lineageId: "ef_dust", kind: "passage-coverage", startFrame: 0, endFrame: 24 })];
    let sequence = 0;
    const copies = duplicateEffectProtectionRules(rules, "ef_dust", "ef_copy", 300, [effect(), duplicate], 8, () => `pr_copy${++sequence}`);
    assert.equal(copies.every(rule => rule.lineageId === "ef_copy" && rule.baselineRevision === 8), true);
    if (copies[0]!.kind === "property") assert.deepEqual(copies[0]!.scope, { kind: "passage", startFrame: 300, endFrame: 324 });
    if (copies[2]!.kind === "passage-coverage") assert.equal(copies[2]!.startFrame, 300);
    assert.match(copies[1]!.baselineFingerprint, /540/);
  });

  it("protects individual Advanced inputs and source without freezing other controls", () => {
    const before = effect();
    before.audioInput = { kind: "audio-track", trackId: "tr_song" };
    before.reaction.enabled = true;
    const rules = [protect(property("audioInput"), [before]), protect({ ...property("reaction.strength"), id: "pr_strength" }, [before])];
    const unprotected = change(before, copy => { copy.reaction.beat = 0.7; });
    assert.deepEqual(checkEffectProtection([before], [unprotected], rules), []);
    assert.deepEqual(refreshEffectProtectionRules([unprotected], rules, 8), rules);
    assert.equal(checkEffectProtection([before], [change(before, copy => { copy.audioInput = { kind: "composition-mix" }; })], rules)[0]!.code, "property-changed");
    assert.equal(checkEffectProtection([before], [change(before, copy => { copy.reaction.strength = 0.8; })], rules)[0]!.code, "property-changed");
  });

  it("compares fade and cue functions in the protected passage", () => {
    const before = effect();
    before.fades.inFrames = 60;
    before.cueOverrides = [{ id: "ec_beat", frame: 10, durationFrames: 10, strength: 0.5, kind: "accent" }];
    const fade = protect(property("fades.inFrames", [0, 24]), [before]);
    const cue = protect(property("cueOverrides", [0, 24]), [before]);
    assert.equal(checkEffectProtection([before], [change(before, copy => { copy.fades.startFrame = -10; })], [fade])[0]!.code, "property-changed");
    assert.equal(checkEffectProtection([before], [change(before, copy => { copy.cueOverrides[0]!.frame++; })], [cue])[0]!.code, "property-changed");
    const unrelatedFade = change(before, copy => { copy.fades.outFrames = 50; });
    assert.deepEqual(refreshEffectProtectionRules([unrelatedFade], [fade], 8), [fade]);
    assert.deepEqual(refreshEffectProtectionRules(split(before, 12), [fade, cue], 8), [fade, cue]);
    const tail = change(before, copy => { copy.startFrame = 120; copy.durationFrames = 120; });
    assert.equal(checkEffectProtection([tail], [change(tail, copy => { copy.fades.inFrames = 30; })],
      [protect(property("fades.inFrames"), [tail])])[0]!.code, "property-changed");
  });

  it("keeps whole cue protection on the production clock during an allowed move", () => {
    const before = effect();
    before.cueOverrides = [{ id: "ec_beat", frame: 10, durationFrames: 10, strength: 0.5, kind: "accent" }];
    const rule = protect(property("cueOverrides"), [before]);
    const moved = change(before, copy => { copy.startFrame += 100; copy.simulationOriginFrame += 100; copy.fades.startFrame += 100; copy.fades.endFrame += 100; });
    assert.deepEqual(checkEffectProtection([before], [moved], [rule]), []);
    assert.deepEqual(refreshEffectProtectionRules([moved], [rule], 8), [rule]);
    assert.equal(checkEffectProtection([before], [change(moved, copy => { copy.cueOverrides[0]!.frame += 100; })], [rule])[0]!.code, "property-changed");
  });

  it("treats zero fades as constant visibility while preserving authored fade duration", () => {
    const before = effect(), extended = change(before, copy => { copy.durationFrames = 300; copy.fades.endFrame = 300; });
    const whole = protect(property("fades.outFrames"));
    assert.deepEqual(checkEffectProtection([before], [extended], [whole]), []);
    assert.deepEqual(refreshEffectProtectionRules([extended], [whole], 8), [whole]);
    const passage = protect(property("fades.outFrames", [200, 240]));
    assert.deepEqual(checkEffectProtection([before], [extended], [passage]), []);
  });

  it("uses bounded knot evaluation on extremely long intervals", () => {
    const before = effect();
    before.durationFrames = 1_000_000_000;
    before.fades.endFrame = before.durationFrames;
    before.intensityCurve.points = [{ id: "ep_a", offsetFrames: 0, value: 0, interpolation: "smooth" },
      { id: "ep_b", offsetFrames: before.durationFrames, value: 1, interpolation: "linear" }];
    const rule = protect(property("intensityCurve", [0, before.durationFrames]), [before]);
    assert.deepEqual(checkEffectProtection([before], split(before, 600_000_000), [rule]), []);
  });
});
