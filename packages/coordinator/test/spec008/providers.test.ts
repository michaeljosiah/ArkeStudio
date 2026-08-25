import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  deriveCapabilityAvailability,
  type CapabilityProbe,
  type ModelManifest,
} from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { AppSettingsFile, availableModels, routingFaults } from "../../src/app-settings.js";
import { CredentialStore, type Cipher } from "../../src/credentials/store.js";
import { ProviderService } from "../../src/providers/service.js";
import { SecretRegistry } from "../../src/redact.js";

const cipher: Cipher = {
  isAvailable: () => true,
  encryptString: (p) => Buffer.from(p, "utf8"),
  decryptString: (b) => b.toString("utf8"),
};

async function makeService(probes: CapabilityProbe[] | Error) {
  const dir = await tempDir("arke-prov-");
  const credentials = new CredentialStore(
    join(dir, "credentials.dat"),
    cipher,
    new SecretRegistry(),
    async () => {},
  );
  await credentials.set("fal", "sk-fal-testkey-000000000");
  const service = new ProviderService(
    credentials,
    {
      fal: {
        validateKey: async () => {
          if (probes instanceof Error) throw probes;
          return probes;
        },
      },
    },
    null,
  );
  await service.init();
  return service;
}

describe("provider statuses and availability (R-1..R-4, §3.2)", () => {
  it("a key that authenticates but lacks video reports image available, video not (R-3)", async () => {
    const service = await makeService([
      { capability: "image", available: true },
      { capability: "video", available: false, reason: "no video access on this plan" },
    ]);
    const status = await service.validate("fal");
    assert.equal(status.validation, "valid", "the key works — for what it works for");
    assert.deepEqual(
      status.probes.map((p) => [p.capability, p.available]),
      [
        ["image", true],
        ["video", false],
      ],
    );

    // Derived over the cloud statuses alone: comfyui is a local video/image provider now
    // (SPEC-021), and like kokoro it unlocks its capabilities by existing — its concrete
    // recipes are gated by readiness and enqueue admission, not by this derivation. The point
    // of THIS test is what fal's probes say, so the derivation is scoped to fal.
    const availability = deriveCapabilityAvailability(service.list().filter((s) => s.id === "fal"));
    const video = availability.find((a) => a.capability === "video");
    assert.equal(video?.available, false);
    assert.match(video!.reason!, /no configured provider's key unlocks video/);
    const image = availability.find((a) => a.capability === "image");
    assert.equal(image?.available, true);
    assert.deepEqual(image?.via, ["fal"]);
  });

  it("a capability with nobody configured is present with its reason, never silently absent (R-2)", async () => {
    const service = await makeService([]);
    const availability = deriveCapabilityAvailability(service.list());
    const clone = availability.find((a) => a.capability === "voice-clone");
    assert.equal(clone?.available, false);
    assert.match(clone!.reason!, /no provider is configured/);
  });

  it("a probe failure marks the provider invalid with the message, not a crash", async () => {
    const service = await makeService(new Error("connect ETIMEDOUT"));
    const status = await service.validate("fal");
    assert.equal(status.validation, "invalid");
    assert.match(status.probes[0]!.reason!, /ETIMEDOUT/);
  });

  it("a mid-session credential failure is a provider fault, not a work failure (R-4)", async () => {
    const service = await makeService([{ capability: "image", available: true }]);
    await service.validate("fal");
    const faulted = service.markFault("fal", "FAL rejected the key mid-session (HTTP 401)");
    assert.equal(faulted.fault, "FAL rejected the key mid-session (HTTP 401)");
    // The fault takes the capability out of the availability set immediately — scoped to fal
    // for the same reason as above: comfyui also serves image, and its optimism is not what
    // this test is about.
    const availability = deriveCapabilityAvailability(service.list().filter((s) => s.id === "fal"));
    assert.equal(availability.find((a) => a.capability === "image")?.available, false);
  });

  it("local runtimes are configured without any key (R-18 posture)", async () => {
    const service = await makeService([]);
    const ollama = service.list().find((s) => s.id === "ollama");
    assert.equal(ollama?.configured, true);
  });
});

const manifest: ModelManifest = {
  manifestVersion: 7,
  generated: "2026-07-28",
  models: [
    {
      id: "seedance-2.0",
      provider: "fal",
      capability: "video",
      displayName: "Seedance 2.0",
      accepts: { referenceImages: 4, startFrame: true, endFrame: true },
      limits: {},
      pricing: { kind: "perSecond", microUsdPerSecond: 21667 },
    },
    {
      id: "flux-pro-1.1",
      provider: "fal",
      capability: "image",
      displayName: "FLUX Pro 1.1",
      accepts: { referenceImages: 1, startFrame: false, endFrame: false },
      limits: {},
      pricing: { kind: "perImage", microUsdPerImage: 40000 },
    },
  ],
};

describe("routing defaults resolve to concrete models (R-20, R-21 posture, D1)", () => {
  it("stores the model on change, refuses the unknown and the mismatched", async () => {
    const dir = await tempDir("arke-settings-");
    const settings = new AppSettingsFile(join(dir, "settings.json"));

    assert.deepEqual(await settings.setRoutingDefault("video", "seedance-2.0", manifest), { ok: true });
    const unknown = await settings.setRoutingDefault("video", "sora-9000", manifest);
    assert.ok(!unknown.ok && /not in the model manifest/.test(unknown.reason));
    const mismatched = await settings.setRoutingDefault("video", "flux-pro-1.1", manifest);
    assert.ok(!mismatched.ok && /image model, not video/.test(mismatched.reason));

    const loaded = await settings.load();
    assert.equal(loaded.routing["video"], "seedance-2.0", "refusals never clobber the stored default");
  });

  it("a default whose model left the manifest surfaces as a named routing fault (§2.7)", async () => {
    const dir = await tempDir("arke-settings-");
    const settings = new AppSettingsFile(join(dir, "settings.json"));
    await settings.setRoutingDefault("video", "seedance-2.0", manifest);
    const shrunk: ModelManifest = {
      ...manifest,
      models: manifest.models.filter((m) => m.id !== "seedance-2.0"),
    };
    const faults = routingFaults(await settings.load(), shrunk);
    assert.equal(faults.length, 1);
    assert.equal(faults[0]!.capability, "video");
    assert.match(faults[0]!.reason, /no longer in the manifest/);
  });
});

describe("which models this studio offers (SPEC-008 §2.7)", () => {
  it("everything is on until it is switched off, so an untouched settings file changes nothing", async () => {
    const dir = await tempDir("arke-settings-");
    const settings = new AppSettingsFile(join(dir, "settings.json"));
    const loaded = await settings.load();
    assert.deepEqual(loaded.models.disabled, []);
    assert.equal(
      availableModels(loaded, manifest).length,
      manifest.models.length,
      "an absent record means the whole manifest, not an empty roster",
    );
  });

  it("switching one off removes it from what is offered, and switching it back restores it", async () => {
    const dir = await tempDir("arke-settings-");
    const settings = new AppSettingsFile(join(dir, "settings.json"));

    await settings.setModelEnabled("seedance-2.0", false);
    const off = await settings.load();
    assert.deepEqual(off.models.disabled, ["seedance-2.0"]);
    assert.ok(!availableModels(off, manifest).some((m) => m.id === "seedance-2.0"));

    await settings.setModelEnabled("seedance-2.0", true);
    assert.deepEqual((await settings.load()).models.disabled, []);
  });

  it("switching off a routed model strands the default rather than re-routing it", async () => {
    const dir = await tempDir("arke-settings-");
    const settings = new AppSettingsFile(join(dir, "settings.json"));
    await settings.setRoutingDefault("video", "seedance-2.0", manifest);
    await settings.setModelEnabled("seedance-2.0", false);

    const loaded = await settings.load();
    assert.equal(loaded.routing["video"], "seedance-2.0", "the choice is left where the user put it");
    const faults = routingFaults(loaded, manifest);
    assert.equal(faults.length, 1);
    assert.equal(faults[0]!.capability, "video");
    assert.match(faults[0]!.reason, /switched off in Providers/);
  });

  it("refuses to route to a model that is switched off", async () => {
    const dir = await tempDir("arke-settings-");
    const settings = new AppSettingsFile(join(dir, "settings.json"));
    await settings.setModelEnabled("seedance-2.0", false);
    const refused = await settings.setRoutingDefault("video", "seedance-2.0", manifest);
    assert.ok(!refused.ok && /switched off in Providers/.test(refused.reason));
    assert.equal((await settings.load()).routing["video"], undefined);
  });
});

describe("settings file durability", () => {
  it("serializes Promise.all mutations across instances without losing either update", async () => {
    const dir = await tempDir("arke-settings-");
    const path = join(dir, "settings.json");
    const first = new AppSettingsFile(path);
    const second = new AppSettingsFile(path);

    // Prime both readers with the same state. A per-instance cache then makes the old race
    // deterministic: both mutations derive a complete replacement from that stale snapshot.
    await Promise.all([first.load(), second.load()]);
    await Promise.all([first.setResearchWeb(true), second.setAppearanceTheme("dark")]);

    const stored = await new AppSettingsFile(path).load();
    assert.equal(stored.research.web, true);
    assert.equal(stored.appearance.theme, "dark");
  });

  it("reports malformed JSON and preserves it byte-for-byte when a mutation is attempted", async () => {
    const dir = await tempDir("arke-settings-");
    const path = join(dir, "settings.json");
    const malformed = '{"routing":{"video":"seedance-2.0"},';
    await writeFile(path, malformed, "utf8");
    const settings = new AppSettingsFile(path);

    await assert.rejects(() => settings.load(), /contains malformed JSON/);
    await assert.rejects(() => settings.setAppearanceTheme("dark"), /contains malformed JSON/);
    assert.equal(
      await readFile(path, "utf8"),
      malformed,
      "the source is reported, never replaced by defaults",
    );
  });

  it("reports an unguarded schema failure without discarding otherwise valid settings", async () => {
    const dir = await tempDir("arke-settings-");
    const path = join(dir, "settings.json");
    const source = JSON.stringify({
      routing: { video: "seedance-2.0" },
      spend: { thresholdMicroUsd: "many", periodDays: 30 },
      appearance: { theme: "dark" },
    });
    await writeFile(path, source, "utf8");
    const settings = new AppSettingsFile(path);

    await assert.rejects(() => settings.setResearchWeb(true), /does not match the current schema/);
    assert.equal(
      await readFile(path, "utf8"),
      source,
      "valid sibling blocks remain available for manual recovery",
    );
  });

  it("recovers malformed guarded blocks independently while retaining valid siblings", async () => {
    const dir = await tempDir("arke-settings-");
    const path = join(dir, "settings.json");
    await writeFile(
      path,
      JSON.stringify({
        research: { web: true },
        routing: { video: "seedance-2.0" },
        models: { disabled: ["flux-pro-1.1"] },
        spend: { thresholdMicroUsd: 500_000, periodDays: 30 },
        appearance: { theme: "sepia" },
        voxa: { executablePath: 42 },
        comfyui: { enginePath: false },
        narrator: { provider: "elevenlabs" },
        harness: { engine: "unknown" },
        presets: [{ this: "is not a preset" }],
      }),
      "utf8",
    );

    const settings = new AppSettingsFile(path);
    const recovered = await settings.load();
    assert.equal(recovered.research.web, true);
    assert.equal(recovered.routing.video, "seedance-2.0");
    assert.deepEqual(recovered.models.disabled, ["flux-pro-1.1"]);
    assert.deepEqual(recovered.spend, { thresholdMicroUsd: 500_000, periodDays: 30 });
    assert.deepEqual(recovered.appearance, { theme: "system" });
    assert.deepEqual(recovered.voxa, { executablePath: null, extraArgs: [] });
    assert.deepEqual(recovered.comfyui, { enginePath: null, engineUrl: null, modelsDir: null });
    assert.equal(recovered.narrator, null);
    assert.deepEqual(recovered.harness, { engine: "opencode", claudePath: null });
    assert.deepEqual(recovered.presets, []);

    await settings.setAppearanceTheme("dark");
    const persisted = await new AppSettingsFile(path).load();
    assert.equal(persisted.routing.video, "seedance-2.0", "repair keeps independently valid choices");
    assert.deepEqual(persisted.spend, { thresholdMicroUsd: 500_000, periodDays: 30 });
    assert.equal(persisted.appearance.theme, "dark");
  });
});

describe("background notification settings", () => {
  it("defaults conservatively and persists each explicit preference", async () => {
    const dir = await tempDir("arke-settings-");
    const settings = new AppSettingsFile(join(dir, "settings.json"));
    assert.equal((await settings.load()).backgroundNotifications, "issues-only");
    await settings.setBackgroundNotifications("background-results-and-issues");
    assert.equal((await settings.load()).backgroundNotifications, "background-results-and-issues");
    await settings.setBackgroundNotifications("off");
    assert.equal((await settings.load()).backgroundNotifications, "off");
  });
});

describe("appearance settings", () => {
  it("defaults to system, persists explicit themes, and repairs malformed appearance only", async () => {
    const dir = await tempDir("arke-settings-");
    const path = join(dir, "settings.json");
    const settings = new AppSettingsFile(path);
    assert.equal((await settings.load()).appearance.theme, "system");
    await settings.setAppearanceTheme("dark");
    assert.equal((await new AppSettingsFile(path).load()).appearance.theme, "dark");

    await writeFile(
      path,
      JSON.stringify({ routing: { video: "seedance-2.0" }, appearance: { theme: "sepia" } }),
      "utf8",
    );
    const repaired = await new AppSettingsFile(path).load();
    assert.equal(repaired.appearance.theme, "system");
    assert.equal(repaired.routing.video, "seedance-2.0");
  });
});

describe("Voxa settings", () => {
  it("defaults safely and persists a configured executable as an argument-free path", async () => {
    const dir = await tempDir("arke-settings-");
    const path = join(dir, "settings.json");
    const settings = new AppSettingsFile(path);
    assert.deepEqual((await settings.load()).voxa, {
      executablePath: null,
      extraArgs: [],
    });
    await settings.setVoxa({
      executablePath: "C:\\Program Files\\Voxa\\voxa.exe",
      extraArgs: ["--acceleration", "cpu"],
    });
    assert.deepEqual((await new AppSettingsFile(path).load()).voxa, {
      executablePath: "C:\\Program Files\\Voxa\\voxa.exe",
      extraArgs: ["--acceleration", "cpu"],
    });
  });

  it("migrates the unsupported custom model root without discarding other Voxa settings", async () => {
    const dir = await tempDir("arke-settings-");
    const path = join(dir, "settings.json");
    await writeFile(
      path,
      JSON.stringify({
        voxa: {
          executablePath: "C:\\Program Files\\Voxa\\voxa.exe",
          modelRoot: "D:\\speech-models",
          extraArgs: ["--acceleration", "cpu"],
        },
      }),
      "utf8",
    );

    const settings = new AppSettingsFile(path);
    assert.deepEqual((await settings.load()).voxa, {
      executablePath: "C:\\Program Files\\Voxa\\voxa.exe",
      extraArgs: ["--acceleration", "cpu"],
    });
    await settings.setVoxa({ extraArgs: ["--acceleration", "cpu", "--trace"] });
    assert.equal(
      (await readFile(path, "utf8")).includes("modelRoot"),
      false,
      "the next write completes migration",
    );
  });
});
