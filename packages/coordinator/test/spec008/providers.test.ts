import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  deriveCapabilityAvailability,
  type CapabilityProbe,
  type ModelManifest,
} from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { AppSettingsFile, routingFaults } from "../../src/app-settings.js";
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

    const availability = deriveCapabilityAvailability(service.list());
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
    // The fault takes the capability out of the availability set immediately.
    const availability = deriveCapabilityAvailability(service.list());
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
      modelRoot: null,
      extraArgs: [],
    });
    await settings.setVoxa({
      executablePath: "C:\\Program Files\\Voxa\\voxa.exe",
      extraArgs: ["--acceleration", "cpu"],
    });
    assert.deepEqual((await new AppSettingsFile(path).load()).voxa, {
      executablePath: "C:\\Program Files\\Voxa\\voxa.exe",
      modelRoot: null,
      extraArgs: ["--acceleration", "cpu"],
    });
  });
});
