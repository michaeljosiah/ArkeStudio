import assert from "node:assert/strict";
import { it } from "node:test";
import type { HarnessAdapter } from "@arke-studio/contracts";
import { studioModelChoices } from "../../src/studio-assistant/models.js";

it("offers only models with a current private owner, excluding embeddings and unsupported providers", () => {
  let ready = true, owned = true;
  const adapter = { readiness: () => ({ ready }), privateSessions: true } as HarnessAdapter;
  const models = [{ id: "gemma", provider: "ollama" }, { id: "nomic-embed-text", provider: "ollama" }, { id: "chat", provider: "cloud" }];
  const destination = (_model: string, provider: string) => owned && provider === "ollama";
  assert.deepEqual(studioModelChoices(adapter, models, destination), ["ollama/gemma"]);
  owned = false; assert.deepEqual(studioModelChoices(adapter, models, destination), []);
  owned = true; ready = false; assert.deepEqual(studioModelChoices(adapter, models, destination), []);
  ready = true; assert.deepEqual(studioModelChoices({ ...adapter, privateSessions: undefined }, models, destination), []);
});
