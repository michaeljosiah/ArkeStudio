import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { Capability, ModelManifest } from "@arke-studio/contracts";
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
      id: "gpt-5",
      provider: "openai",
      capability: "llm",
      displayName: "GPT-5",
      accepts: { referenceImages: 0, startFrame: false, endFrame: false },
      limits: {},
      pricing: { kind: "perToken", microUsdPerMillionInput: 1, microUsdPerMillionOutput: 1 },
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

/**
 * A local routing default as an installation that predates R-61 has it on disk. `setRoutingDefault`
 * refuses one now, which is the point — but the file it refuses to write is exactly the file this
 * migration exists for.
 */
async function seedLocalDefault(file: AppSettingsFile, capability: Capability, modelId: string) {
  const settings = await file.load();
  await writeFile(
    (file as unknown as { path: string }).path,
    JSON.stringify({ ...settings, routing: { ...settings.routing, [capability]: modelId } }, null, 2),
  );
}

async function settingsFile() {
  const root = await tempDir("arke-settings-");
  return new AppSettingsFile(join(root, "settings.json"));
}

describe("a local capability default is moved, never left in force (R-66)", () => {
  it("takes it out of routing and keeps its concrete model id", async () => {
    const file = await settingsFile();
    // Written the way an installation that predates R-61 has it on disk: the picker used to
    // offer a local model, so `setRoutingDefault` used to accept one.
    await seedLocalDefault(file, "llm", "gemma4-12b");
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

    await seedLocalDefault(file, "llm", "gemma4-12b");
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
    await seedLocalDefault(file, "llm", "gemma4-12b");
    await file.clearLocalRouting(isLocal);

    const reopened = await new AppSettingsFile(path).load();
    assert.equal(reopened.routing.llm, undefined);
    assert.equal(reopened.clearedLocalRouting.llm, "gemma4-12b");
  });

  it("is retired the moment a default is set for that capability", async () => {
    // Otherwise the notice outlives its answer, and sits above a green row insisting the
    // capability has nowhere to go.
    const file = await settingsFile();
    await seedLocalDefault(file, "llm", "gemma4-12b");
    await file.clearLocalRouting(isLocal);
    const after = await file.setRoutingDefault("llm", "gpt-5", MANIFEST);
    assert.deepEqual(after, { ok: true });
    const settings = await file.load();
    assert.equal(settings.routing.llm, "gpt-5");
    assert.deepEqual(settings.clearedLocalRouting, {});
  });

  it("refuses a local model as a routing default, so a cleared one cannot come back (R-61)", async () => {
    const file = await settingsFile();
    const refusal = await file.setRoutingDefault("llm", "gemma4-12b", MANIFEST);
    assert.equal(refusal.ok, false);
    assert.match(refusal.reason, /runs on this machine/);
  });

  it("states a local model that survived the move, because that is the outcome D21 refuses", async () => {
    // The move can fail — a locked settings file — and swallowing it leaves the default in force
    // at dispatch while Cloud AI can no longer show or change it.
    const file = await settingsFile();
    await file.setRoutingDefault("video", "seedance-2.0", MANIFEST);
    const settings = await file.load();
    const stuck = routingFaults({ ...settings, routing: { ...settings.routing, llm: "gemma4-12b" } }, MANIFEST);
    const fault = stuck.find((f) => f.capability === "llm");
    assert.ok(fault, "silence here is the outcome D21 refuses");
    assert.match(fault.reason, /still in force at dispatch/);
  });
});
