import assert from "node:assert/strict";
import { test } from "node:test";
import { AdultAcknowledgementSchema, AdapterSelectionsSchema, AdapterReleaseSchema, AdapterBundleSchema, AdapterDecisionSchema, AdapterActionSchema, AdapterLibraryStateSchema, adapterCombinationProblem, adapterPolicyProblem, adapterCompatibilityProblem, adapterStartingStrength } from "../src/adapters.js";

const sha = "a".repeat(64);
const release = AdapterReleaseSchema.parse({ id: "fixture", adapterId: "fixture", publisher: "Test", displayName: "Test adapter",
  source: { repository: "test/adapter", revision: "b".repeat(40), file: "test.safetensors", bytes: 12, sha256: sha },
  license: { name: "Test", url: "https://example.com/license" }, classification: "adult", baseFamily: "minimax-h3", supersedes: [],
  assessedAt: "2026-09-24T00:00:00.000Z", compatibility: [{ recipeId: "recipe", state: "unverified", reason: "Needs validation" }] });

test("bundles require exact ordered members, hashes and recipe from a trusted catalogue; strengths are tunable", () => {
  const selections = Array.from({ length: 14 }, (_, i) => ({ releaseId: `fixture-${i}`, sha256: i.toString(16).padStart(64, "0"), strength: 1 }));
  const bundle = AdapterBundleSchema.parse({ id: "test-bundle", displayName: "Test", recipeId: "recipe", status: "experimental", description: "Untested", selections });
  assert.equal(adapterCombinationProblem(selections, "recipe", [bundle]), null);
  // A tuned strength is still the bundle; each member's own pairing range bounds it elsewhere.
  assert.equal(adapterCombinationProblem(selections.map((row, i) => i ? row : { ...row, strength: 0.5 }), "recipe", [bundle]), null);
  for (const changed of [selections.slice(1), [...selections].reverse(), selections.map((row, i) => i ? row : { ...row, sha256: "f".repeat(64) })]) {
    assert.match(adapterCombinationProblem(changed, "recipe", [bundle])!, /catalogue/);
  }
  assert.match(adapterCombinationProblem(selections, "other", [bundle])!, /catalogue/);
  assert.match(adapterCombinationProblem(selections, "recipe", [])!, /catalogue/);
  assert.equal(AdapterSelectionsSchema.safeParse([...selections, { releaseId: "extra", sha256: "e".repeat(64), strength: 1 }]).success, false);
  assert.equal(AdapterSelectionsSchema.safeParse([...selections.slice(1), selections[1]]).success, false);
});

test("acknowledgement needs every explicit choice; callers cannot inject a verdict or path", () => {
  assert.equal(AdultAcknowledgementSchema.safeParse({ adultAge: true, explicitChoice: true, rightsAndConsent: false }).success, false);
  assert.equal(AdultAcknowledgementSchema.safeParse({ adultAge: true, explicitChoice: true, rightsAndConsent: true }).success, true);
  const selected = { releaseId: "fixture", sha256: sha, strength: 1 };
  assert.equal(AdapterSelectionsSchema.safeParse([selected, selected]).success, false);
  assert.equal(AdapterSelectionsSchema.safeParse([{ ...selected, path: "outside.safetensors" }]).success, false);
  assert.equal(AdapterSelectionsSchema.safeParse([{ ...selected, strength: Infinity }]).success, false);
});

test("verified pairings require measured evidence; compatibility and permission are independent", () => {
  assert.equal(AdapterReleaseSchema.safeParse({ ...release, compatibility: [{ recipeId: "recipe", state: "verified", reason: "Works" }] }).success, false);
  const on = { enabled: true, acknowledgedAt: "2026-09-24T00:00:00.000Z", acknowledgementVersion: 1 as const };
  assert.equal(adapterPolicyProblem(release, on, null, false), null, "no assessment is awaited once adult content is on");
  assert.equal(adapterCompatibilityProblem(release, "recipe", 1), "Needs validation");
  assert.match(adapterPolicyProblem(release, on, null, true)!, /Removed/);
  assert.match(adapterPolicyProblem(release, { ...on, enabled: false }, null, false)!, /off/);
  assert.match(adapterPolicyProblem(release, { ...on, acknowledgedAt: null }, null, false)!, /off/);
  assert.match(adapterPolicyProblem({ ...release, availability: "withdrawn" }, on, null, false)!, /no longer/);
  const user = { sha256: sha, decision: "disabled" as const, reason: "Disabled by the user.", policyRevision: "user", assessedAt: on.acknowledgedAt };
  assert.match(adapterPolicyProblem(release, on, user, false)!, /Disabled by the user/);
  assert.equal(adapterPolicyProblem(release, on, { ...user, decision: "removal-requested", reason: "Removal requested" }, false), "Removal requested");
  assert.equal(adapterPolicyProblem(release, on, { ...user, sha256: "c".repeat(64) }, false), null, "a decision about other bytes neither blocks nor grants");
});

test("journal records from the retired compliance assessment still parse and grant nothing", () => {
  const on = { enabled: true, acknowledgedAt: "2026-09-24T00:00:00.000Z", acknowledgementVersion: 1 as const };
  const old = AdapterDecisionSchema.parse({ sha256: sha, decision: "allowed", reason: "Compliance assessment", policyRevision: "2026-09",
    assessedAt: "2026-09-24T00:00:00.000Z", expiresAt: "2026-09-25T00:00:00.000Z" });
  assert.equal(adapterPolicyProblem(release, on, old, false), null, "an expired allow is not a renewal problem any more");
  assert.match(adapterPolicyProblem(release, { ...on, enabled: false }, old, false)!, /off/, "an old allow never overrides the acknowledgement");
  assert.equal(AdapterActionSchema.safeParse({ action: "scan" }).success, false);
  assert.equal(AdapterLibraryStateSchema.safeParse({ revision: 0, adultContent: { ...on, enabled: false, acknowledgedAt: null },
    scannerAvailable: false, entries: [], error: null }).success, false);
});

test("owner acceptance records actual coverage, bounds execution and leaves policy checks independent", () => {
  for (const generation of ["completed", "memory-blocked", "not-run"] as const) {
    const pair = { recipeId: "recipe", state: "owner-approved" as const, reason: "Owner accepted the scope",
      evidence: "Acceptance record", minStrength: 1, maxStrength: 1,
      ownerApproval: { approvedAt: "2026-09-25T00:00:00.000Z", generation } };
    const approved = AdapterReleaseSchema.parse({ ...release, compatibility: [pair] });
    assert.equal(adapterCompatibilityProblem(approved, "recipe", 1), null);
    assert.match(adapterCompatibilityProblem(approved, "recipe", 0.5)!, /strength/);
    assert.match(adapterCompatibilityProblem(approved, "other-recipe", 1)!, /does not support/);
    assert.equal(approved.compatibility[0]!.ownerApproval!.generation, generation);
    for (const missing of ["ownerApproval", "evidence", "minStrength", "maxStrength"]) {
      assert.equal(AdapterReleaseSchema.safeParse({ ...release, compatibility: [{ ...pair, [missing]: undefined }] }).success, false);
    }
    const on = { enabled: true, acknowledgedAt: "2026-09-24T00:00:00.000Z", acknowledgementVersion: 1 as const };
    assert.equal(adapterPolicyProblem(approved, on, null, false), null);
    assert.match(adapterPolicyProblem(approved, { ...on, enabled: false }, null, false)!, /off/);
  }
});

test("a recommended strength starts a new choice and must sit inside the pairing's range", () => {
  const pair = { recipeId: "recipe", state: "owner-approved" as const, reason: "Owner accepted a range", evidence: "Acceptance record",
    minStrength: 0.2, maxStrength: 1, ownerApproval: { approvedAt: "2026-09-30T00:00:00.000Z", generation: "completed" as const } };
  const ranged = AdapterReleaseSchema.parse({ ...release, compatibility: [{ ...pair, recommendedStrength: 0.7 }] });
  assert.equal(adapterStartingStrength(ranged, "recipe"), 0.7);
  assert.equal(adapterCompatibilityProblem(ranged, "recipe", 0.2), null);
  assert.equal(adapterCompatibilityProblem(ranged, "recipe", 1), null);
  assert.match(adapterCompatibilityProblem(ranged, "recipe", 0.1)!, /between 0.2 and 1/);
  assert.equal(adapterStartingStrength(AdapterReleaseSchema.parse({ ...release, compatibility: [pair] }), "recipe"), 1);
  assert.equal(adapterStartingStrength(AdapterReleaseSchema.parse({ ...release, compatibility: [{ ...pair, maxStrength: 0.5 }] }), "recipe"), 0.5);
  for (const outside of [0.1, 1.2]) {
    assert.equal(AdapterReleaseSchema.safeParse({ ...release, compatibility: [{ ...pair, recommendedStrength: outside }] }).success, false);
  }
});
