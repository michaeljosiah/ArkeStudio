import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { freePlanNote, quoteSpeech, type ClientMessage, type ClientState, type DomainEvent, type ManifestModel, type VoiceCandidate } from "@arke-studio/contracts";
import { GoogleClient, ProviderFreeLimitError, ProviderPaymentRequiredError } from "@arke-studio/providers";
import { until } from "../wait.js";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { FakeProvider } from "../queue/fake-provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * A provider's Free plan through the coordinator (design turn 182): the author says a key's
 * plan, the manifest every surface prices from follows it, a read on it starts at once, and the
 * two ways a free plan ends are said on the read.
 */
const CLOCK = "2026-10-02T09:14:00.000Z";
const VOXTRAL: ManifestModel = {
  id: "voxtral-mini-tts", provider: "mistral", capability: "voice-tts", displayName: "Voxtral TTS",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: { audioFormat: "wav" },
  pricing: { kind: "perCharacter", microUsdPerCharacter: 16 },
};
const GEMINI: ManifestModel = {
  id: "gemini-3.8-flash-tts", provider: "google", capability: "voice-tts", displayName: "Gemini 3.8 Flash TTS",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: { audioFormat: "wav" },
  pricing: { kind: "perToken", microUsdPerMillionInput: 500000, microUsdPerMillionOutput: 9000000,
    speech: { tier: "standard", maxInputTokens: 8192, maxOutputTokens: 16384, audioTokensPerSecond: 25, rates: [
      { version: "gemini-3.8-flash-standard-2026-09-27", effectiveFrom: "2026-09-27T00:00:00.000Z", microUsdPerMillionInput: 500000, microUsdPerMillionOutput: 9000000 },
    ] } },
};
const PAUL: VoiceCandidate = { provider: "mistral", model: VOXTRAL.id, voiceId: "en_paul_neutral", label: "Paul · neutral", attributes: [], local: false, canClone: false };
const KORE: VoiceCandidate = { provider: "google", model: GEMINI.id, voiceId: "Kore", label: "Kore", attributes: [], local: false, canClone: false };
const PUCK: VoiceCandidate = { ...KORE, voiceId: "Puck", label: "Puck" };

function wav(): Uint8Array {
  const out = Buffer.alloc(44 + 16);
  out.write("RIFF", 0, "ascii"); out.writeUInt32LE(out.length - 8, 4); out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii"); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(24_000, 24); out.writeUInt32LE(48_000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii"); out.writeUInt32LE(16, 40);
  return new Uint8Array(out);
}

type Audio = Extract<DomainEvent, { type: "voice.audio" }>;

// What the live service sent on 2026-10-02 for every block of a 122-block chapter: the per-minute
// code on the daily limit, which was retried four times a block for eighty minutes.
const OBSERVED_DAILY = { error: { message: "Rate limit exceeded for model gemini-3.8-flash-tts (limit: 10 requests per day on Free Tier). Please retry in 45m28s or upgrade your tier at https://ai.dev/rate-limit.", code: "too_many_requests" } };

class Reader extends FakeProvider {
  fail: Error | null = null;
  /** A 429 body answered through the real Google client, so its classification is the one under test. */
  refuse: unknown = null;
  attempts = 0;
  override async submit(key: string, request: Parameters<FakeProvider["submit"]>[1]): ReturnType<FakeProvider["submit"]> {
    this.attempts += 1;
    if (this.fail !== null) throw this.fail;
    if (this.refuse !== null) {
      const body = this.refuse;
      return new GoogleClient(async () => Response.json(body, { status: 429 })).submit(key, request as never) as never;
    }
    const result = await super.submit(key, request);
    // The dispatcher reads usage off a unary submission; the fake's declared return omits it.
    const answered = { ...result, artifacts: [{ name: "speech.wav", contentType: "audio/wav", data: wav() }], speechUsage: { inputTextTokens: 12, outputAudioTokens: 400 } };
    return answered;
  }
}

async function harness() {
  const { root } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const mistral = new Reader();
  const google = new Reader();
  const coordinator = new Coordinator({
    provider, adapter: null, changeLogPath: join(root, "logs", "changes.jsonl"), appVersion: "test", appRoot: root,
    cipher: devCipher(), credentialsFileName: "credentials.dev.dat",
    manifest: { manifestVersion: 1, generated: "2026-10-02", models: [VOXTRAL, GEMINI] },
    voice: { sidecar: null, localPresets: [], cloudSources: [{ provider: "mistral", list: async () => [PAUL] }, { provider: "google", list: async () => [KORE, PUCK] }] },
    dispatchClients: { mistral, google },
    observeEvent: (event) => events.push(event),
  });
  const send = (message: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  await coordinator.start(0);
  const narrateWith = async (voice: VoiceCandidate) => {
    await send({ kind: "set-credential", provider: voice.provider as "mistral" | "google", key: `${voice.provider}-test-key` });
    await send({ kind: "set-narrator", voice: { provider: voice.provider, model: voice.model, voiceId: voice.voiceId, label: voice.label } });
  };
  const audio = (requestId: string) => events.filter((event): event is Audio => event.type === "voice.audio" && event.requestId === requestId);
  const read = (requestId: string, confirmationToken?: string, defaultNarrator?: true) =>
    send({ kind: "read-sheet-section", requestId, worldId: WORLD_ID, sheetId: "maren-kest", sectionHeading: "Essence",
      ...(confirmationToken !== undefined ? { confirmationToken } : {}), ...(defaultNarrator ? { defaultNarrator } : {}) });
  const app = () => (coordinator as unknown as { readModel: { getState(): ClientState } }).readModel.getState().app;
  const settings = async () => JSON.parse(await readFile(join(root, "settings.json"), "utf8").catch(() => "{}")) as { plans?: unknown };
  return { coordinator, events, send, narrateWith, audio, read, app, settings, mistral, google, root };
}

describe("a provider's Free plan (design turn 182)", () => {
  it("is the author's statement: kept in app settings, sent with the manifest it prices, and a free credit's read starts at once", async () => {
    const h = await harness();
    try {
      await h.narrateWith(PAUL);
      await h.read("01J8F3K2QW9VZX4N7M0RTYB6R1");
      assert.ok(h.audio("01J8F3K2QW9VZX4N7M0RTYB6R1").some((event) => event.status === "confirmation-required"), "paid asks before it spends");

      await h.send({ kind: "set-provider-plan", provider: "mistral", plan: "free-credit" });
      const changed = h.events.find((event) => event.type === "provider-plans.changed");
      assert.ok(changed && changed.type === "provider-plans.changed");
      assert.equal(changed.plans.mistral, "free-credit");
      assert.equal(changed.manifest?.models.find((model) => model.id === VOXTRAL.id)?.speechPlan, "free-credit");
      assert.equal(changed.manifest?.models.find((model) => model.id === GEMINI.id)?.speechPlan, undefined);
      assert.equal(h.app().providerPlans.mistral, "free-credit");
      assert.equal(h.app().manifest?.models.find((model) => model.id === VOXTRAL.id)?.speechPlan, "free-credit");
      const files = await readFile(join(h.root, "credentials.dev.dat"), "utf8").catch(() => "");
      assert.ok(!files.includes("free-credit"), "never in the credentials file");

      await h.read("01J8F3K2QW9VZX4N7M0RTYB6R2");
      assert.ok(!h.audio("01J8F3K2QW9VZX4N7M0RTYB6R2").some((event) => event.status === "confirmation-required"), "a free credit's read asks nothing");
      await until(() => h.audio("01J8F3K2QW9VZX4N7M0RTYB6R2").some((event) => event.status === "ready"), "the credit read lands", 60_000);
      await until(() => h.app().ledger.some((entry) => entry.actualSource === "free-credit"), "the credit read settles", 60_000);
      const entry = h.app().ledger.find((row) => row.actualSource === "free-credit")!;
      assert.ok(entry.actualMicroUsd! > 0, "its estimate is kept");

      // A plan the provider does not have is ignored.
      await h.send({ kind: "set-provider-plan", provider: "mistral", plan: "free" });
      assert.equal(h.app().providerPlans.mistral, "free-credit");
    } finally {
      await h.coordinator.stop();
    }
  });

  it("reads a Google voice on Free at $0 without asking, and says the day's limit on the read", async () => {
    const h = await harness();
    try {
      await h.narrateWith(KORE);
      await h.send({ kind: "set-provider-plan", provider: "google", plan: "free" });
      await h.read("01J8F3K2QW9VZX4N7M0RTYB6R3");
      assert.ok(!h.audio("01J8F3K2QW9VZX4N7M0RTYB6R3").some((event) => event.status === "confirmation-required"), "a read that costs nothing asks nothing");
      await until(() => h.app().ledger.some((entry) => entry.actualSource === "free-plan"), "the free read settles", 60_000);
      const free = h.app().ledger.find((entry) => entry.actualSource === "free-plan")!;
      assert.equal(free.actualMicroUsd, 0);
      assert.deepEqual(free.speechUsage, { inputTextTokens: 12, outputAudioTokens: 400 }, "usage kept");

      // Another voice, so the read is not the one the cache already holds.
      await h.narrateWith(PUCK);
      h.google.fail = new ProviderFreeLimitError("Google free limit reached (HTTP 429 free daily quota)");
      await h.read("01J8F3K2QW9VZX4N7M0RTYB6R4");
      await until(() => h.audio("01J8F3K2QW9VZX4N7M0RTYB6R4").some((event) => event.status === "failed"), "the limit is said", 60_000);
      const failed = h.audio("01J8F3K2QW9VZX4N7M0RTYB6R4").find((event) => event.status === "failed")!;
      assert.equal(failed.error, "Google free limit reached");
      assert.equal(h.google.attempts, 2, "the day's limit is not retried");

      // What the limit offers: this read once in the shipped narrator, never Google again. This
      // host has no local voice, so it says that rather than reaching Google.
      await h.read("01J8F3K2QW9VZX4N7M0RTYB6R7", undefined, true);
      await until(() => h.audio("01J8F3K2QW9VZX4N7M0RTYB6R7").some((event) => event.status === "failed"), "the shipped narrator answers", 60_000);
      assert.match(h.audio("01J8F3K2QW9VZX4N7M0RTYB6R7").find((event) => event.status === "failed")!.error ?? "", /Local narration/);
      assert.equal(h.google.attempts, 2);
      assert.equal(h.app().narrator?.voiceId, PUCK.voiceId, "the author's narrator is untouched");
    } finally {
      await h.coordinator.stop();
    }
  });

  // The owner's rule (2026-10-02): a credit read past what is left of the month asks, because
  // Mistral bills the rest when pay-as-you-go is on and Arke cannot see whether it is.
  it("asks before a free credit's read once the month's credit is used", async () => {
    const h = await harness();
    try {
      await h.narrateWith(PAUL);
      await h.send({ kind: "set-provider-plan", provider: "mistral", plan: "free-credit" });
      const now = new Date().toISOString();
      const spent = {
        ts: now, worldId: WORLD_ID, jobId: "jb_01K0000000000000000000SPNT", provider: "mistral", model: VOXTRAL.id,
        outcome: "succeeded", estimatedMicroUsd: 10_000_000, actualMicroUsd: 10_000_000, actualSource: "free-credit",
        speechQuote: { ...quoteSpeech(VOXTRAL, "x", { at: now }), plan: "free-credit" },
      };
      await appendFile(join(h.root, "ledger.jsonl"), `${JSON.stringify(spent)}\n`);
      await h.read("01J8F3K2QW9VZX4N7M0RTYB6R9");
      assert.ok(h.audio("01J8F3K2QW9VZX4N7M0RTYB6R9").some((event) => event.status === "confirmation-required"), "past the credit, the read asks");
    } finally {
      await h.coordinator.stop();
    }
  });

  it("prices Google again after a payment refusal on a Free key, without turning the switch off, until the author says Free again", async () => {
    const h = await harness();
    try {
      await h.narrateWith(KORE);
      await h.send({ kind: "set-provider-plan", provider: "google", plan: "free" });
      h.google.fail = new ProviderPaymentRequiredError("Google asked for payment for this request (HTTP 402 payment_required)");
      await h.read("01J8F3K2QW9VZX4N7M0RTYB6R5");
      await until(() => h.audio("01J8F3K2QW9VZX4N7M0RTYB6R5").some((event) => event.status === "failed"), "the billed read is said", 60_000);
      assert.equal(h.audio("01J8F3K2QW9VZX4N7M0RTYB6R5").find((event) => event.status === "failed")!.error, "Google billed this read · key looks paid");
      await until(() => h.app().providerPlans.googleBilledAt !== null, "the billed mark", 60_000);
      assert.equal(h.app().providerPlans.google, "free", "never turned off unasked");
      assert.equal(h.app().manifest?.models.find((model) => model.id === GEMINI.id)?.speechPlan, undefined, "priced again");

      h.google.fail = null;
      await h.read("01J8F3K2QW9VZX4N7M0RTYB6R6");
      assert.ok(h.audio("01J8F3K2QW9VZX4N7M0RTYB6R6").some((event) => event.status === "confirmation-required"), "a priced read asks");

      await h.send({ kind: "set-provider-plan", provider: "google", plan: "free" });
      assert.equal(h.app().providerPlans.googleBilledAt, null, "Free said again clears the mark");
      assert.equal(h.app().manifest?.models.find((model) => model.id === GEMINI.id)?.speechPlan, "free-plan");
      assert.deepEqual((await h.settings()).plans, { google: "free", mistral: "paid", googleBilledAt: null });
    } finally {
      await h.coordinator.stop();
    }
  });

  // 2026-10-02, the installed app: `Read the chapter · 122 blocks · free plan` sat at
  // `reading… 0 of 122` for eighty minutes while every block was retried against a day's limit.
  it("ends a chapter at Google's daily limit rather than retrying it, says when it resets, and sends nothing more until then", async () => {
    const h = await harness();
    try {
      await h.narrateWith(KORE);
      await h.send({ kind: "set-provider-plan", provider: "google", plan: "free" });
      h.google.refuse = OBSERVED_DAILY;
      const chapter = (confirmationToken?: string) => h.send({ kind: "read-audiobook-chapter", worldId: WORLD_ID, productionId: "the-ledger-of-nights", chapterFile: "01-neap",
        ...(confirmationToken !== undefined ? { confirmationToken } : {}) });
      await chapter();
      // A chapter longer than the day asks first; this one is answered `Read until the limit`.
      const priced = h.events.find((event) => event.type === "audiobook.priced");
      if (priced?.type === "audiobook.priced") await chapter(priced.confirmationToken);
      const ending = h.events.filter((event) => event.type === "audiobook.finished").at(-1);
      assert.ok(ending?.type === "audiobook.finished");
      assert.equal(ending.outcome, "failed");
      assert.match(ending.reason ?? "", /^Google free limit reached · 10 a day · resets \d{4}-\d\d-\d\dT[\d:.]+Z$/);
      assert.match(freePlanNote(ending.reason) ?? "", /^Google free limit reached · 10 a day · resets \d\d:\d\d PT · 4[56] m$/);
      assert.equal(h.google.attempts, 1, "the day's limit is not retried");
      assert.equal(h.app().jobs.find((row) => row.provider === "google")?.failureClass, "terminal");

      // Pressed again before the reset: refused at once, nothing sent, the same note.
      await chapter();
      const again = h.events.filter((event) => event.type === "audiobook.finished").at(-1);
      assert.ok(again?.type === "audiobook.finished" && again !== ending);
      assert.equal(again.outcome, "failed");
      assert.match(again.reason ?? "", /^Google free limit reached · 10 a day · resets /);
      assert.equal(h.google.attempts, 1, "nothing more goes to Google until the reset");

      // A section, a page or a chat reply read takes the same path: refused before anything is
      // sent, in the words the free-limit stop and its shipped-narrator remedy recognise.
      await h.read("01J8F3K2QW9VZX4N7M0RTYB6RB");
      const refused = h.audio("01J8F3K2QW9VZX4N7M0RTYB6RB").find((event) => event.status === "failed");
      assert.match(refused?.error ?? "", /^Google free limit reached · 10 a day · resets \d{4}-/);
      assert.equal(h.google.attempts, 1);
    } finally {
      await h.coordinator.stop();
    }
  });

  it("asks before a free-plan chapter the day cannot cover, in the reads it needs against the day's", async () => {
    const h = await harness();
    try {
      await h.narrateWith(KORE);
      await h.send({ kind: "set-provider-plan", provider: "google", plan: "free" });
      // Nine of the day's ten already read, today, on this key.
      const now = new Date().toISOString();
      const rows = Array.from({ length: 9 }, (_, i) => JSON.stringify({
        ts: now, worldId: WORLD_ID, jobId: `jb_01K${"0".repeat(21)}F${i}`, provider: "google", model: GEMINI.id,
        outcome: "succeeded", estimatedMicroUsd: 0, actualMicroUsd: 0, actualSource: "free-plan",
        speechQuote: { ...quoteSpeech(GEMINI, "x", { at: now }), plan: "free-plan" }, speechUsage: { inputTextTokens: 1, outputAudioTokens: 25 },
      }));
      await appendFile(join(h.root, "ledger.jsonl"), `${rows.join("\n")}\n`);
      await h.send({ kind: "read-audiobook-chapter", worldId: WORLD_ID, productionId: "the-ledger-of-nights", chapterFile: "01-neap" });
      const priced = h.events.find((event) => event.type === "audiobook.priced");
      assert.ok(priced?.type === "audiobook.priced", "asked, not started");
      assert.equal(priced.estimatedMicroUsd, 0);
      assert.ok(priced.freePlan !== undefined && priced.freePlan.requests > 1);
      assert.deepEqual({ allowed: priced.freePlan.allowed, left: priced.freePlan.left }, { allowed: 10, left: 1 });
      assert.equal(h.google.attempts, 0, "nothing sent before the answer");
      assert.ok(!h.events.some((event) => event.type === "audiobook.finished"));

      // A section within the day's one read left starts at once.
      await h.read("01J8F3K2QW9VZX4N7M0RTYB6RA");
      assert.ok(!h.audio("01J8F3K2QW9VZX4N7M0RTYB6RA").some((event) => event.status === "confirmation-required"));
    } finally {
      await h.coordinator.stop();
    }
  });
});
