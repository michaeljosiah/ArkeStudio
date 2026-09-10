import assert from "node:assert/strict";
import { it } from "node:test";
import { AudioUseRequestSchema, castVoiceRequests, characterAudioRoute, planCharacterAudio, type FrozenPerformanceAudio } from "../src/audio-reference.js";
import type { ManifestModel, ProductionBundle, SceneRecord } from "../src/index.js";

it("voice guidance and performance sync enforce distinct source authorities", () => {
  const hash = `sha256:${"a".repeat(64)}`;
  const sample = { kind: "character-sample", sheetId: "maren-kest", hash };
  const slice = { kind: "master-slice", sliceId: "slice-1", hash };
  assert.ok(AudioUseRequestSchema.safeParse({ intent: "voice-reference", source: sample }).success);
  assert.equal(AudioUseRequestSchema.safeParse({ intent: "performance-sync", source: sample }).success, false);
  assert.ok(AudioUseRequestSchema.safeParse({ intent: "performance-sync", source: slice }).success);
  assert.equal(AudioUseRequestSchema.safeParse({ intent: "voice-reference", source: slice }).success, false);
  assert.equal(AudioUseRequestSchema.safeParse({ intent: "exact-dialogue", source: sample }).success, false);
});
it("verified voice guidance routes retain truthful limits and effects", () => {
  for (const id of ["seedance-2.0", "seedance-2.0-fast"]) {
    const route = characterAudioRoute({ provider: "fal", id })!;
    assert.equal(route.endpoint, id === "seedance-2.0-fast" ? "bytedance/seedance-2.0/fast/reference-to-video" : "bytedance/seedance-2.0/reference-to-video");
    assert.equal(route.maxFiles, 3); assert.equal(route.maxTotalDurationSec, 15);
    assert.equal(route.maxCombinedReferences, 12);
    assert.equal(route.maxImages, 9); assert.equal(route.maxBytesPerFile, 15_000_000);
    assert.equal(route.effects.suppliedAudioPreserved, false);
    assert.equal(route.effects.generatedAudio, true);
    assert.equal(characterAudioRoute({ provider: "fal", id }, "first-frame"), null);
    assert.equal(characterAudioRoute({ provider: "fal", id }, "continue"), null);
  }
  assert.equal(characterAudioRoute({ provider: "fal", id: "seedance-2.5" }), null);
});

/* A read chosen on the scene's cast rides in every pass where its character speaks and in none
   where they do not (SPEC-044 R-27), and a route with no audio takes no read without refusing. */
const SPEAKING = { id: "sh_1", number: 1, title: "One", description: "a", audio: { kind: "dialogue", speaker: "maren-kest" } };
const SILENT = { id: "sh_2", number: 2, title: "Two", description: "b", audio: { kind: "sfx" } };
const SCENE = { id: "sc_1", number: 1, slug: "s", title: "S", status: "draft", version: 3, shots: [SPEAKING, SILENT] } as unknown as SceneRecord;
const SHEETS = [{ id: "maren-kest", type: "character", name: "Maren Kest", version: 1 }] as never;
const HASH = `sha256:${"b".repeat(64)}`;
const RECORD = { id: "pf_01J8E0000000000000000000P1", kind: "scratch", target: { productionId: "saltlight", sceneId: "sc_1", shotId: "sh_1", sceneVersion: 2, speakerSheetId: "maren-kest", authoredTextHash: HASH },
  provenance: { outputHash: HASH, outputTechnical: { sizeBytes: 1000, durationSec: 1 }, qualityReport: { checks: { level: { outcome: "warning", code: "audio-level-low" } } } },
  attestations: [{ kind: "single-speaker", audioHash: HASH }, { kind: "no-music", audioHash: HASH }], cloudBasis: "self" };
const production = (overrides: Record<string, unknown> = {}) => ({ performances: [RECORD], performanceReview: { reviews: [{ performanceId: RECORD.id, decision: "accept", ts: "2026-09-09T10:00:00.000Z" }], selections: {} }, ...overrides }) as unknown as ProductionBundle;
const castScene = (voice: unknown) => ({ ...SCENE, cast: { "maren-kest": { voice } } }) as SceneRecord;
const model = (id: string) => ({ id, provider: "fal", capability: "video" }) as unknown as ManifestModel;
const READ = { intent: "voice-reference", sheetId: "maren-kest", characterName: "Maren Kest", label: "@Audio1", performance: RECORD, acceptedReviewAt: "2026-09-09T10:00:00.000Z",
  warningCodes: [], attestations: [], acknowledgementId: "x", source: "scene-cast" } as unknown as FrozenPerformanceAudio;

it("a scene-cast read rides where its character speaks, stays out where nobody does, and yields to a route with no audio", () => {
  const rides = planCharacterAudio({ scene: SCENE, shots: [SPEAKING as never], sheets: SHEETS, kits: [], model: model("seedance-2.0"), imageCount: 1, performanceReferences: [READ] });
  assert.deepEqual(rides.problems, []);
  assert.deepEqual(rides.references.map(r => "performance" in r && r.performance.id), [RECORD.id]);
  const quiet = planCharacterAudio({ scene: SCENE, shots: [SILENT as never], sheets: SHEETS, kits: [], model: model("seedance-2.0"), imageCount: 1, performanceReferences: [READ] });
  assert.deepEqual(quiet.references, []); assert.deepEqual(quiet.problems, []);
  const deaf = planCharacterAudio({ scene: SCENE, shots: [SPEAKING as never], sheets: SHEETS, kits: [], model: model("seedance-2.5"), imageCount: 1, performanceReferences: [READ] });
  assert.deepEqual(deaf.references, []); assert.deepEqual(deaf.problems, [], "no route is a clause on the card, not a refusal");
  const explicit = planCharacterAudio({ scene: SCENE, shots: [SPEAKING as never], sheets: SHEETS, kits: [], model: model("seedance-2.5"), imageCount: 1, performanceReferences: [{ ...READ, source: undefined } as never] });
  assert.match(explicit.problems.join(" "), /cannot carry/, "one chosen per dispatch keeps its refusal");
});

it("the cast authority says why a read will not be asked for, in the card's words (SPEC-044 R-28)", () => {
  const chosen = { kind: "performance", performanceId: RECORD.id, hash: HASH };
  const asked = castVoiceRequests(SHEETS, production(), castScene(chosen));
  assert.deepEqual(asked.notSent, []);
  assert.deepEqual(asked.requests.map(r => [r.performanceId, r.source, r.cloudBasis, r.warningCodes]), [[RECORD.id, "scene-cast", "self", ["audio-level-low"]]]);
  const reason = (bundle: ProductionBundle, scene: SceneRecord) => castVoiceRequests(SHEETS, bundle, scene).notSent.map(n => `${n.name}: ${n.reason}`);
  assert.deepEqual(reason(production(), castScene({ ...chosen, hash: `sha256:${"c".repeat(64)}` })), ["Maren Kest: read missing"]);
  assert.deepEqual(reason(production({ performanceReview: { reviews: [], selections: {} } }), castScene(chosen)), ["Maren Kest: read not accepted"]);
  assert.deepEqual(reason(production({ performances: [{ ...RECORD, attestations: [] }] }), castScene(chosen)), ["Maren Kest: attest one speaker and no music"]);
  assert.deepEqual(reason(production({ performances: [{ ...RECORD, cloudBasis: undefined }] }), castScene(chosen)), ["Maren Kest: no permission to send it"]);
  assert.deepEqual(reason(production(), castScene({ kind: "sample" })), [], "the sample asks for nothing");
  // Narrowed to a subject's shots (codex round 2): asked for where the member speaks, silent elsewhere.
  assert.equal(castVoiceRequests(SHEETS, production(), castScene(chosen), ["sh_1"]).requests.length, 1);
  assert.deepEqual(castVoiceRequests(SHEETS, production(), castScene(chosen), ["sh_2"]), { requests: [], notSent: [] });
});
