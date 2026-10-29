import assert from "node:assert/strict";
import { it } from "node:test";
import { AppSettingsSchema, OllamaSettingsSchema, normalizeOllamaUrl } from "../src/index.js";

it("old settings select managed Ollama; only an explicit local URL overrides it", () => {
  assert.deepEqual(AppSettingsSchema.parse({}).ollama, { engineUrl: null, modelsDir: null });
  assert.equal(normalizeOllamaUrl("http://localhost:11434/"), "http://localhost:11434");
  assert.equal(normalizeOllamaUrl("http://[::1]:11434"), "http://[::1]:11434");
  for (const url of ["https://localhost", "http://example.com", "http://localhost.evil.test", "http://a:b@localhost", "http://localhost/api", "http://localhost?q=1", "http://localhost/#key"]) {
    assert.equal(OllamaSettingsSchema.safeParse({ engineUrl: url }).success, false, url);
  }
});
