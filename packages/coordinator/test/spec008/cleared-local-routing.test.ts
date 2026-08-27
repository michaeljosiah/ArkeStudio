import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import type { ModelManifest } from "@arke-studio/contracts";
import { AppSettingsFile, routingFaults } from "../../src/app-settings.js";
import { tempDir } from "../tmp.js";

/**
 * Cloud AI cannot ship while a local capability default is in force and unreachable
 * (SPEC-033 R-66, D21).
 *
 * A local default was a real, reachable setting: a local model was selectable without a key, so
 * `llm → gemma4-12b` put all writing on this machine. Cloud AI is cloud-only by construction, so
 * it cannot keep offering it. Three outcomes were available — keep it, replace it, or remove it
 * and leave it in force but invisible. The third is the worst, and it is the one that happens by
 * default if nobody decides, so it is refused explicitly.
 */

const MANIFEST: ModelManifest = {
  manifestVersion: 1,
  generated: "2026-08-27",
  models: [
    {
      id: "gemma4-12b",
      provider: "ollama",
      capability: "llm",
      displayName: "Gemma 4 12B",
      accepts: { referenceImages: 0, startFrame: false, endFrame: false },
      limits: {},
      pricing: { kind: "unmetered" },
    },
    {
      id: "seedance-2.0",
      provider: "fal",
      capability: "video",
      displayName: "Seedance 2.0",
      accepts: { referenceImages: 0, startFrame: false, endFrame: false },
      limits: {},
      pricing: { kind: "perSecond", microUsdPerSecond: 1 },
    },
  ],
};

const LOCAL = new Set(["gemma4-12b"]);
const isLocal = (modelId: string) => LOCAL.has(modelId);

async function settingsFile() {
  const root = await tempDir("arke-settings-");
  return new AppSettingsFile(join(root, "settings.json"));
}

describe("a local capability default is moved, never left in force (R-66)", () => {
  it("takes it out of routing and keeps its concrete model id", async () => {
    const file = await settingsFile();
    await file.setRoutingDefault("llm", "gemma4-12b", MANIFEST);
    await file.setRoutingDefault("video", "seedance-2.0", MANIFEST);

    const after = await file.clearLocalRouting(isLocal);
    assert.equal(after.routing.llm, undefined, "not in force anywhere");
    assert.equal(after.routing.video, "seedance-2.0", "a cloud default is still a routing default");
    // The concrete id survives, which is the difference between a setting that moved and one
    // that vanished: Cloud AI can name it.
    assert.equal(after.clearedLocalRouting.llm, "gemma4-12b");
  });

  it("is idempotent, and a no-op where nothing local was routed", async () => {
    const file = await settingsFile();
    await file.setRoutingDefault("video", "seedance-2.0", MANIFEST);
    const first = await file.clearLocalRouting(isLocal);
    assert.deepEqual(first.clearedLocalRouting, {});

    await file.setRoutingDefault("llm", "gemma4-12b", MANIFEST);
    await file.clearLocalRouting(isLocal);
    const twice = await file.clearLocalRouting(isLocal);
    assert.deepEqual(twice.clearedLocalRouting, { llm: "gemma4-12b" });
    assert.equal(twice.routing.llm, undefined);
  });

  it("survives a reload, so the statement is not lost to a restart", async () => {
    // Somebody who restarts before reading the notice must still be told. The record is on disk
    // rather than in the session, which is the difference between saying it and having said it.
    const root = await tempDir("arke-settings-");
    const path = join(root, "settings.json");
    const file = new AppSettingsFile(path);
    await file.setRoutingDefault("llm", "gemma4-12b", MANIFEST);
    await file.clearLocalRouting(isLocal);

    const reopened = await new AppSettingsFile(path).load();
    assert.equal(reopened.routing.llm, undefined);
    assert.equal(reopened.clearedLocalRouting.llm, "gemma4-12b");
  });

  it("is stated by name, with where the choice now lives (R-66's second clause)", async () => {
    const file = await settingsFile();
    await file.setRoutingDefault("llm", "gemma4-12b", MANIFEST);
    await file.clearLocalRouting(isLocal);
    const faults = routingFaults(await file.load(), MANIFEST);
    const cleared = faults.find((f) => f.capability === "llm");
    assert.ok(cleared, "silence here is the outcome D21 refuses");
    assert.equal(cleared.modelId, "gemma4-12b");
    assert.match(cleared.reason, /Gemma 4 12B ran on this machine and was cleared here/);
    assert.match(cleared.reason, /chosen per production, at dispatch/);
  });
});
