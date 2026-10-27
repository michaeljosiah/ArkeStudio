import assert from "node:assert/strict";
import { it } from "node:test";
import { OpenCodeV2Adapter } from "../src/v2/opencode-v2-adapter.js";
import { buildSessionConfigV2 } from "../src/v2/config.js";
import { privateControlDirectory, privateWireBody } from "../src/v2/private-control.js";

it("writes fixed private control code before its config with one literal native integration allow", () => {
  const adapter = new OpenCodeV2Adapter({ baseUrl: () => "http://127.0.0.1:0", password: () => null });
  for (const agent of ["studio-assistant", "diagnostic-specialist"]) {
    const files = adapter.sessionFiles({ agent, model: "ollama/model" }, "/private/control");
    assert.deepEqual(files.map(file => file.name), [".arke-private-control/package.json", ".arke-private-control/index.js", "opencode.json"]);
    assert.match(files[1]!.contents, /event\.decision = \{ retry: false \}/);
    assert(!files[1]!.contents.includes("fetch")); assert(!files[1]!.contents.includes("console"));
    const config = JSON.parse(files[2]!.contents), path = privateControlDirectory("/private/control");
    assert.deepEqual(config.plugins, [path]);
    assert.deepEqual(config.experimental.policies.filter((rule: { action: string; effect: string }) => rule.action === "integration.use"), [
      { action: "integration.use", resource: "*", effect: "deny" }, { action: "integration.use", resource: `plugin:${path}`, effect: "allow" },
    ]);
    assert.deepEqual(config.permissions, [{ action: "*", resource: "*", effect: "deny" }]);
    assert.throws(() => adapter.sessionFiles({ agent, model: "ollama/model" }), /session directory/);
  }
  const ordinary = adapter.sessionFiles({ agent: "scene-writer" });
  assert.equal(ordinary.length, 1); assert.equal(JSON.parse(ordinary[0]!.contents).plugins, undefined);
});

it("refuses private control paths that could broaden a native glob policy", () => {
  for (const path of ["/private/*", "/private/[owner]", "/private/?", "/private/{owner}"]) {
    assert.throws(() => privateControlDirectory(path), /literal policy/);
    assert.throws(() => buildSessionConfigV2({ agent: "studio-assistant" }, path), /literal policy/);
  }
  assert.throws(() => privateControlDirectory("relative"), /absolute/);
});

it("binds the private manifest to native activation without turning request text into code", () => {
  const adapter = new OpenCodeV2Adapter({ baseUrl: () => "http://127.0.0.1:0", password: () => null });
  const request = { model: "ollama/model", system: "Reviewed system", prompt: 'PRIVATE_PROMPT"; throw new Error("injection");', outputTokenLimit: 4096 };
  const files = adapter.sessionFiles({ agent: "studio-assistant", model: request.model }, "/private/manifest", request);
  assert.match(files[1]!.contents, /id: "arke\.studio\.private-control\.v1\.[a-f0-9]{64}"/);
  assert(!files[1]!.contents.includes(request.prompt));
  assert.deepEqual(JSON.parse(files[2]!.contents).plugins[0].options.body, privateWireBody(request));
  const changed = adapter.sessionFiles({ agent: "studio-assistant", model: request.model }, "/private/manifest", { ...request, prompt: "Different reviewed prompt" });
  assert.notEqual(files[1]!.contents, changed[1]!.contents);
  assert.throws(() => adapter.sessionFiles({ agent: "scene-writer", model: request.model }, "/ordinary", request), /does not match/);
  for (const invalid of [{ ...request, outputTokenLimit: 4097 }, { ...request, outputTokenLimit: 0 }, { ...request, system: "x".repeat(32 * 1024 + 1) }, { ...request, prompt: "x".repeat(192 * 1024 + 1) }]) assert.throws(() => privateWireBody(invalid), /Invalid private/);
});
