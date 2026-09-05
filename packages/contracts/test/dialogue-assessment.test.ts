import assert from "node:assert/strict";
import { it } from "node:test";
import { assessDialogueShot, dialogueShotFacts, ModelDialogueGuidanceSchema, ShotSchema, TakeDialogueFeedbackSchema } from "../src/index.js";

const shot = ShotSchema.parse({ id: "sh_1", number: 1, title: "Dialogue", description: "@speaker @listener", audio: { kind: "dialogue", speaker: "speaker", line: "Hello" } });
const facts = dialogueShotFacts(shot, ["speaker", "listener"], { frameMode: "reference-image", audioIntent: "voice-reference", shotDurationSec: 5, audioDurationSec: null });
const guidance = ModelDialogueGuidanceSchema.parse({ schemaVersion: 1, id: "fixture-two-faces", revision: 1, modelId: "fixture", providerRoute: "fixture/reference", endpointVersion: "v1",
  reviewedAt: "2026-09-01T00:00:00Z", classification: "provider-guidance", when: { minAuthoredPresentedFaces: 2 }, message: "Fixture evidence only", actions: ["keep-current"],
  evidence: { url: "https://example.com/fixture", title: "Test fixture, not shipped guidance", accessedAt: "2026-09-01T00:00:00Z" } });
const input = { engineVersion: 1, manifestVersion: 1, modelId: "fixture", providerRoute: "fixture/reference", endpointVersion: "v1", now: "2026-09-05T00:00:00Z",
  facts, guidance: [guidance], hardBlocks: [{ code: "fixture", message: "Existing hard block" }], acknowledgedRecommendationIds: [] as string[] };

it("citations and empty guidance never invent visual evidence; explicit facts match exact current evidence", () => {
  const absent = assessDialogueShot(input);
  assert.equal(absent.assessment.recommendations.length, 0);
  assert.equal(absent.assessment.ignoredGuidance[0]?.reason, "visual-facts-unavailable");
  assert.deepEqual(absent.blockers, input.hardBlocks);
  const authored = { ...shot, visualFacts: { confirmedAt: input.now, composition: "two-shot" as const, onScreenCharacters: [
    { characterId: "speaker", presentation: "face-front" as const, depth: "midground" as const },
    { characterId: "listener", presentation: "face-profile" as const, depth: "foreground" as const }] } };
  const explicit = dialogueShotFacts(authored, [], facts);
  const first = assessDialogueShot({ ...input, facts: explicit }).assessment;
  assert.equal(first.recommendations.length, 1);
  const id = first.recommendations[0]!.id;
  assert.deepEqual(assessDialogueShot({ ...input, facts: explicit, now: "2026-09-06T00:00:00Z", acknowledgedRecommendationIds: [id, id] }).assessment.acknowledgedRecommendationIds, [id]);
  assert.equal(assessDialogueShot({ ...input, facts: { ...explicit, audioIntent: "performance-sync" }, acknowledgedRecommendationIds: [id] }).assessment.acknowledgedRecommendationIds.length, 0);
  assert.equal(assessDialogueShot({ ...input, facts: explicit, guidance: [] }).assessment.recommendations.length, 0);
  assert.equal(assessDialogueShot({ ...input, facts: explicit, endpointVersion: "v2" }).assessment.ignoredGuidance[0]?.reason, "endpoint-version-mismatch");
  assert.equal(assessDialogueShot({ ...input, facts: explicit, guidance: [{ ...guidance, expiresAt: input.now }] }).assessment.ignoredGuidance[0]?.reason, "expired");
  authored.visualFacts.onScreenCharacters[1] = { characterId: "listener", presentation: "turned-away", depth: "foreground" } as never;
  assert.equal(assessDialogueShot({ ...input, facts: dialogueShotFacts(authored, [], facts) }).assessment.recommendations.length, 0);
});

it("evidence, predicate and diagnostic schemas refuse invented validation and duplicate tags", () => {
  assert.equal(ModelDialogueGuidanceSchema.safeParse({ ...guidance, when: {} }).success, false);
  assert.equal(ModelDialogueGuidanceSchema.safeParse({ ...guidance, classification: "validated-warning" }).success, false);
  assert.equal(ShotSchema.safeParse({ ...shot, visualFacts: { composition: "single", confirmedAt: input.now, onScreenCharacters: [
    { characterId: "speaker", presentation: "unknown", depth: "midground" }, { characterId: "speaker", presentation: "unknown", depth: "midground" }] } }).success, false);
  assert.equal(TakeDialogueFeedbackSchema.safeParse({ schemaVersion: 1, kind: "dialogue-diagnostic", ts: input.now, takeId: "tk_01J8E0000000000000000000P1", shotId: shot.id,
    tags: ["audio-ignored", "audio-ignored"], recommendationIds: [], by: "user" }).success, false);
});
