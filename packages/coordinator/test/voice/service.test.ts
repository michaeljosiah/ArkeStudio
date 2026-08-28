import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DomainEvent, LedgerEntry, ManifestModel, Sheet, WorldBundle } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { until } from "../wait.js";
import { JobQueue } from "../../src/queue/dispatcher.js";
import {
  authoritativeBibleSpeech,
  authoritativeSheetSpeech,
  concatWav,
  normalizeSpeechText,
  previewCacheFile,
  speechCacheFile,
  splitForSpeech,
  VoiceService,
  voiceLineRequest,
} from "../../src/voice/service.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { FakeProvider } from "../queue/fake-provider.js";
import { AppSettingsFile } from "../../src/app-settings.js";
import { verifyArtifact } from "../../src/queue/verify.js";

const CLOCK = () => "2026-08-01T12:00:00.000Z";

function wav(samples: number[] = [1, 2, 3, 4]): Uint8Array {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(24_000, 24);
  out.writeUInt32LE(48_000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => out.writeInt16LE(sample, 44 + index * 2));
  return new Uint8Array(out);
}

const ELEVEN_MODEL: ManifestModel = {
  id: "eleven_multilingual_v2",
  provider: "elevenlabs",
  capability: "voice-tts",
  displayName: "Eleven v3",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: {},
  pricing: { kind: "perCharacter", microUsdPerCharacter: 300 },
};

const SHEET = {
  id: "maren-kest",
  type: "character",
  name: "Maren Kest",
  version: 4,
  status: "locked",
  voice: { provider: "elevenlabs", voiceId: "v_8Kq2", label: "Low tide", assignedAtVersion: 4 },
  canonRules: [],
  links: [],
  created: "2026-05-02",
  updated: "2026-07-14",
  sections: [
    { heading: "Essence", body: "Tide-caller" },
    { heading: "Voice · written", body: "Low and even." },
  ],
} as unknown as Sheet;

function fakeSidecar(engine: "ready" | "down" | "unreachable" = "ready") {
  const calls: string[] = [];
  return {
    calls,
    health: async () => {
      calls.push("health");
      if (engine === "unreachable") return null;
      return {
        engineStatus: {
          kokoro: engine === "ready" ? { ready: true } : { ready: false, reason: "Kokoro is unavailable." },
        },
      };
    },
    listVoices: async () => {
      calls.push("voices");
      return [{ id: "af_bella", label: "Bella", attributes: ["low", "warm"] }];
    },
    synthesize: async (input: { voiceId: string; text: string }) => {
      calls.push(`tts:${input.voiceId}`);
      return wav();
    },
    transcribe: async () => {
      calls.push("stt");
      return "make her braids longer";
    },
  };
}

describe("routing (R-2, D1, §3.2): local never touches the queue; cloud always does", () => {
  it("a Kokoro preview synthesises locally, caches, and replays without a second synthesis", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    const sidecar = fakeSidecar();
    const events: DomainEvent[] = [];
    const service = new VoiceService({
      sidecar,
      localPresets: [],
      cloudSources: [],
      getKey: async () => null,
      emit: (e) => events.push(e),
      clock: CLOCK,
    });
    const line = { text: "the verse, under the water", source: "own-line" as const };
    const file = await service.localPreview(store, SHEET, "af_bella", line);
    assert.match(file, /^\.cache\/voice-previews\/[0-9a-f]{24}\.wav$/);
    const bytes = await readFile(join(dir, file));
    assert.equal(verifyArtifact({ name: "preview.wav", contentType: "audio/wav", data: bytes }), null);
    assert.deepEqual(sidecar.calls, ["tts:af_bella"], "one synthesis, no queue, no ledger — zero cost");

    const again = await service.localPreview(store, SHEET, "af_bella", line);
    assert.equal(again, file);
    assert.deepEqual(sidecar.calls, ["tts:af_bella"], "the cache replays without any call at all (R-10)");
    await store.close();
  });

  it("rejects a structurally truncated cache hit and replaces it with complete local audio", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    const sidecar = fakeSidecar();
    const service = new VoiceService({
      sidecar,
      localPresets: [],
      cloudSources: [],
      getKey: async () => null,
      emit: () => {},
      clock: CLOCK,
    });
    const line = { text: "the verse, under the water", source: "own-line" as const };
    const file = await service.localPreview(store, SHEET, "af_bella", line);
    sidecar.calls.length = 0;
    await writeFile(join(dir, file), Buffer.from("RIFF\u0008\u0000\u0000\u0000WAVE", "binary"));

    const result = await service.localPreview(store, SHEET, "af_bella", line);
    assert.equal(result, file);
    assert.deepEqual(sidecar.calls, ["tts:af_bella"]);
    assert.equal(
      verifyArtifact({ name: "preview.wav", contentType: "audio/wav", data: await readFile(join(dir, result)) }),
      null,
    );
    await store.close();
  });

  it("refuses newly synthesized WAV bytes whose body is incomplete", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    const service = new VoiceService({
      sidecar: {
        ...fakeSidecar(),
        synthesize: async () => Uint8Array.from([0x52, 0x49, 0x46, 0x46, 8, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]),
      },
      localPresets: [],
      cloudSources: [],
      getKey: async () => null,
      emit: () => {},
    });
    await assert.rejects(
      service.localSpeech(store, "af_bella", "fresh but broken"),
      /invalid audio/,
    );
    await store.close();
  });

  it("an ElevenLabs line goes through the queue with a durable local key and writes one ledger entry", async () => {
    const fake = new FakeProvider({});
    const queueDir = await tempDir("arke-voiceq-");
    const worldDir = await tempDir("arke-voicew-");
    const ledger: LedgerEntry[] = [];
    const queue = new JobQueue({
      journalPath: join(queueDir, "jobs.jsonl"),
      clients: { elevenlabs: fake },
      getKey: async () => "xi-key",
      emit: () => {},
      ledger: {
        readJobIds: async () => new Set(ledger.map((entry) => entry.jobId)),
        has: async (jobId) => ledger.some((e) => e.jobId === jobId),
        append: async (e) => {
          ledger.push(e);
        },
      },
      landInWorld: async (_worldId, fn) => {
        await fn(worldDir);
        return true;
      },
      readImageReferences: async () => [],
      pollIntervalMs: 5,
      baseIntervalMs: 1,
    });
    await queue.start();
    const request = voiceLineRequest({
      worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
      productionId: "saltlight",
      shotId: "sh_12",
      sheet: SHEET,
      text: "the verse, under the water",
      deliveryParams: { stability: 0.7 },
      deliveryNotice: null,
      model: ELEVEN_MODEL,
    });
    const job = await queue.enqueue(request);
    assert.equal(job.provider, "elevenlabs");
    assert.equal(job.estimatedMicroUsd, 26 * 300, "estimated from characters × manifest price");
    assert.ok(job.idempotencyKey.length === 26, "the queue's durable request identity exists before submission (R-2)");
    assert.equal(fake.submittedKeys[0], undefined, "ElevenLabs does not falsely receive an unsupported idempotency key");
    // 30s: the fake dispatch is in-process, but a starved shard stalls the event loop for
    // seconds at a time — the settle tier from supervisor.test.ts's budget note.
    await until(
      () => queue.listJobs().find((j) => j.id === job.id)?.status === "succeeded",
      "the voice job to fold to succeeded",
      30_000,
    );
    assert.equal(ledger.length, 1, "ledgered like any other dispatch");
    assert.equal(ledger[0]!.provider, "elevenlabs");
    queue.dispose();
  });

  it("a retake keeps the voice; only the delivery changes (R-14, R-15)", () => {
    const base = {
      worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
      productionId: "saltlight",
      shotId: "sh_12",
      sheet: SHEET,
      text: "again, colder",
      model: ELEVEN_MODEL,
    };
    const measured = voiceLineRequest({ ...base, deliveryParams: { stability: 0.7 }, deliveryNotice: null });
    const breaking = voiceLineRequest({ ...base, deliveryParams: { stability: 0.25 }, deliveryNotice: null });
    assert.equal(measured.params["voiceId"], breaking.params["voiceId"], "the voice is the sheet's");
    assert.notDeepEqual(measured.params["voiceSettings"], breaking.params["voiceSettings"]);

    // An inexpressible delivery travels as a stated notice, never silently dropped.
    const noticed = voiceLineRequest({
      ...base,
      deliveryParams: null,
      deliveryNotice: 'Kokoro cannot express "breaking" — the read will be neutral',
    });
    assert.match(String(noticed.params["deliveryNotice"]), /cannot express/);

    const voiceless = { ...SHEET, voice: undefined } as unknown as Sheet;
    assert.throws(
      () => voiceLineRequest({ ...base, sheet: voiceless, deliveryParams: null, deliveryNotice: null }),
      /no assigned voice/,
    );
  });
});

/**
 * Found in front of an audience (2026-08-24). The runtime was up, its top-level health said
 * `ok: true`, and `/voices` listed three Kokoro presets — while the speech engine had failed to
 * load at startup and never retried. Settings offered a narrator, one was chosen, and the first
 * anyone knew was a 503 at the moment of pressing play.
 *
 * The listing endpoint reads a preset table. It is not evidence that anything can be spoken, and
 * asking it was the only question being asked.
 */
/**
 * Measured against the real runtime on 2026-08-24, after a read-aloud of a bible section killed
 * local voice for the whole app in front of somebody.
 *
 * 500 characters synthesises in about 32 seconds and leaves the engine healthy. 8,610 in one
 * request returns 503 after sixteen seconds and leaves Kokoro permanently unavailable — every
 * voice feature, not just that one, until the app is restarted. The guard that existed refused
 * at 10,000, which the fatal request passed straight through.
 */
describe("long text is spoken in pieces, because one long request fells the engine", () => {
  it("keeps a short passage whole — no seams where none are needed", () => {
    assert.deepEqual(splitForSpeech("Her mother died. She was handed to her aunt."), [
      "Her mother died. She was handed to her aunt.",
    ]);
  });

  it("breaks at sentence ends, and keeps the terminator with its sentence", () => {
    const text = `${"a".repeat(300)}. ${"b".repeat(300)}? ${"c".repeat(300)}!`;
    const parts = splitForSpeech(text);
    assert.equal(parts.length, 3);
    assert.ok(parts[0]!.endsWith("."), "a full stop reads differently from a question mark");
    assert.ok(parts[1]!.endsWith("?"));
    assert.ok(parts.every((p) => p.length <= 450));
  });

  it("packs several short sentences into one piece rather than one request each", () => {
    const parts = splitForSpeech("One. Two. Three. Four.");
    assert.deepEqual(parts, ["One. Two. Three. Four."]);
  });

  /** Refusing to speak a long sentence is a worse answer than breathing in an odd place. */
  it("falls back to a clause seam when a single sentence will not fit", () => {
    const parts = splitForSpeech(`${"word ".repeat(80)}, and then ${"more ".repeat(80)}.`);
    assert.ok(parts.length > 1);
    assert.ok(parts.every((p) => p.length <= 450), "every piece is under the measured safe size");
  });

  it("never emits an empty piece, whatever the spacing", () => {
    for (const text of ["   ", "A.  .  B.", ". . .", ""]) {
      assert.ok(splitForSpeech(text).every((p) => p.trim() !== ""), `empty piece from ${JSON.stringify(text)}`);
    }
  });

  it("covers the real section that caused this, in pieces the engine survives", () => {
    const parts = splitForSpeech("Sentence here. ".repeat(600));
    assert.ok(parts.length > 15);
    assert.ok(parts.every((p) => p.length <= 450));
    assert.equal(parts.join(" ").replace(/\s+/g, " ").trim(), "Sentence here. ".repeat(600).trim());
  });
});

describe("joining the pieces back into one clip", () => {
  it("concatenates the audio and rewrites both sizes a player reads", () => {
    const joined = Buffer.from(concatWav([wav([1, 2]), wav([3, 4, 5])]));
    assert.equal(joined.toString("ascii", 0, 4), "RIFF");
    assert.equal(joined.readUInt32LE(4), joined.length - 8, "the RIFF size");
    assert.equal(joined.readUInt32LE(40), 10, "the data size — five samples, two bytes each");
    assert.deepEqual([0, 1, 2, 3, 4].map((i) => joined.readInt16LE(44 + i * 2)), [1, 2, 3, 4, 5]);
  });

  it("returns a single piece untouched, rather than rebuilding it", () => {
    const one = wav([7, 8]);
    assert.equal(concatWav([one]), one);
  });

  /**
   * The data chunk is found, not assumed at 44: the engine may emit LIST or fact chunks, and a
   * hard-coded offset would read those as samples and play them as noise.
   */
  it("finds the data chunk past an extra chunk it does not recognise", () => {
    const base = Buffer.from(wav([9, 9]));
    const extra = Buffer.alloc(12);
    extra.write("LIST", 0, "ascii");
    extra.writeUInt32LE(4, 4);
    extra.write("INFO", 8, "ascii");
    const withExtra = Buffer.concat([base.subarray(0, 36), extra, base.subarray(36)]);
    withExtra.writeUInt32LE(withExtra.length - 8, 4);
    const joined = Buffer.from(concatWav([new Uint8Array(withExtra), wav([1])]));
    // The LIST chunk survives in the header, so `data` sits 12 bytes later than in a bare wav.
    const dataSizeAt = 36 + 12 + 4;
    assert.equal(joined.toString("ascii", 36 + 12, 36 + 16), "data", "the header kept the chunk it did not understand");
    assert.equal(joined.readUInt32LE(dataSizeAt), 6, "three samples survived, not the LIST bytes");
    assert.deepEqual([0, 1, 2].map((i) => joined.readInt16LE(36 + 20 + i * 2)), [9, 9, 1]);
  });

  it("refuses audio that is not a wav at all", () => {
    assert.throws(() => concatWav([new Uint8Array([1, 2, 3]), wav([1])]), /invalid audio/);
  });
});

describe("the catalogue does not offer a voice the engine cannot speak", () => {
  const service = (sidecar: ReturnType<typeof fakeSidecar>) =>
    new VoiceService({
      sidecar,
      localPresets: [
        { provider: "kokoro", model: "kokoro-82m", voiceId: "af_bella", label: "Bella", attributes: [], local: true, canClone: false },
      ],
      cloudSources: [],
      getKey: async () => null,
      emit: () => {},
      clock: CLOCK,
    });

  it("offers the live voices when the engine reports itself ready", async () => {
    const sidecar = fakeSidecar("ready");
    const voices = await service(sidecar).catalogue();
    assert.deepEqual(voices.map((v) => v.voiceId), ["af_bella"]);
    assert.ok(sidecar.calls.includes("health"), "it asks before it offers");
  });

  it("offers nothing local when the engine says it is not ready — not even the presets", async () => {
    const sidecar = fakeSidecar("down");
    const voices = await service(sidecar).catalogue();
    assert.deepEqual(voices, [], "we have been told in as many words that none of them can be spoken");
    assert.equal(sidecar.calls.includes("voices"), false, "and it does not bother asking for a list it cannot use");
  });

  /**
   * Unreachable is not the same as failed. An engine that has not answered yet may simply be
   * starting, and blanking the configured presets on a timeout would make a slow launch look
   * like a broken install.
   */
  it("keeps the configured presets when the runtime does not answer at all", async () => {
    const voices = await service(fakeSidecar("unreachable")).catalogue();
    assert.deepEqual(voices.map((v) => v.voiceId), ["af_bella"]);
  });

  it("still offers cloned voices when the local engine is down, since they are not its to speak", async () => {
    const voices = await service(fakeSidecar("down")).catalogue([
      { id: "cv_1", label: "Timi", provider: "elevenlabs", voiceId: "v_timi" } as never,
    ]);
    assert.equal(voices.length, 1, "a cloud-cloned voice does not depend on the local runtime");
  });

  it("keeps an unready cloned voice visible with its shared readiness reason", async () => {
    const voices = await service(fakeSidecar("ready")).catalogue(
      [{ id: "cv_1", name: "Timi", clip: "voices/timi.wav", attributes: [] } as never],
      { local: false, unavailableReason: "the cloned voice recipe is hard-disabled" },
    );
    const clone = voices.find((voice) => voice.voiceId === "cv_1");
    assert.ok(clone);
    assert.equal(clone.local, false);
    assert.equal(clone.unavailableReason, "the cloned voice recipe is hard-disabled");
  });
});

describe("candidates and the stated preview cost (R-7, R-10)", () => {
  it("emits ranked candidates with extraction, the preview line, and the cloud figure", async () => {
    const events: DomainEvent[] = [];
    const service = new VoiceService({
      sidecar: fakeSidecar(),
      localPresets: [],
      cloudSources: [
        {
          provider: "elevenlabs",
          list: async () => [
            { provider: "elevenlabs", model: "eleven_multilingual_v2", voiceId: "v1", label: "Harbour", attributes: ["low", "even"], local: false, canClone: true },
          ],
        },
      ],
      getKey: async (p) => (p === "elevenlabs" ? "xi-key" : null),
      emit: (e) => events.push(e),
      clock: CLOCK,
    });
    const bundle = { productions: [] } as unknown as WorldBundle;
    await service.candidates("01J8F3K2QW9VZX4N7M0RTYB6HC", bundle, SHEET, {
      manifestVersion: 7,
      generated: "2026-07-28",
      models: [ELEVEN_MODEL],
    });
    const event = events.find((e) => e.type === "voice.candidates");
    assert.ok(event && event.type === "voice.candidates");
    assert.ok(event.extracted.includes("low"));
    assert.equal(event.ranked[0]!.candidate.voiceId, "v1", "cloud match outranks the sidecar preset");
    assert.equal(event.ranked[0]!.matched.length, 2);
    assert.equal(event.previewLine.source, "drafted");
    assert.equal(
      event.cloudPreviewMicroUsd,
      event.previewLine.text.length * 300,
      "the charge is stated before any preview incurs it",
    );
  });

  it("prices equal voice ids independently for two models behind one provider", async () => {
    const events: DomainEvent[] = [];
    const expensive = {
      ...ELEVEN_MODEL,
      id: "eleven-v3",
      displayName: "Eleven v3",
      pricing: { kind: "perCharacter" as const, microUsdPerCharacter: 500 },
    };
    const service = new VoiceService({
      sidecar: null,
      localPresets: [],
      cloudSources: [{
        provider: "elevenlabs",
        list: async () => [
          { provider: "elevenlabs", model: expensive.id, voiceId: "same", label: "Same v3", attributes: [], local: false, canClone: true },
          { provider: "elevenlabs", model: ELEVEN_MODEL.id, voiceId: "same", label: "Same v2", attributes: [], local: false, canClone: true },
        ],
      }],
      getKey: async () => "key",
      emit: (event) => events.push(event),
    });
    await service.candidates("01J8F3K2QW9VZX4N7M0RTYB6HC", { productions: [] } as unknown as WorldBundle, SHEET, {
      manifestVersion: 1,
      generated: "2026-08-25",
      models: [expensive, ELEVEN_MODEL],
    });
    const event = events.find((candidate) => candidate.type === "voice.candidates");
    assert.ok(event && event.type === "voice.candidates");
    const length = event.previewLine.text.length;
    assert.equal(event.previewMicroUsdByVoice[JSON.stringify(["elevenlabs", expensive.id, "same"])], length * 500);
    assert.equal(event.previewMicroUsdByVoice[JSON.stringify(["elevenlabs", ELEVEN_MODEL.id, "same"])], length * 300);
  });

  it("an unkeyed cloud source contributes nothing; the catalogue stays uniform", async () => {
    const service = new VoiceService({
      sidecar: null,
      localPresets: [
        { provider: "kokoro", model: "kokoro-82m", voiceId: "af_bella", label: "Bella", attributes: ["low"], local: true, canClone: false },
      ],
      cloudSources: [
        {
          provider: "elevenlabs",
          list: async () => {
            throw new Error("must not be called without a key");
          },
        },
      ],
      getKey: async () => null,
      emit: () => {},
    });
    const catalogue = await service.catalogue();
    assert.equal(catalogue.length, 1);
    assert.equal(catalogue[0]!.local, true);
    assert.equal(catalogue[0]!.canClone, false);
  });
});

describe("dictation (R-17, R-18, §3.2)", () => {
  it("transcribes locally and lands as editable text — an event, never a submission", async () => {
    const events: DomainEvent[] = [];
    const sidecar = fakeSidecar();
    const service = new VoiceService({
      sidecar,
      localPresets: [],
      cloudSources: [],
      getKey: async () => null,
      emit: (e) => events.push(e),
      clock: CLOCK,
    });
    await service.dictate("dict-1", new Uint8Array([1, 2, 3]), "audio/webm");
    const event = events.find((e) => e.type === "dictation.result");
    assert.ok(event && event.type === "dictation.result");
    assert.equal(event.text, "make her braids longer");
    assert.equal(event.error, null);
    assert.deepEqual(sidecar.calls, ["stt"], "loopback only — no provider ever sees audio");
  });

  it("states the reason when the sidecar is down, and typing still works", async () => {
    const events: DomainEvent[] = [];
    const service = new VoiceService({
      sidecar: null,
      localPresets: [],
      cloudSources: [],
      getKey: async () => null,
      emit: (e) => events.push(e),
      clock: CLOCK,
    });
    await service.dictate("dict-2", new Uint8Array([1]), "audio/webm");
    const event = events.find((e) => e.type === "dictation.result");
    assert.ok(event && event.type === "dictation.result");
    assert.equal(event.text, null);
    assert.match(event.error!, /Voxa is not running/);
  });
});

describe("the preview cache key", () => {
  it("is stable per voice and line, and distinct across both", () => {
    const a = previewCacheFile("elevenlabs", "v1", "line one", "mp3");
    assert.equal(a, previewCacheFile("elevenlabs", "v1", "line one", "mp3"));
    assert.notEqual(a, previewCacheFile("elevenlabs", "v2", "line one", "mp3"));
    assert.notEqual(a, previewCacheFile("elevenlabs", "v1", "line two", "mp3"));
  });
  it("separates providers over the same voice and line (SPEC-022 §2.7)", () => {
    // The branch this replaces was binary — anything not Kokoro keyed as ElevenLabs — so a second
    // local provider filed onto the cloud key and replayed the wrong audio for the same voice id.
    const paths = ["elevenlabs", "kokoro", "comfyui"].map((p) => previewCacheFile(p, "v1", "line one", "mp3"));
    assert.equal(new Set(paths).size, 3, "each provider must own its cache key");
  });
  it("keys an unknown provider under itself rather than a neighbour", () => {
    assert.notEqual(
      previewCacheFile("someday-tts", "v1", "line one", "mp3"),
      previewCacheFile("elevenlabs", "v1", "line one", "mp3"),
    );
  });
  it("takes the model from the caller when one is named", () => {
    assert.notEqual(
      previewCacheFile("comfyui", "v1", "line one", "wav"),
      previewCacheFile("comfyui", "v1", "line one", "wav", "comfyui-other-recipe"),
    );
  });
  it("includes model, format, settings and normalized text", () => {
    const base = { provider: "kokoro" as const, model: "kokoro-82m", voiceId: "af_bella", text: "hello   harbour", format: "wav" as const };
    assert.equal(normalizeSpeechText(base.text), "hello harbour");
    assert.equal(speechCacheFile(base), speechCacheFile({ ...base, text: " hello harbour " }));
    assert.notEqual(speechCacheFile(base), speechCacheFile({ ...base, model: "kokoro-82m-v2" }));
    assert.notEqual(speechCacheFile(base), speechCacheFile({ ...base, format: "mp3" }));
  });

  it("includes delivery parameters in cache identity", () => {
    const base = {
      provider: "elevenlabs",
      model: "eleven_multilingual_v2",
      voiceId: "v1",
      text: "hello",
      format: "mp3" as const,
    };
    assert.notEqual(
      speechCacheFile(base),
      speechCacheFile({ ...base, params: { stability: 0.7 } }),
    );
  });
});

/**
 * The bible gained read-aloud because the whole arc of a story lives in it and it was the one
 * long-form document in the world with no way to hear it (2026-08-24). Asked for by an author who
 * had told a story out loud over an evening and wanted it read back to her.
 */
describe("authoritative bible speech", () => {
  const BIBLE = [
    "Some prose before any heading at all.",
    "",
    "## The story, told",
    "",
    "Her mother came from nothing.   She died the night the girl was born.",
    "",
    "## Format rules",
    "",
    "Ninety seconds.",
    "",
    "## Not written yet",
    "",
  ].join("\n");

  it("reads the section it was asked for, normalised", () => {
    assert.deepEqual(authoritativeBibleSpeech(BIBLE, "The story, told"), {
      text: "Her mother came from nothing. She died the night the girl was born.",
    });
  });

  /**
   * No enum of permitted headings, unlike the sheet version — a bible's headings belong to
   * whoever wrote it, so the only checks available are that the section is there and has words.
   */
  it("takes any heading the author actually wrote", () => {
    assert.deepEqual(authoritativeBibleSpeech(BIBLE, "Format rules"), { text: "Ninety seconds." });
  });

  it("refuses a heading that is not in the document, rather than reading the wrong one", () => {
    assert.throws(() => authoritativeBibleSpeech(BIBLE, "The story"), /no longer in the bible/);
  });

  it("refuses an empty section instead of sending nothing to a paid provider", () => {
    assert.throws(() => authoritativeBibleSpeech(BIBLE, "Not written yet"), /Nothing to read/);
  });

  it("never reads the preamble, which belongs to no heading", () => {
    assert.throws(() => authoritativeBibleSpeech(BIBLE, ""), /no longer in the bible/);
  });
});

describe("authoritative sheet speech", () => {
  /**
   * It returns the words, and only the words. It used to resolve the voice as well, from
   * `sheet.voice` — which read prose *about* a character in that character's own voice, and
   * refused outright for the many characters who have none. Who narrates is a separate question
   * with a separate answer (narratorFor, in contracts).
   */
  it("reads exact normalized Essence, and says nothing about who reads it", () => {
    assert.deepEqual(authoritativeSheetSpeech(SHEET, "Essence"), { text: "Tide-caller" });
  });

  it("reads Appearance too, and rejects unknown headings and empty text", () => {
    const withAppearance = {
      ...SHEET,
      sections: [...SHEET.sections, { heading: "Appearance", body: "Salt-crusted braids, pale grey eyes." }],
    } as Sheet;
    assert.deepEqual(authoritativeSheetSpeech(withAppearance, "Appearance"), {
      text: "Salt-crusted braids, pale grey eyes.",
    });
    assert.throws(() => authoritativeSheetSpeech(SHEET, "Relationships"), /not available/);
    assert.throws(() => authoritativeSheetSpeech({ ...SHEET, sections: [{ heading: "Essence", body: "  " }] } as Sheet, "Essence"), /Nothing to read/);
  });

  it("reads a character who has no voice of their own", () => {
    // The behaviour this replaced refused here, which meant most of a cast could not be read.
    const voiceless = { ...SHEET, voice: undefined } as unknown as Sheet;
    assert.deepEqual(authoritativeSheetSpeech(voiceless, "Essence"), { text: "Tide-caller" });
  });
});

describe("a spoken line reaches the queue (built 2026-08-17)", () => {
  /**
   * The screens, the dialog and voiceLineRequest all existed; nothing connected them, and the
   * button was hardcoded `disabled` with "Voice generation arrives with SPEC-011". These pin
   * the shape the handler now depends on.
   */
  // The file's own sheet, given the local voice this world actually assigns her.
  const SPEAKER = {
    ...SHEET,
    voice: { provider: "kokoro", voiceId: "af_bella", label: "Bella", assignedAtVersion: 4 },
  } as unknown as Sheet;
  const LOCAL_MODEL: ManifestModel = {
    id: "kokoro-82m",
    provider: "kokoro",
    capability: "voice-tts",
    displayName: "Kokoro 82M",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    limits: {},
    pricing: { kind: "unmetered" },
  };

  it("speaks in the sheet's own voice, never one passed in", () => {
    const request = voiceLineRequest({
      worldId: "w",
      productionId: "saltlight",
      shotId: "sh_12",
      sheet: SPEAKER,
      text: "the verse, under the water",
      deliveryParams: null,
      deliveryNotice: null,
      model: LOCAL_MODEL,
    });
    assert.equal(request.params["voiceId"], "af_bella", "the voice is the speaker's");
    assert.equal(request.params["text"], "the verse, under the water");
    assert.equal(request.capability, "voice-tts");
    assert.deepEqual(request.target, { kind: "voice-line", id: "sh_12" });
    // Lands beside the production it belongs to, not in the world's artifacts.
    assert.equal(request.landing?.dir, "productions/saltlight/audio");
  });

  it("refuses a speaker with no voice, naming where one is given", () => {
    const voiceless = { ...SPEAKER, voice: undefined } as unknown as Sheet;
    assert.throws(
      () =>
        voiceLineRequest({
          worldId: "w",
          productionId: "saltlight",
          shotId: "sh_12",
          sheet: voiceless,
          text: "x",
          deliveryParams: null,
          deliveryNotice: null,
          model: LOCAL_MODEL,
        }),
      /has no assigned voice/,
    );
  });

  it("marks a cloned line for host resolution without putting a path in the job", () => {
    const cloned = {
      ...SPEAKER,
      voice: {
        provider: "comfyui",
        model: "comfyui-cloned-voice",
        voiceId: "harbour-glass",
        label: "Harbour glass",
        assignedAtVersion: 4,
      },
    } as Sheet;
    const request = voiceLineRequest({
      worldId: "w",
      productionId: "saltlight",
      shotId: "sh_12",
      sheet: cloned,
      text: "the verse, under the water",
      deliveryParams: null,
      deliveryNotice: null,
      model: {
        ...LOCAL_MODEL,
        id: "comfyui-cloned-voice",
        provider: "comfyui",
        limits: { audioFormat: "flac" },
      },
      voiceReference: true,
    });
    assert.equal(request.voiceReference, true);
    assert.equal("voiceReference" in request.params, false);
    assert.equal(request.params["audioFormat"], "flac");
    assert.equal("speakerFile" in request.params, false);
  });
});

describe("the narrator survives a restart (found live, 2026-08-17)", () => {
  /**
   * Three separate places have to agree for a preference to be real: the file, the event, and
   * the snapshot that a fresh window reads. This one was written correctly and left out of the
   * snapshot, so restarting the app showed the shipped local voice while a cloud voice was
   * actually stored — a narrator that would have billed every read while claiming to be free.
   */
  it("reads back what was written", async () => {
    const dir = await tempDir("narrator");
    const file = new AppSettingsFile(join(dir, "settings.json"));
    const chosen = { provider: "elevenlabs", voiceId: "v_roger", label: "Roger" };
    await file.setNarrator(chosen);
    // A second reader — the one a restart uses — sees it.
    const reopened = new AppSettingsFile(join(dir, "settings.json"));
    assert.deepEqual((await reopened.load()).narrator, chosen);
    // And clearing returns to null, which is how "the shipped local voice" is stored.
    await file.setNarrator(null);
    assert.equal((await new AppSettingsFile(join(dir, "settings.json")).load()).narrator, null);
  });
});

/**
 * The catalogue with a third source in it (SPEC-022 T-9). Kokoro's presets, ElevenLabs' library
 * and the world's own cloned voices, ranked together against a written voice.
 */
describe("cloned voices join the catalogue", () => {
  const service = () =>
    new VoiceService({
      sidecar: null,
      localPresets: [
        { provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george", label: "George", attributes: ["low", "gravel"], local: true, canClone: false },
      ],
      cloudSources: [],
      getKey: async () => null,
      emit: () => {},
    });

  const CLONED = [
    {
      id: "harbour-glass",
      name: "Harbour glass",
      clip: "voices/harbour-glass.wav",
      description: "Low, dry, unhurried. Coastal.",
      attributes: ["low", "dry", "unhurried", "coastal"],
      consent: true,
      created: "2026-08-18T10:00:00.000Z",
    },
  ];

  it("offers them beside the presets, local and not themselves cloneable", async () => {
    const catalogue = await service().catalogue(CLONED);
    const cloned = catalogue.find((c) => c.voiceId === "harbour-glass");
    assert.ok(cloned, "a cloned voice is a candidate like any other");
    assert.equal(cloned.provider, "comfyui");
    assert.equal(cloned.local, true);
    assert.equal(cloned.canClone, false);
    assert.ok(catalogue.some((c) => c.provider === "kokoro"), "the presets are still there");
  });

  it("a world with none simply has none — the two catalogues that need no world still answer", async () => {
    const catalogue = await service().catalogue();
    assert.deepEqual(
      catalogue.map((c) => c.provider),
      ["kokoro"],
      "the narrator resolves before a world is open and must not need one",
    );
  });
});

/**
 * A cloned voice previews through the queue (SPEC-022 T-9b). Being local changes what it costs,
 * not how it is made — only Kokoro bypasses the queue, because the sidecar answers synchronously.
 */
describe("a cloned voice previews like any other queued voice", () => {
  const RECIPE: ManifestModel = {
    id: "comfyui-cloned-voice",
    provider: "comfyui",
    capability: "voice-tts",
    displayName: "Local · Cloned Voice",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    limits: { maxPromptChars: 400, audioFormat: "flac" },
    pricing: { kind: "unmetered" },
  };
  const svc = () =>
    new VoiceService({ sidecar: null, localPresets: [], cloudSources: [], getKey: async () => null, emit: () => {} });
  const line = { text: "the tide turns", source: "own-line" as const };

  it("carries the resolved clip and costs nothing", () => {
    const { input, cacheFile } = svc().queuedPreviewRequest({
      worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
      sheet: SHEET,
      provider: "comfyui",
      voiceId: "harbour-glass",
      line,
      model: RECIPE,
      voiceReference: true,
      voiceUploadConfirmedFor: "remote-instance-1",
    });
    assert.equal(input.provider, "comfyui");
    assert.equal(input.voiceReference, true);
    assert.equal(input.voiceUploadConfirmedFor, "remote-instance-1");
    assert.equal("confirmationToken" in input, false, "paid read approval is a different token");
    assert.equal("voiceReference" in input.params, false);
    assert.equal(input.params["audioFormat"], "flac");
    assert.equal(JSON.stringify(input).includes("C:/worlds"), false, "no absolute path enters the job");
    // Unmetered: a local read states no price where an ElevenLabs row states an exact figure.
    assert.equal(input.estimatedMicroUsd, 0);
    // FLAC, because that is what SaveAudio writes — an mp3 key would cache a hit that never
    // matches the bytes on disk.
    assert.match(cacheFile, /\.flac$/);
  });

  it("keys its cache apart from a cloud voice of the same id and line", () => {
    const s = svc();
    const local = s.queuedPreviewRequest({
      worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", sheet: SHEET, provider: "comfyui",
      voiceId: "v1", line, model: RECIPE, voiceReference: true,
    });
    const cloud = s.queuedPreviewRequest({
      worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", sheet: SHEET, provider: "elevenlabs",
      voiceId: "v1", line, model: ELEVEN_MODEL,
    });
    assert.notEqual(local.cacheFile, cloud.cacheFile);
  });

  it("a catalogue voice carries no clip at all", () => {
    const { input } = svc().queuedPreviewRequest({
      worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", sheet: SHEET, provider: "elevenlabs",
      voiceId: "v1", line, model: ELEVEN_MODEL,
    });
    assert.equal(input.voiceReference, undefined, "an id names a catalogue voice; a clip would be noise");
  });
});
