import assert from "node:assert/strict";
import { it } from "node:test";
import { OpenCodeV2Adapter } from "../src/v2/opencode-v2-adapter.js";
import { buildSessionConfigV2 } from "../src/v2/config.js";
import { privateControlDirectory } from "../src/v2/private-control.js";

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
