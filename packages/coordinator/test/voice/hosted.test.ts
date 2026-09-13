import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClientMessage, ClonedVoice, DomainEvent, ManifestModel } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { until } from "../wait.js";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { clipFor, cloneVoice, clipHashOf, recordVoiceReader } from "../../src/voice/library.js";
import { hostedReaderDestination, hostedUploadConfirmed, prepareHostedClip, type HostedVoiceSlots } from "../../src/voice/hosted.js";
import { toExtendedLength } from "../../src/world/paths.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { WorldStore } from "../../src/world/store.js";
import { FakeProvider } from "../queue/fake-provider.js";
import { makeTempRoot, makeTempWorld, WORLD_ID } from "../world/helpers.js";

/**
 * The hosted readers of the world's cloned voices (SPEC-046 issues 1146/1147): one recording,
 * read on this machine by the recipe and in the cloud by Mistral or Breeze. Two things are
 * proved here. What the library remembers of each reader — the once-per-vendor answer to "send
 * this recording?", and the slot Breeze keeps the clip under — lands on the entry and survives a
 * neighbour it cannot read. And the clip leaves only through the seam that checks the answer.
 */

const CLOCK = () => "2026-09-13T10:00:00.000Z";
const REQUEST = "01J8F3K2QW9VZX4N7M0RTYB6HD";

/** A complete RIFF/WAVE at a byte rate that makes `dataBytes` read as seconds ÷ 20. */
function wav(dataBytes: number, fill = 0): Uint8Array {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(44100, 24);
  header.writeUInt32LE(20, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return Uint8Array.from([...header, ...Array.from({ length: dataBytes }, () => fill)]);
}

/** Vendor-side slots that only remember what they were asked. */
function fakeSlots(failRemove = false) {
  const saves: Array<{ provider: string; key: string; name: string; bytes: number; contentType: string }> = [];
  const removes: Array<{ provider: string; key: string; voiceId: string }> = [];
  let counter = 0;
  const slots: HostedVoiceSlots = {
    save: async (provider, key, input) => {
      saves.push({ provider, key, name: input.name, bytes: input.clip.length, contentType: input.contentType });
      return { voiceId: `voc_${++counter}` };
    },
    remove: async (provider, key, voiceId) => {
      removes.push({ provider, key, voiceId });
      if (failRemove) throw new Error("breezeblue: synthesis failed — HTTP 500");
    },
  };
  return { slots, saves, removes };
}

describe("what the library remembers of each hosted reader (SPEC-046 R-13, R-16)", () => {
  /** The store closes in `finally`, never after the assertions: an open store hangs the runner. */
  async function withClonedVoice(
    body: (ctx: { store: WorldStore; dir: string; voice: () => ClonedVoice }) => Promise<void>,
  ): Promise<void> {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    const source = join(await tempDir("arke-hosted-"), "recording.wav");
    await writeFile(toExtendedLength(source), wav(64));
    try {
      const made = await cloneVoice(store, [], { sourcePath: source, name: "Harbour glass", description: "Low, dry, unhurried. Coastal.", consent: true });
      assert.ok(made.ok);
      // Re-read from the bundle each time: the entry changes under the tests below.
      const voice = () => {
        const current = store.getBundle().clonedVoices.find((v) => v.id === made.voice.id);
        assert.ok(current, "the voice stays in the library");
        return current;
      };
      await body({ store, dir, voice });
    } finally {
      await store.close();
    }
  }

  it("a reader's answer is written onto the entry, and a second reader's beside it, without touching the rest", async () => {
    await withClonedVoice(async ({ store, dir, voice }) => {
      assert.equal(hostedUploadConfirmed(voice(), "mistral"), false);
      await recordVoiceReader(store, "harbour-glass", "mistral", { confirmedAt: CLOCK() });
      assert.equal(hostedUploadConfirmed(voice(), "mistral"), true);
      assert.equal(hostedUploadConfirmed(voice(), "breezeblue"), false, "an answer is per vendor");
      await recordVoiceReader(store, "harbour-glass", "breezeblue", { confirmedAt: CLOCK() });
      await recordVoiceReader(store, "harbour-glass", "breezeblue", { voiceId: "voc_9", clipHash: `sha256:${"a".repeat(64)}`, savedAt: CLOCK() });
      const held = voice();
      assert.deepEqual(held.remote, {
        mistral: { confirmedAt: CLOCK() },
        breezeblue: { confirmedAt: CLOCK(), voiceId: "voc_9", clipHash: `sha256:${"a".repeat(64)}`, savedAt: CLOCK() },
      });
      // The clip, the consent and the provenance are exactly as the clone wrote them.
      assert.equal(held.clip, "voices/harbour-glass.wav");
      assert.equal(held.consent, true);
      assert.ok(held.artifactId);
      const raw = JSON.parse(await readFile(toExtendedLength(join(dir, "voices", "voices.json")), "utf8")) as { voices: Array<Record<string, unknown>> };
      assert.equal(raw.voices.length, 1);
      assert.deepEqual(raw.voices[0]?.["remote"], held.remote);
      await assert.rejects(recordVoiceReader(store, "nobody", "mistral", { confirmedAt: CLOCK() }), /no longer in this world/);
    });
  });

  it("patches the entries as read: a neighbour this build cannot parse, and a field it does not know, survive", async () => {
    const dir = await makeTempWorld();
    await mkdir(join(dir, "voices"), { recursive: true });
    const before = {
      voices: [
        { id: "harbour", name: "Harbour", clip: "voices/harbour.wav", description: "low", attributes: ["low"], fromANewerBuild: { keep: true } },
        { id: 7, name: "not a voice at all" },
      ],
    };
    await writeFile(join(dir, "voices", "voices.json"), JSON.stringify(before, null, 2) + "\n");
    const store = await WorldStore.open(dir, { clock: CLOCK });
    try {
      assert.deepEqual(store.getBundle().clonedVoices.map((v) => v.id), ["harbour"], "the read path drops the bad entry");
      await recordVoiceReader(store, "harbour", "mistral", { confirmedAt: CLOCK() });
      const after = JSON.parse(await readFile(toExtendedLength(join(dir, "voices", "voices.json")), "utf8")) as typeof before;
      assert.deepEqual(after.voices[1], before.voices[1], "the write path keeps it");
      assert.deepEqual(after.voices[0], { ...before.voices[0], remote: { mistral: { confirmedAt: CLOCK() } } });
    } finally {
      await store.close();
    }
  });

  it("the clip leaves for a reader only once the person has said so, and Mistral takes the bytes as they are (D2)", async () => {
    await withClonedVoice(async ({ store, voice }) => {
      const clip = await clipFor(store, voice());
      assert.ok(clip);
      const deps = { getKey: async () => "k", now: CLOCK };
      // The recipe reads on this machine: nothing here applies to it.
      assert.equal(await prepareHostedClip(store, "comfyui", "comfyui-cloned-voice", voice(), clip, deps), clip);
      await assert.rejects(prepareHostedClip(store, "mistral", "voxtral-mini-tts", voice(), clip, deps), /not been confirmed for Mistral/);
      await recordVoiceReader(store, "harbour-glass", "mistral", { confirmedAt: CLOCK() });
      const sent = await prepareHostedClip(store, "mistral", "voxtral-mini-tts", voice(), clip, deps);
      assert.equal(sent, clip, "the bytes ride with the call; there is no slot to address");
      assert.equal(sent.remoteVoiceId, undefined);
      assert.equal(voice().remote?.["mistral"]?.voiceId, undefined, "and nothing is recorded as kept");
    });
  });

  it("Breeze reads from a slot the library keeps: made once, reused while the clip is the same, remade when it is not (R-13, R-15)", async () => {
    await withClonedVoice(async ({ store, dir, voice }) => {
      const first = await clipFor(store, voice());
      assert.ok(first);
      await recordVoiceReader(store, "harbour-glass", "breezeblue", { confirmedAt: CLOCK() });
      await assert.rejects(prepareHostedClip(store, "breezeblue", "breeze-tts-2", voice(), first, { getKey: async () => null, now: CLOCK }), /no key in Settings/);
      await assert.rejects(prepareHostedClip(store, "breezeblue", "breeze-tts-2", voice(), first, { getKey: async () => "k", now: CLOCK }), /not configured in this build/);
      const { slots, saves, removes } = fakeSlots();
      const deps = { getKey: async () => "k", slots, now: CLOCK };

      const made = await prepareHostedClip(store, "breezeblue", "breeze-tts-2", voice(), first, deps);
      assert.equal(made.remoteVoiceId, "voc_1");
      assert.deepEqual(saves, [{ provider: "breezeblue", key: "k", name: "Harbour glass", bytes: first.data.length, contentType: "audio/wav" }]);
      assert.deepEqual(voice().remote?.["breezeblue"], { confirmedAt: CLOCK(), voiceId: "voc_1", clipHash: clipHashOf(first), savedAt: CLOCK() });

      const again = await prepareHostedClip(store, "breezeblue", "breeze-tts-2", voice(), first, deps);
      assert.equal(again.remoteVoiceId, "voc_1");
      assert.equal(saves.length, 1, "the same clip is not cloned twice");

      // The recording is replaced under the same name: the slot was made from bytes that no
      // longer exist, so it is made again, and the old one is removed rather than left counting.
      await writeFile(toExtendedLength(join(dir, "voices", "harbour-glass.wav")), wav(96, 1));
      const second = await clipFor(store, voice());
      assert.ok(second);
      assert.notEqual(clipHashOf(second), clipHashOf(first));
      const remade = await prepareHostedClip(store, "breezeblue", "breeze-tts-2", voice(), second, deps);
      assert.equal(remade.remoteVoiceId, "voc_2");
      assert.equal(saves.length, 2);
      assert.deepEqual(removes, [{ provider: "breezeblue", key: "k", voiceId: "voc_1" }]);
      assert.equal(voice().remote?.["breezeblue"]?.clipHash, clipHashOf(second));

      // A removal the vendor refuses is not this read's failure: the new slot is recorded and used.
      const failing = fakeSlots(true);
      await writeFile(toExtendedLength(join(dir, "voices", "harbour-glass.wav")), wav(128, 2));
      const third = await clipFor(store, voice());
      assert.ok(third);
      const kept = await prepareHostedClip(store, "breezeblue", "breeze-tts-2", voice(), third, { ...deps, slots: failing.slots });
      assert.equal(kept.remoteVoiceId, "voc_1", "the failing fake counts from one");
      assert.deepEqual(failing.removes, [{ provider: "breezeblue", key: "k", voiceId: "voc_2" }]);
      assert.equal(voice().remote?.["breezeblue"]?.voiceId, "voc_1");
    });
  });
});

const VOXTRAL: ManifestModel = {
  id: "voxtral-mini-tts",
  provider: "mistral",
  capability: "voice-tts",
  displayName: "Voxtral TTS",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { maxPromptChars: 4000, audioFormat: "wav" },
  pricing: { kind: "unmetered" },
};
const BREEZE: ManifestModel = { ...VOXTRAL, id: "breeze-tts-2", provider: "breezeblue", displayName: "Breeze TTS 2" };

/**
 * A world with one cloned voice, a coordinator with both hosted readers keyed and wired to fake
 * providers, and the recipe's engine remote — so the one destination that must NOT be asked
 * about for a hosted read is there to be asked.
 */
async function harness() {
  const { root, worldDir } = await makeTempRoot();
  await mkdir(join(worldDir, "voices"), { recursive: true });
  await writeFile(join(worldDir, "voices", "voices.json"), JSON.stringify({
    voices: [{ id: "harbour", name: "Harbour", clip: "voices/harbour.wav", description: "low", attributes: ["low"], consent: true }],
  }));
  await writeFile(join(worldDir, "voices", "harbour.wav"), wav(64));
  const provider = new FsWorldProvider(root, { clock: CLOCK });
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const mistral = new FakeProvider();
  mistral.artifacts = [{ name: "speech.wav", contentType: "audio/wav", data: wav(8) }];
  const breeze = new FakeProvider();
  breeze.artifacts = [{ name: "speech.wav", contentType: "audio/wav", data: wav(8) }];
  const { slots, saves, removes } = fakeSlots();
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    appRoot: root,
    cipher: devCipher(),
    credentialsFileName: "credentials.dev.dat",
    manifest: { manifestVersion: 1, generated: "2026-09-13", models: [VOXTRAL, BREEZE] },
    voice: {
      sidecar: null,
      localPresets: [],
      cloudSources: [],
      hostedReaders: [{ provider: "mistral", model: VOXTRAL.id }, { provider: "breezeblue", model: BREEZE.id }],
    },
    hostedVoiceSlots: slots,
    comfyui: {
      service: {
        status: async () => ({ engine: { locality: "remote" }, recipes: [] }),
        voiceUploadDestination: () => ({ token: "remote-instance-1", label: "voice-box.example:8188" }),
        identityFor: () => undefined,
        instanceId: () => "remote-instance-1",
        engineIdentity: () => null,
        waitUntilReady: async () => true,
        modelsDir: () => null,
        baseUrl: () => "https://voice-box.example:8188",
        applySettings: async () => {},
        subscribe: () => () => {},
        dispose: async () => {},
      } as never,
    },
    dispatchClients: { mistral, breezeblue: breeze },
    observeEvent: (event) => events.push(event),
  });
  const send = (message: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  const preview = (readerProvider: "mistral" | "breezeblue", voiceUploadConfirmedFor?: string) =>
    send({
      kind: "voice-preview",
      requestId: REQUEST,
      worldId: WORLD_ID,
      sheetId: "maren-kest",
      provider: readerProvider,
      model: readerProvider === "mistral" ? VOXTRAL.id : BREEZE.id,
      voiceId: "harbour",
      ...(voiceUploadConfirmedFor !== undefined ? { voiceUploadConfirmedFor } : {}),
    });
  const asked = () => events.filter((event) => event.type === "voice.upload-confirmation-required");
  const library = async () =>
    (JSON.parse(await readFile(join(worldDir, "voices", "voices.json"), "utf8")) as { voices: Array<{ remote?: Record<string, Record<string, string>> }> }).voices[0]!;
  return { coordinator, events, mistral, breeze, saves, removes, send, preview, asked, library };
}

describe("a vendor is a destination (SPEC-046 R-16, R-17)", () => {
  it("asks once per voice per vendor, with the vendor's terms, and remembers the answer on the entry", async () => {
    const h = await harness();
    try {
      // Inside the try: a start that throws must still stop, or the open world hangs the runner.
      await h.coordinator.start(0);
      await h.send({ kind: "set-credential", provider: "mistral", key: "mistral-test-key" });
      await h.send({ kind: "set-credential", provider: "breezeblue", key: "breeze-test-key" });

      await h.preview("mistral");
      const first = h.asked()[0];
      assert.ok(first && first.type === "voice.upload-confirmation-required");
      assert.equal(first.destinationLabel, "Mistral", "the vendor, not the recipe's remote engine");
      assert.equal(first.confirmationToken, "vendor:mistral");
      assert.equal(first.destinationNotice, hostedReaderDestination("mistral")?.notice);
      assert.match(first.destinationNotice ?? "", /sent with each read/);
      assert.equal(h.events.some((event) => event.type === "queue.enqueue-result"), false, "nothing is queued on a question");
      assert.equal(h.mistral.submitCount, 0);

      // The engine's token is not the vendor's: it is asked again, not accepted.
      h.events.length = 0;
      await h.preview("mistral", "remote-instance-1");
      assert.equal(h.asked().length, 1);
      assert.equal((await h.library()).remote, undefined);

      h.events.length = 0;
      await h.preview("mistral", "vendor:mistral");
      assert.equal(h.asked().length, 0);
      assert.match((await h.library()).remote?.["mistral"]?.["confirmedAt"] ?? "", /^20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]T/, "the answer lands where it is given");
      const accepted = h.events.find((event) => event.type === "queue.enqueue-result");
      assert.ok(accepted && accepted.type === "queue.enqueue-result");
      assert.equal(accepted.disposition, "accepted");
      await until(() => h.mistral.submitCount === 1, "the confirmed read to reach Mistral");
      const reference = h.mistral.submittedVoiceReference as { data: Uint8Array; remoteVoiceId?: string } | null;
      assert.ok(reference, "the clip rides with the call");
      assert.equal(reference.data.length, wav(64).length);
      assert.equal(reference.remoteVoiceId, undefined, "Mistral keeps no slot");
      await until(() => h.events.some((event) => event.type === "voice.audio" && event.status === "ready"), "the preview to land");

      // Breeze is another vendor: its own question, its own terms — the first answer does not carry.
      h.events.length = 0;
      await h.preview("breezeblue");
      const second = h.asked()[0];
      assert.ok(second && second.type === "voice.upload-confirmation-required");
      assert.equal(second.destinationLabel, "BreezeBlue");
      assert.equal(second.confirmationToken, "vendor:breezeblue");
      assert.match(second.destinationNotice ?? "", /saved as a voice on the account/);

      h.events.length = 0;
      await h.preview("breezeblue", "vendor:breezeblue");
      assert.equal(h.asked().length, 0);
      await until(() => h.breeze.submitCount === 1, "the confirmed read to reach Breeze");
      const slot = h.breeze.submittedVoiceReference as { remoteVoiceId?: string } | null;
      assert.equal(slot?.remoteVoiceId, "voc_1", "Breeze reads from the slot the library made on the way");
      assert.deepEqual(h.saves.map((save) => [save.provider, save.key, save.name]), [["breezeblue", "breeze-test-key", "Harbour"]]);
      const entry = await h.library();
      assert.deepEqual(Object.keys(entry.remote?.["breezeblue"] ?? {}).sort(), ["clipHash", "confirmedAt", "savedAt", "voiceId"]);
      assert.equal(entry.remote?.["breezeblue"]?.["voiceId"], "voc_1");
      assert.match(entry.remote?.["breezeblue"]?.["clipHash"] ?? "", /^sha256:[0-9a-f]{64}$/);
      assert.deepEqual(Object.keys(entry.remote?.["mistral"] ?? {}), ["confirmedAt"], "the other reader's record is untouched");
      assert.equal(h.removes.length, 0);
    } finally {
      await h.coordinator.stop();
    }
  });
});
