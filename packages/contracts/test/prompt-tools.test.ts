import assert from "node:assert/strict";
import { it } from "node:test";
import { AppSettingsSchema, ClientMessageSchema, DomainEventSchema, PromptInspectionSchema } from "../src/index.js";

const id = "01J8F3K2QW9VZX4N7M0RTYB6HC", hash = `sha256:${"a".repeat(64)}`;
const restore = { kind: "prompt-history-restore", worldId: id, requestId: id, productionId: "saltlight", sceneId: "sc_04", shotId: "sh_12", capability: "image",
  assembledHash: hash, baseVersion: 21, baseHash: hash, sourceVersion: 19, sourceHash: hash };
it("makes optional prompt tools opt-in while tolerating a malformed isolated preference", () => {
  assert.notEqual(AppSettingsSchema.parse({}).promptTools, true);
  assert.equal(AppSettingsSchema.parse({ promptTools: true }).promptTools, true);
  assert.equal(AppSettingsSchema.parse({ promptTools: "true", appearance: { theme: "dark" } }).promptTools, false);
  assert.equal(AppSettingsSchema.parse({ promptTools: [], appearance: { theme: "dark" } }).appearance.theme, "dark");
});
it("accepts only a fenced history identity, never renderer-supplied historical words or provenance", () => {
  assert.ok(ClientMessageSchema.safeParse(restore).success);
  for (const invalid of [{ ...restore, sourceHash: "sha256:abcd" }, { ...restore, sourceVersion: 0 }, { ...restore, text: "Forged history" },
    { ...restore, sheetVersions: { maren: 99 } }, { ...restore, capability: "voice" }]) assert.equal(ClientMessageSchema.safeParse(invalid).success, false);
});
it("bounds transient inspection facts and excludes arbitrary provider payload fields", () => {
  const value = { source: "saved-shot", identity: "sc_04 v21", capability: "image", provider: "fal", model: "image", prompt: "Compiled prompt", quantity: 1,
    controls: [], references: [], notices: [] };
  assert.ok(PromptInspectionSchema.safeParse(value).success);
  assert.equal(PromptInspectionSchema.safeParse({ ...value, headers: { authorization: "secret" } }).success, false);
  assert.equal(PromptInspectionSchema.safeParse({ ...value, prompt: "x".repeat(200_001) }).success, false);
  assert.ok(DomainEventSchema.safeParse({ type: "prompt-tools.result", at: "2026-11-01T12:00:00.000Z", requestId: id, worldId: id,
    result: { kind: "inspection", inspection: value } }).success);
});
