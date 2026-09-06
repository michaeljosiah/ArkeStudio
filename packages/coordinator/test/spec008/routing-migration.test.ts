import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { ModelManifest } from "@arke-studio/contracts";
import { AppSettingsFile, routingFaults } from "../../src/app-settings.js";
import { tempDir } from "../tmp.js";

/**
 * What SPEC-033 R-66 parked comes back, and what nothing can replace goes (SPEC-034 R-18).
 *
 * R-66 moved local capability defaults out of `routing` because Cloud AI was cloud-only and could
 * neither show nor change them. R-15 makes them reachable on the screen that sets them, so the
 * condition is discharged and the move is undone — the record kept the concrete model id
 * precisely so it could be read back.
 *
 * `llm` is the exception, in both places. R-17 removes its picker, so restoring one would put back
 * a setting nothing reads and nothing can replace, and `routingFaults` iterates every persisted
 * entry — so it could then raise a fault General offers no control to answer.
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
      id: "comfyui-draft-video",
      provider: "comfyui",
      capability: "video",
      displayName: "Draft video",
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

async function settingsFile() {
  const root = await tempDir("arke-settings-");
  return new AppSettingsFile(join(root, "settings.json"));
}

/** Write the file the way an installation carrying R-66's record has it on disk. */
async function seed(file: AppSettingsFile, patch: Record<string, unknown>) {
  const settings = await file.load();
  await writeFile((file as unknown as { path: string }).path, JSON.stringify({ ...settings, ...patch }, null, 2));
}

describe("the parked local defaults come back (SPEC-034 R-18)", () => {
  it("restores a parked entry into routing and empties the record", async () => {
    const file = await settingsFile();
    await seed(file, { clearedLocalRouting: { video: "comfyui-draft-video" }, routing: {} });

    const after = await file.load();
    assert.equal(after.routing.video, "comfyui-draft-video", "back where the person chose it");
    assert.deepEqual(after.clearedLocalRouting, {}, "and the record it was parked in is spent");
  });

  it("lets an active default outrank a parked one for the same capability", async () => {
    // The parked entry is the older decision by construction — R-66 moved it aside, and anything
    // in `routing` for that capability was chosen after.
    const file = await settingsFile();
    await seed(file, {
      clearedLocalRouting: { video: "comfyui-draft-video" },
      routing: { video: "seedance-2.0" },
    });
    assert.equal((await file.load()).routing.video, "seedance-2.0");
  });

  it("deletes every llm entry, parked and active (R-17)", async () => {
    const file = await settingsFile();
    await seed(file, { clearedLocalRouting: { llm: "gemma4-12b" }, routing: { llm: "gpt-5" } });

    const after = await file.load();
    assert.equal(after.routing.llm, undefined, "the picker it belonged to is gone");
    assert.deepEqual(after.clearedLocalRouting, {});
    // And no fault is raised for a setting nothing can answer.
    assert.deepEqual(routingFaults(after, MANIFEST), []);
  });

  it("leaves an installation that never had one untouched", async () => {
    const file = await settingsFile();
    await file.setRoutingDefault("video", "seedance-2.0", MANIFEST, true);
    const after = await file.load();
    assert.equal(after.routing.video, "seedance-2.0");
    assert.deepEqual(after.clearedLocalRouting, {});
  });
});

describe("the routing write refuses what cannot run (SPEC-034 R-15a)", () => {
  it("accepts a local model that is eligible", async () => {
    const file = await settingsFile();
    const ok = await file.setRoutingDefault("llm", "gemma4-12b", MANIFEST, true);
    assert.deepEqual(ok, { ok: true }, "R-61's cloud-only filter is gone");
    assert.equal((await file.load()).routing.llm, undefined, "though llm itself no longer survives a load");
  });

  it("refuses one that is not, whatever put the message on the wire", async () => {
    // The picker disabling the option is the courtesy; this is the guarantee. Before R-15a the
    // write saw only the manifest and the disabled set, so a runtime that never started could
    // still become the default.
    const file = await settingsFile();
    const refused = await file.setRoutingDefault("video", "comfyui-draft-video", MANIFEST, false);
    assert.equal(refused.ok, false);
    assert.match((refused as { reason: string }).reason, /cannot run right now/);
    assert.equal((await file.load()).routing.video, undefined);
  });

  it("still refuses a model that is switched off, or of the wrong capability", async () => {
    const file = await settingsFile();
    const wrong = await file.setRoutingDefault("video", "gpt-5", MANIFEST, true);
    assert.equal(wrong.ok, false);
    await file.setModelEnabled("seedance-2.0", false);
    const off = await file.setRoutingDefault("video", "seedance-2.0", MANIFEST, true);
    assert.equal(off.ok, false);
  });
});

describe("a local default is an ordinary default, not a fault (SPEC-034 R-15)", () => {
  it("raises nothing for a local model in routing", async () => {
    // SPEC-033 R-61 kept them off the screen, so one surviving in `routing` meant R-66's move had
    // failed and the setting was in force, invisible and unchangeable — a fault worth stating.
    // R-15 makes it an ordinary choice, and the fault that flagged it would otherwise have fired
    // on this feature's own success path, above the row that had just accepted it.
    const file = await settingsFile();
    await file.setRoutingDefault("video", "comfyui-draft-video", MANIFEST, true);
    assert.deepEqual(routingFaults(await file.load(), MANIFEST), []);
  });

  it("raises nothing after the migration restores one", async () => {
    const file = await settingsFile();
    await seed(file, { clearedLocalRouting: { video: "comfyui-draft-video" }, routing: {} });
    assert.deepEqual(routingFaults(await file.load(), MANIFEST), []);
  });

  it("still strands one that was switched off, or that left the manifest", async () => {
    // The two ways a default can go bad are unchanged. A runtime that never started is neither,
    // and is not visible from here — which is why R-15a guards the write instead.
    const file = await settingsFile();
    await file.setRoutingDefault("video", "comfyui-draft-video", MANIFEST, true);
    await file.setModelEnabled("comfyui-draft-video", false);
    const faults = routingFaults(await file.load(), MANIFEST);
    assert.equal(faults.length, 1);
    assert.match(faults[0]!.reason, /switched off in AI models/);
  });
});
