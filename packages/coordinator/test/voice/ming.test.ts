import assert from "node:assert/strict";
import { it } from "node:test";
import { newClonedVoice, voiceSourceFor, supportsVoiceUse, type ClonedVoice } from "@arke-studio/contracts";
import { VoiceService } from "../../src/voice/service.js";
import { mingCatalogue } from "../../src/local-ai/ming-catalogue.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SHIPPED_MANIFEST } from "@arke-studio/providers";
import { FsWorldProvider } from "../../src/world/provider.js";
import { runAudiobookChapter } from "../../src/productions/audiobook-run.js";
import { writeSpeechWav } from "../../src/audio/speech-wav.js";
import type { EnqueueInput } from "../../src/queue/dispatcher.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { readerReferenceHash } from "../../src/voice/library.js";

function voice(): ClonedVoice {
  const result = newClonedVoice({name: "Narrator", description: "Low and warm", clip: "voices/narrator.wav", transcript: "The harbour remembers.", consent: true, created: "2026-10-26", taken: []});
  assert.ok(result.ok); return result.voice;
}

it("invalidates only Ming's reference identity when its recording language changes", () => {
  const clip = {data: new Uint8Array([1, 2, 3]), transcript: "Bonjour.", language: "fr", name: "voice.wav", contentType: "audio/wav" as const};
  const changed = {...clip, language: "en"};
  assert.notEqual(readerReferenceHash("ming", clip), readerReferenceHash("ming", changed));
  assert.equal(readerReferenceHash("mistral", clip), readerReferenceHash("mistral", changed));
});

it("carries the saved non-English language into a Ming audiobook part job", async () => {
  const {root, worldDir} = await makeTempRoot();
  const saved = {...voice(), language: "fr"};
  await mkdir(join(worldDir, "voices"), {recursive: true});
  await writeFile(join(worldDir, saved.clip), writeSpeechWav({rate: 24000, samples: new Float32Array(72000)}));
  await writeFile(join(worldDir, "voices/voices.json"), JSON.stringify({voices: [saved]}));
  const provider = new FsWorldProvider(root);
  await provider.loadWorld(WORLD_ID);
  const inputs: EnqueueInput[] = [];
  const model = SHIPPED_MANIFEST.models.find(row => row.id === "ming-3-0.5b")!;
  const narrator = {provider: "ming", model: model.id, voiceId: saved.id};
  try {
    await runAudiobookChapter({store: provider.openStore()!, worldId: WORLD_ID, productionId: "the-ledger-of-nights", chapterId: "neap",
      models: [model], narrator, catalogue: [{...narrator, label: saved.name, attributes: [], local: true, canClone: false, readsClone: saved.id}],
      signal: new AbortController().signal, only: ["title"], requireUploadConfirmation: () => false,
      localSpeech: async () => {throw new Error("Use the queue");}, synthesizeLocal: async () => {throw new Error("Use the queue");},
      enqueue: async queued => {inputs.push(...queued); return {jobIds: [], reason: "Observed without inference"};},
      waitForJob: async () => {throw new Error("No inference");}, cancelJob: async () => {}, findJobs: () => [], actualCost: async () => 0,
      emit: () => {}, now: () => "2026-10-26T09:00:00.000Z"});
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]!.params.language, "fr");
    assert.equal(inputs[0]!.voiceReference, true);
  } finally { await provider.close(); }
});

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
