import assert from "node:assert/strict";
import { it } from "node:test";
import { speechCatalogue, PIPECAT_WHISPER_COMPONENT } from "../../src/local-ai/speech-catalogue.js";
import { isVoxaSetupComponentId, SETUP_CATALOGUE } from "../../src/setup/catalogue.js";

it("offers the converted recognizer separately with immutable verified files", () => {
  const row = speechCatalogue(); assert.equal(row.id, PIPECAT_WHISPER_COMPONENT); assert.equal(row.optional, true);
  assert.equal(row.spec.kind, "files"); if (row.spec.kind !== "files") throw Error("Wrong component type");
  assert.equal(row.spec.dir, "faster-whisper-base-en"); assert.equal(row.spec.files.length, 4);
  assert.ok(row.spec.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256 ?? "") && file.url.includes("3d3d5dee26484f91867d81cb899cfcf72b96be6c")));
  assert.ok(SETUP_CATALOGUE.some(file => file.id === row.id)); assert.equal(isVoxaSetupComponentId(row.id), true);
});
