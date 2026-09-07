import assert from "node:assert/strict";
import { test } from "node:test";
import { CharacterAudioPlanSchema, referenceInputProblem } from "@arke-studio/contracts";
import { SHIPPED_MANIFEST } from "@arke-studio/providers";
import { analyzePcmWav } from "../../src/audio/qc.js";
import { wav } from "../audio/helpers.js";

test("H3 admission combines standalone and voice durations and refuses empty requests", () => {
  const model = SHIPPED_MANIFEST.models.find(row => row.id === "comfyui-h3-reference-video")!;
  const report = analyzePcmWav(wav([1, -1])), hash = report.sourceHash, at = "2026-09-07T12:00:00Z";
  const technical = { ...report.technical, durationSec: 5 };
  const audioReferences = CharacterAudioPlanSchema.parse({ version: 1, disabled: false, route: model.id, problems: [], references: [{
    intent: "voice-reference", sheetId: "speaker", characterName: "Speaker", label: "@Audio1",
    sample: { schemaVersion: 1, file: `voice/sha256-${hash.slice(7)}.wav`, operationId: "d1bbaf9f-e168-4b99-8df2-e9b6ba917380", designatedAt: at,
      warningCodes: [], attestations: [], provenance: { schemaVersion: 1,
        source: { kind: "legacy-character-sample", sheetId: "speaker", sourceFile: "sample.wav", legacySource: "cloning-recording", legacyDesignatedAt: at, sourceMediaHash: hash },
        sourceTechnical: technical, outputHash: hash, outputTechnical: technical, preparation: [], qualityReport: report, createdAt: at } },
  }] });
  const referenceMedia = [1, 2].map(index => ({ kind: "audio", file: `clip-${index}.wav`, hash, durationSec: 5.2 }));
  assert.match(referenceInputProblem(model, {})!, /at least one/);
  assert.equal(referenceInputProblem(model, { references: ["image.png"] }), null);
  assert.equal(referenceInputProblem(model, { audioReferences }), null);
  assert.equal(referenceInputProblem(model, { referenceMedia }), null);
  assert.match(referenceInputProblem(model, { referenceMedia, audioReferences })!, /together exceed fifteen/);
  referenceMedia[0]!.durationSec = 4.8;
  assert.equal(referenceInputProblem(model, { referenceMedia, audioReferences }), null);
});
