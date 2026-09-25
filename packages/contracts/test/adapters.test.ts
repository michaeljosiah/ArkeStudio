import assert from "node:assert/strict";
import { test } from "node:test";
import { AdultAcknowledgementSchema, AdapterSelectionsSchema, AdapterReleaseSchema, adapterPolicyProblem, adapterCompatibilityProblem } from "../src/adapters.js";

const sha = "a".repeat(64);
const release = AdapterReleaseSchema.parse({ id: "fixture", adapterId: "fixture", publisher: "Test", displayName: "Test adapter",
  source: { repository: "test/adapter", revision: "b".repeat(40), file: "test.safetensors", bytes: 12, sha256: sha },
  license: { name: "Test", url: "https://example.com/license" }, classification: "adult", baseFamily: "minimax-h3", supersedes: [],
  assessedAt: "2026-09-24T00:00:00.000Z", compatibility: [{ recipeId: "recipe", state: "unverified", reason: "Needs validation" }] });

test("acknowledgement needs every explicit choice; callers cannot inject a verdict or path", () => {
  assert.equal(AdultAcknowledgementSchema.safeParse({ adultAge: true, explicitChoice: true, rightsAndConsent: false }).success, false);
  assert.equal(AdultAcknowledgementSchema.safeParse({ adultAge: true, explicitChoice: true, rightsAndConsent: true }).success, true);
  const selected = { releaseId: "fixture", sha256: sha, strength: 1 };
  assert.equal(AdapterSelectionsSchema.safeParse([selected, selected]).success, false);
  assert.equal(AdapterSelectionsSchema.safeParse([{ ...selected, path: "outside.safetensors" }]).success, false);
  assert.equal(AdapterSelectionsSchema.safeParse([{ ...selected, strength: Infinity }]).success, false);
});

test("verified pairings require measured evidence; compatibility and compliance are independent", () => {
  assert.equal(AdapterReleaseSchema.safeParse({ ...release, compatibility: [{ recipeId: "recipe", state: "verified", reason: "Works" }] }).success, false);
  const on = { enabled: true, acknowledgedAt: "2026-09-24T00:00:00.000Z", acknowledgementVersion: 1 as const };
  const allowed = { sha256: sha, decision: "allowed" as const, reason: "Reviewed", policyRevision: "1", assessedAt: on.acknowledgedAt };
  assert.equal(adapterPolicyProblem(release, on, allowed, false, "2026-09-24T01:00:00.000Z"), null);
  assert.equal(adapterCompatibilityProblem(release, "recipe", 1), "Needs validation");
  assert.match(adapterPolicyProblem(release, on, allowed, true, "2026-09-24T01:00:00.000Z")!, /Removed/);
  assert.match(adapterPolicyProblem(release, { ...on, enabled: false }, allowed, false, "2026-09-24T01:00:00.000Z")!, /off/);
  assert.match(adapterPolicyProblem(release, on, { ...allowed, expiresAt: "2026-09-24T00:30:00.000Z" }, false, "2026-09-24T01:00:00.000Z")!, /renewal/);
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
    assert.match(adapterPolicyProblem(approved, on, null, false, "2026-09-25T01:00:00.000Z")!, /Awaiting compliance/);
    assert.match(adapterPolicyProblem(approved, { ...on, enabled: false }, null, false, "2026-09-25T01:00:00.000Z")!, /off/);
  }
});
