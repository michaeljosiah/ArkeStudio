import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClientMessage, DomainEvent, ManifestModel, VoiceCandidate } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * The voiced page through the coordinator (design turn 130, SPEC-012 R-46, R-47): each block in
 * the narrator's voice or its speaker's, the speaker's only when the catalogue says the assigned
 * voice can speak now, and a cloud voice priced and named before anything plays.
 */
const CLOCK = "2026-09-06T12:00:00.000Z";
const LEDGER = "the-ledger-of-nights";
const REQUEST = "01J8F3K2QW9VZX4N7M0RTYB6H1";
// A span of the fixture's first paragraph, quoted across the file's own line wrap.
const SPAN = "kept in a hand that changes every generation";
const ELEVEN: ManifestModel = {
  id: "eleven_multilingual_v2",
  provider: "elevenlabs",
  capability: "voice-tts",
  displayName: "ElevenLabs",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { maxPromptChars: 5000, audioFormat: "mp3" },
  pricing: { kind: "perCharacter", microUsdPerCharacter: 300 },
};
const LOW_TIDE: VoiceCandidate = {
  provider: "elevenlabs",
  model: ELEVEN.id,
  voiceId: "v_8Kq2",
  label: "Low tide",
  attributes: [],
  local: false,
  canClone: false,
};

function wav(): Uint8Array {
  const samples = 8;
  const out = Buffer.alloc(44 + samples * 2);
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
  out.writeUInt32LE(samples * 2, 40);
  return new Uint8Array(out);
}

type Audio = Extract<DomainEvent, { type: "voice.audio" }>;

/**
 * A world whose first chapter has one cast line, Maren's, and a coordinator whose catalogue
 * lists her cloud voice as the test says — absent, marked, or ready to speak.
 */
async function withHarness(
  cloud: readonly VoiceCandidate[],
  run: (h: { events: DomainEvent[]; spoken: string[]; send: (message: ClientMessage) => Promise<void> }) => Promise<void>,
): Promise<void> {
  const { root, worldDir } = await makeTempRoot();
  const castDir = join(worldDir, "productions", LEDGER, ".voices");
  await mkdir(castDir, { recursive: true });
  await writeFile(
    join(castDir, "01-neap.json"),
    JSON.stringify({
      version: 4,
      hash: `sha256:${"0".repeat(64)}`,
      derivedAt: CLOCK,
      passes: 1,
      dropped: 0,
      omitted: 0,
      lines: [{ speaker: "Maren Kest", sheet: "maren-kest", paragraph: 0, occurrence: 0, quote: SPAN }],
    }),
    "utf8",
  );
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const spoken: string[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    appRoot: root,
    cipher: devCipher(),
    credentialsFileName: "credentials.dev.dat",
    manifest: { manifestVersion: 1, generated: "2026-09-06", models: [ELEVEN] },
    observeEvent: (event) => events.push(event),
    voice: {
      sidecar: {
        health: async () => ({ engineStatus: { kokoro: { ready: true } } }),
        listVoices: async () => [{ id: "bm_george", label: "George", attributes: [] }],
        synthesize: async (input: { voiceId: string; text: string }) => {
          spoken.push(input.text);
          return wav();
        },
        transcribe: async () => ({ text: "" }),
      } as never,
      localPresets: [],
      cloudSources: [{ provider: "elevenlabs", list: async () => [...cloud] }],
    },
  });
  const send = (message: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  try {
    await run({ events, spoken, send });
  } finally {
    await provider.close();
  }
}

const readVoiced = (send: (message: ClientMessage) => Promise<void>) =>
  send({ kind: "read-prose-page", requestId: REQUEST, worldId: WORLD_ID, sources: [{ of: "chapter-voiced", productionId: LEDGER, chapterId: "neap" }] });

describe("the voiced page through the coordinator (turn 130)", () => {
  it("a speaker whose assigned voice the catalogue does not list reads in the narrator's, and nothing is priced (codex on PR 914)", () =>
    withHarness([], async ({ events, spoken, send }) => {
      await readVoiced(send);
      const audio = events.filter((e): e is Audio => e.type === "voice.audio" && e.requestId === REQUEST);
      assert.ok(!audio.some((e) => e.status === "confirmation-required"), "no cloud voice can speak, so there is nothing to price");
      const line = audio.find((e) => e.sectionHeading === "Maren Kest");
      assert.ok(line, "Maren's line is a block of its own");
      assert.equal(line.status, "ready");
      assert.equal(line.provider, "kokoro", "read by the narrator: the key is gone, and the manifest alone is not availability");
      assert.ok(spoken.some((text) => text.includes(SPAN)), "and her words were made locally");
    }));

  it("a voice the catalogue marks as unable to speak now is the narrator's too", () =>
    withHarness([{ ...LOW_TIDE, unavailableReason: "the key was refused" }], async ({ events, send }) => {
      await send({ kind: "set-credential", provider: "elevenlabs", key: "k-test" });
      await readVoiced(send);
      const audio = events.filter((e): e is Audio => e.type === "voice.audio" && e.requestId === REQUEST);
      assert.ok(!audio.some((e) => e.status === "confirmation-required"));
      assert.equal(audio.find((e) => e.sectionHeading === "Maren Kest")?.provider, "kokoro");
    }));

  it("a cloud voice that can speak is priced by the character before anything plays, and the price names it (R-47)", () =>
    withHarness([LOW_TIDE], async ({ events, spoken, send }) => {
      await send({ kind: "set-credential", provider: "elevenlabs", key: "k-test" });
      await readVoiced(send);
      const asked = events.find((e): e is Audio => e.type === "voice.audio" && e.requestId === REQUEST && e.status === "confirmation-required");
      assert.ok(asked, "the page states its price once");
      assert.equal(asked.characterCount, SPAN.length, "only the cloud block is priced");
      assert.equal(asked.estimatedMicroUsd, SPAN.length * 300);
      assert.deepEqual(asked.voices, [{ label: "Low tide", provider: "elevenlabs" }], "every cloud voice the words go to, named");
      assert.equal(spoken.length, 0, "nothing sounds while the price is on the table");
    }));
});
