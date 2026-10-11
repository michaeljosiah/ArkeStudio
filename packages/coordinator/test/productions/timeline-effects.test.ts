import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultEffectClip, ProductionTimelineSchema, storyTimelineFingerprint, type ProductionTimeline } from "@arke-studio/contracts";
import { applyHumanTimelineCommand, applyTimelineCommand, TimelineCommandRefused } from "../../src/productions/timeline.js";
import { carriesEditorEffects } from "../../src/productions/timeline-record.js";
import { EDITOR_EFFECTS_SCHEMA_VERSION } from "../../src/world/commit.js";
import { readWorldMeta, scanWorld } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

const PRODUCTION = "saltlight";
const CLOCK = () => "2026-10-11T12:00:00.000Z";
const relativeTimeline = `productions/${PRODUCTION}/timeline.json`;
const effect = () => defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", startFrame: 0, durationFrames: 240, seed: 42 });
const path = (store: WorldStore) => join(store.dir, relativeTimeline);
const production = (store: WorldStore) => store.getBundle().productions.find(value => value.meta.id === PRODUCTION)!;
const timeline = async (store: WorldStore): Promise<ProductionTimeline> => ProductionTimelineSchema.parse(JSON.parse(await readFile(path(store), "utf8")));

async function open() {
  const store = await WorldStore.open(await makeTempWorld(), { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return store;
}

async function create(store: WorldStore) {
  await applyHumanTimelineCommand(store, PRODUCTION, {
    kind: "commands", baseRevision: null, sourceFingerprint: storyTimelineFingerprint(production(store)), label: "Add floating dust",
    commands: [{ kind: "add-track", trackId: "tr_fx", trackKind: "effect", name: "Effects" },
      { kind: "effect-create", trackId: "tr_fx", effect: effect() }],
  });
  return timeline(store);
}

describe("procedural effect persistence (SPEC-053 R-21, R-26)", () => {
  it("keeps old worlds byte-stable on scan and fences the first effect in its one authored transaction", async () => {
    const store = await open();
    const before = await readFile(join(store.dir, "world.json"), "utf8");
    await scanWorld(store.dir);
    assert.equal(await readFile(join(store.dir, "world.json"), "utf8"), before);
    await assert.rejects(readFile(path(store), "utf8"), { code: "ENOENT" });
    const saved = await create(store);
    assert.equal(saved.revision, 1);
    assert.equal(saved.history.undo.length, 1);
    assert.equal(saved.migratedCut, true);
    assert.deepEqual(saved.tracks.find(track => track.id === "tr_fx")?.effects, [effect()]);
    assert.equal((await readWorldMeta(store.dir)).schemaVersion, EDITOR_EFFECTS_SCHEMA_VERSION);
    const currentWorld = await readFile(join(store.dir, "world.json"), "utf8");
    const currentTimeline = await readFile(path(store), "utf8");
    await assert.rejects(readWorldMeta(store.dir, { supports: EDITOR_EFFECTS_SCHEMA_VERSION - 1 }), /newer Arke Studio/);
    assert.equal(await readFile(join(store.dir, "world.json"), "utf8"), currentWorld);
    assert.equal(await readFile(path(store), "utf8"), currentTimeline);
    const lines = (await readFile(join(store.dir, "changes.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const written = lines.find(line => line.path === relativeTimeline);
    const raised = lines.find(line => line.entity === "world" && line.toVersion === EDITOR_EFFECTS_SCHEMA_VERSION);
    assert.ok(written && raised);
    assert.equal(written.commitId, raised.commitId, "the compatibility boundary and effects share the recovery transaction");
  });

  it("refuses a stale effect edit without touching timeline, schema or history", async () => {
    const store = await open();
    await create(store);
    const before = await readFile(path(store), "utf8");
    const journal = await readFile(join(store.dir, "changes.jsonl"), "utf8");
    await assert.rejects(applyHumanTimelineCommand(store, PRODUCTION, {
      kind: "commands", baseRevision: 0, sourceFingerprint: "", commands: [{ kind: "effect-patch", clipId: "cl_dust", patch: { appearance: { amount: 0.4 } } }],
    }), TimelineCommandRefused);
    assert.equal(await readFile(path(store), "utf8"), before);
    assert.equal(await readFile(join(store.dir, "changes.jsonl"), "utf8"), journal);
  });

  it("preserves exact procedural identity through removal, Undo, restart and Redo", async () => {
    const store = await open();
    await create(store);
    await applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: 1, sourceFingerprint: "",
      commands: [{ kind: "effect-remove", clipId: "cl_dust" }] });
    assert.deepEqual((await timeline(store)).tracks.find(track => track.id === "tr_fx")?.effects, []);
    await applyHumanTimelineCommand(store, PRODUCTION, { kind: "undo", baseRevision: 2 });
    assert.deepEqual((await timeline(store)).tracks.find(track => track.id === "tr_fx")?.effects, [effect()]);
    await store.close();
    const reopened = await WorldStore.open(store.dir, { clock: CLOCK });
    closeOnCleanup(() => reopened.close());
    assert.deepEqual((await timeline(reopened)).tracks.find(track => track.id === "tr_fx")?.effects, [effect()]);
    await applyHumanTimelineCommand(reopened, PRODUCTION, { kind: "redo", baseRevision: 3 });
    const redone = await timeline(reopened);
    assert.deepEqual(redone.tracks.find(track => track.id === "tr_fx")?.effects, []);
    assert.equal(redone.revision, 4);
    assert.equal((await readWorldMeta(reopened.dir)).schemaVersion, EDITOR_EFFECTS_SCHEMA_VERSION);
  });

  it("does not turn a generic accepted history request into human effect authority", async () => {
    const store = await open();
    await create(store);
    const before = await readFile(path(store), "utf8");
    await assert.rejects(applyTimelineCommand(store, PRODUCTION, { kind: "undo", baseRevision: 1, requestId: "act_human-claimed" }), /editor's Undo or Redo/);
    assert.equal(await readFile(path(store), "utf8"), before);
    await applyHumanTimelineCommand(store, PRODUCTION, { kind: "undo", baseRevision: 1 });
    assert.equal((await timeline(store)).tracks.some(track => track.kind === "effect"), false);
  });

  it("refreshes direct-edit protection baselines and restores an explicitly released rule with Undo", async () => {
    const store = await open();
    await create(store);
    await applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: 1, sourceFingerprint: "", commands: [
      { kind: "effect-protect", rule: { id: "pr_colour", lineageId: "ef_dust", kind: "property", property: "appearance.colour", scope: { kind: "whole" } } },
      { kind: "effect-protect", rule: { id: "pr_end", lineageId: "ef_dust", kind: "boundary", boundary: "end" } },
      { kind: "effect-protect", rule: { id: "pr_opening", lineageId: "ef_dust", kind: "passage-coverage", startFrame: 0, endFrame: 24 } },
    ] });
    const initialRules = (await timeline(store)).effectProtection!;
    await applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: 2, sourceFingerprint: "", commands: [
      { kind: "effect-patch", clipId: "cl_dust", patch: { appearance: { colour: "#2244ff" } } },
      { kind: "effect-trim", clipId: "cl_dust", edge: "tail", deltaFrames: -24 },
    ] });
    const authored = await timeline(store);
    const rules = authored.effectProtection!;
    assert.deepEqual(rules.map(rule => rule.id), initialRules.map(rule => rule.id));
    assert.notEqual(rules.find(rule => rule.id === "pr_colour")?.baselineFingerprint, initialRules.find(rule => rule.id === "pr_colour")?.baselineFingerprint);
    assert.notEqual(rules.find(rule => rule.id === "pr_end")?.baselineFingerprint, initialRules.find(rule => rule.id === "pr_end")?.baselineFingerprint);
    assert.equal(rules.find(rule => rule.id === "pr_opening")?.baselineFingerprint, initialRules.find(rule => rule.id === "pr_opening")?.baselineFingerprint);
    assert.equal(rules.find(rule => rule.id === "pr_opening")?.baselineRevision, initialRules.find(rule => rule.id === "pr_opening")?.baselineRevision);
    const before = await readFile(path(store), "utf8");
    await assert.rejects(applyTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: 3, sourceFingerprint: "", requestId: "act_claimed-human", commands: [
      { kind: "effect-release", ruleId: "pr_colour" },
    ] }), /explicit human editor action/);
    assert.equal(await readFile(path(store), "utf8"), before);
    await applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: 3, sourceFingerprint: "", commands: [
      { kind: "effect-release", ruleId: "pr_colour" },
    ] });
    assert.deepEqual((await timeline(store)).effectProtection?.map(rule => rule.id), ["pr_end", "pr_opening"]);
    await applyHumanTimelineCommand(store, PRODUCTION, { kind: "undo", baseRevision: 4 });
    const restored = await timeline(store);
    assert.deepEqual(restored.effectProtection, rules);
    assert.deepEqual(restored.tracks, authored.tracks);
    assert.equal((await readWorldMeta(store.dir)).schemaVersion, EDITOR_EFFECTS_SCHEMA_VERSION);
  });

  it("fences an adopted timeline whose effects remain only in retained history", async () => {
    const source = await open();
    await create(source);
    await applyHumanTimelineCommand(source, PRODUCTION, { kind: "undo", baseRevision: 1 });
    const raw = await readFile(path(source), "utf8");
    assert.equal((await timeline(source)).tracks.some(track => track.kind === "effect"), false);
    assert.equal(carriesEditorEffects(raw), true);
    const destination = await open();
    await destination.commit({ kind: "adopt-timeline", source: "test", files: [{ path: relativeTimeline, action: "create", content: raw, baseHash: null }] });
    assert.equal((await readWorldMeta(destination.dir)).schemaVersion, EDITOR_EFFECTS_SCHEMA_VERSION);
    assert.equal(await readFile(path(destination), "utf8"), raw);
    await assert.rejects(readWorldMeta(destination.dir, { supports: 73 }), /newer Arke Studio/);
  });

  it("binds measured placed sound, permits muted sources and preserves a missing binding across later edits", async () => {
    const store = await open();
    await create(store);
    const sound = store.getBundle().artifacts.find(artifact => artifact.kind === "audio")!;
    const still = store.getBundle().artifacts.find(artifact => artifact.kind === "board" || artifact.kind === "image")!;
    assert.ok(sound && still);
    await applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: 1, sourceFingerprint: "", commands: [
      { kind: "add-track", trackId: "tr_sound", trackKind: "audio", name: "Sound" },
      { kind: "place", trackId: "tr_sound", clip: { id: "cl_song", startFrame: 0, durationFrames: 120, sourceInFrames: 0, source: { kind: "artifact", artifactId: sound.id, label: "Song" } } },
      { kind: "set-track", trackId: "tr_sound", muted: true },
      { kind: "place", trackId: "tr_picture", clip: { id: "cl_still", startFrame: 0, durationFrames: 240, sourceInFrames: 0, source: { kind: "artifact", artifactId: still.id, label: "Still" } } },
    ] });
    const before = await readFile(path(store), "utf8");
    await assert.rejects(applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: 2, sourceFingerprint: "", commands: [
      { kind: "effect-patch", clipId: "cl_dust", patch: { audioInput: { kind: "video-sound", clipId: "cl_still" }, reaction: { enabled: true } } },
    ] }), /not known to contain video sound/);
    assert.equal(await readFile(path(store), "utf8"), before);
    await applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: 2, sourceFingerprint: "", commands: [
      { kind: "effect-patch", clipId: "cl_dust", patch: { audioInput: { kind: "audio-clip", clipId: "cl_song" }, reaction: { enabled: true } } },
    ] });
    await applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: 3, sourceFingerprint: "", commands: [{ kind: "delete", clipId: "cl_song" }] });
    await applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: 4, sourceFingerprint: "", commands: [
      { kind: "effect-patch", clipId: "cl_dust", patch: { appearance: { amount: 0.4 } } },
      { kind: "effect-split", clipId: "cl_dust", atFrame: 120, newClipId: "cl_dust_tail" },
    ] });
    const effects = (await timeline(store)).tracks.find(track => track.id === "tr_fx")!.effects!;
    assert.equal(effects.length, 2);
    for (const item of effects) assert.deepEqual(item.audioInput, { kind: "audio-clip", clipId: "cl_song" });
  });

  it("retains unknown future effect bytes and refuses edits without deriving another timeline", async () => {
    const store = await open();
    await create(store);
    const saved = await timeline(store);
    await store.close();
    const future = JSON.parse(JSON.stringify(saved));
    future.tracks.find((track: { id: string }) => track.id === "tr_fx").effects[0].preset.version = 99;
    const raw = JSON.stringify(future, null, 2) + "\n";
    await writeFile(path(store), raw);
    const reopened = await WorldStore.open(store.dir, { clock: CLOCK });
    closeOnCleanup(() => reopened.close());
    assert.equal(production(reopened).timeline?.status, "invalid");
    await assert.rejects(applyHumanTimelineCommand(reopened, PRODUCTION, { kind: "commands", baseRevision: 1, sourceFingerprint: "",
      commands: [{ kind: "effect-remove", clipId: "cl_dust" }] }), /timeline.json is invalid|external edits awaiting reconciliation/);
    assert.equal(await readFile(path(reopened), "utf8"), raw);
  });
});
