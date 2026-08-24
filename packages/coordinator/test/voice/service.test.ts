import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DomainEvent, LedgerEntry, ManifestModel, Sheet, WorldBundle } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { JobQueue } from "../../src/queue/dispatcher.js";
import { authoritativeBibleSpeech, authoritativeSheetSpeech, normalizeSpeechText, previewCacheFile, speechCacheFile, VoiceService, voiceLineRequest } from "../../src/voice/service.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { FakeProvider } from "../queue/fake-provider.js";
import { AppSettingsFile } from "../../src/app-settings.js";

const CLOCK = () => "2026-08-01T12:00:00.000Z";

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

function fakeSidecar() {
  const calls: string[] = [];
  return {
    calls,
    listVoices: async () => {
      calls.push("voices");
      return [{ id: "af_bella", label: "Bella", attributes: ["low", "warm"] }];
    },
    synthesize: async (input: { voiceId: string; text: string }) => {
      calls.push(`tts:${input.voiceId}`);
      return new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69]);
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
    assert.equal(bytes.length, 12);
    assert.deepEqual(sidecar.calls, ["tts:af_bella"], "one synthesis, no queue, no ledger — zero cost");

    const again = await service.localPreview(store, SHEET, "af_bella", line);
    assert.equal(again, file);
    assert.deepEqual(sidecar.calls, ["tts:af_bella"], "the cache replays without any call at all (R-10)");
    await store.close();
  });

  it("an ElevenLabs line goes through the queue, idempotency-protected, and writes one ledger entry", async () => {
    const fake = new FakeProvider({ supportsIdempotencyKey: true });
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
    assert.ok(job.idempotencyKey.length === 26, "idempotency-protected before submission (R-2)");
    const start = Date.now();
    while (queue.listJobs().find((j) => j.id === job.id)?.status !== "succeeded") {
      if (Date.now() - start > 3000) throw new Error("job did not finish");
      await new Promise((r) => setTimeout(r, 5));
    }
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
            { provider: "elevenlabs", voiceId: "v1", label: "Harbour", attributes: ["low", "even"], local: false, canClone: true },
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

  it("an unkeyed cloud source contributes nothing; the catalogue stays uniform", async () => {
    const service = new VoiceService({
      sidecar: null,
      localPresets: [
        { provider: "kokoro", voiceId: "af_bella", label: "Bella", attributes: ["low"], local: true, canClone: false },
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
        { provider: "kokoro", voiceId: "bm_george", label: "George", attributes: ["low", "gravel"], local: true, canClone: false },
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
    limits: { maxPromptChars: 2000 },
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
      speakerFile: "C:/worlds/undersong/voices/harbour-glass.wav",
    });
    assert.equal(input.provider, "comfyui");
    assert.equal(input.params["speakerFile"], "C:/worlds/undersong/voices/harbour-glass.wav");
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
      voiceId: "v1", line, model: RECIPE, speakerFile: "clip.wav",
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
    assert.ok(!("speakerFile" in input.params), "an id names a catalogue voice; a clip would be noise");
  });
});
