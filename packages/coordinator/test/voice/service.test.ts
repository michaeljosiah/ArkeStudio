import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DomainEvent, LedgerEntry, ManifestModel, Sheet, WorldBundle } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { JobQueue } from "../../src/queue/dispatcher.js";
import { authoritativeSheetSpeech, normalizeSpeechText, previewCacheFile, speechCacheFile, VoiceService, voiceLineRequest } from "../../src/voice/service.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { FakeProvider } from "../queue/fake-provider.js";

const CLOCK = () => "2026-08-01T12:00:00.000Z";

const ELEVEN_MODEL: ManifestModel = {
  id: "eleven-v3",
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
  it("includes model, format, settings and normalized text", () => {
    const base = { provider: "kokoro" as const, model: "kokoro-82m", voiceId: "af_bella", text: "hello   harbour", format: "wav" as const };
    assert.equal(normalizeSpeechText(base.text), "hello harbour");
    assert.equal(speechCacheFile(base), speechCacheFile({ ...base, text: " hello harbour " }));
    assert.notEqual(speechCacheFile(base), speechCacheFile({ ...base, model: "kokoro-82m-v2" }));
    assert.notEqual(speechCacheFile(base), speechCacheFile({ ...base, format: "mp3" }));
  });
});

describe("authoritative sheet speech", () => {
  it("reads exact normalized Essence from a supported assignment", () => {
    assert.deepEqual(authoritativeSheetSpeech(SHEET, "Essence"), {
      text: "Tide-caller",
      provider: "elevenlabs",
      voiceId: "v_8Kq2",
    });
  });

  it("reads Appearance too, and rejects unknown headings, empty text, and legacy assignments", () => {
    const withAppearance = {
      ...SHEET,
      sections: [...SHEET.sections, { heading: "Appearance", body: "Salt-crusted braids, pale grey eyes." }],
    } as Sheet;
    assert.deepEqual(authoritativeSheetSpeech(withAppearance, "Appearance"), {
      text: "Salt-crusted braids, pale grey eyes.",
      provider: "elevenlabs",
      voiceId: "v_8Kq2",
    });
    assert.throws(() => authoritativeSheetSpeech(SHEET, "Relationships"), /not available/);
    assert.throws(() => authoritativeSheetSpeech({ ...SHEET, voice: { ...SHEET.voice!, provider: "openai" } } as Sheet, "Essence"), /supported voice/);
    assert.throws(() => authoritativeSheetSpeech({ ...SHEET, sections: [{ heading: "Essence", body: "  " }] } as Sheet, "Essence"), /Nothing to read/);
  });
});
