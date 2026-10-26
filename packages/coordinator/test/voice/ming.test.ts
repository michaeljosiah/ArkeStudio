import assert from "node:assert/strict";
import { it } from "node:test";
import { newClonedVoice, voiceSourceFor, supportsVoiceUse, type ClonedVoice } from "@arke-studio/contracts";
import { VoiceService } from "../../src/voice/service.js";
import { mingCatalogue } from "../../src/local-ai/ming-catalogue.js";

function voice(): ClonedVoice {
  const result = newClonedVoice({name: "Narrator", description: "Low and warm", clip: "voices/narrator.wav", transcript: "The harbour remembers.", consent: true, created: "2026-10-26", taken: []});
  assert.ok(result.ok); return result.voice;
}

it("offers both local Ming readers of one saved voice without requesting a cloud key", async () => {
  const saved = voice();
  const service = new VoiceService({sidecar: null, localPresets: [], cloudSources: [], getKey: async () => null, emit: () => {},
    localReaderAvailability: async model => model === "ming-3-0.5b" ? {ready: true} : {ready: false, reason: "Install 7.9B."}});
  const catalogue = await service.catalogue([saved]);
  assert.equal(catalogue.length, 2);
  const dense = catalogue.find(row => row.model === "ming-3-0.5b")!;
  assert.equal(dense.readsClone, saved.id); assert.equal(dense.local, true); assert.equal(dense.unavailableReason, undefined);
  assert.equal(supportsVoiceUse(dense, "narration"), true);
  assert.equal(voiceSourceFor([saved], dense.provider, dense.model, saved.id).kind, "cloned");
  assert.equal(voiceSourceFor([], dense.provider, dense.model, saved.id).kind, "missing-clone");
  assert.equal(catalogue.find(row => row.model === "ming-3-7.9b")?.unavailableReason, "Install 7.9B.");
  saved.language = "yo";
  assert.match((await service.catalogue([saved]))[0]!.unavailableReason!, /language is unsupported/);
  saved.language = "en";
  delete saved.transcript;
  assert.match((await service.catalogue([saved]))[0]!.unavailableReason!, /exact spoken words/);
});

it("keeps both Ming installations optional, with a pinned dependency closure and no Torch download", () => {
  const entries = mingCatalogue();
  assert.ok(entries.every(entry => entry.optional));
  for (const variant of ["dense", "tiny"]) {
    const model = entries.find(entry => entry.id === `ming-model-${variant}`)!;
    const runtime = entries.find(entry => entry.id === `ming-runtime-${variant}`)!;
    assert.deepEqual(model.requires, [runtime.id]); assert.deepEqual(runtime.requires, ["comfyui-runtime"]);
    assert.ok(model.provides?.length && runtime.provides?.length);
    assert.equal(runtime.spec.kind, "files");
    if (runtime.spec.kind === "files") {
      assert.ok(runtime.spec.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256!)));
      assert.ok(!runtime.spec.files.some(file => /^(?:torch|torchaudio|torchvision|numpy)[-_]/.test(file.file)));
    }
  }
});
