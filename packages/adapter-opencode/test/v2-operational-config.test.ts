import assert from "node:assert/strict";
import { it } from "node:test";
import { buildSessionConfigV2 } from "../src/v2/config.js";

for (const role of ["studio-assistant", "diagnostic-specialist"]) it(`${role} has an isolated native policy and no automatic helper inference`, () => {
  const config = buildSessionConfigV2({ agent: role, model: "ollama/qualified", researchWeb: true, worldQueryUrl: "http://private.invalid" });
  assert.equal(config.mcp, undefined);
  assert.equal(config.default_agent, role); assert.equal(config.warming, false); assert.equal(config.websearch, false);
  assert.deepEqual(config.compaction, { auto: false }); assert.deepEqual(config.permissions, [{ action: "*", resource: "*", effect: "deny" }]);
  const agents = config.agents as Record<string, { disabled?: boolean; permissions?: unknown }>;
  assert.deepEqual(agents[role]?.permissions, config.permissions);
  assert.equal(agents["world-builder"], undefined); assert.equal(agents["scene-writer"], undefined);
  for (const helper of ["title", "compaction", "summary", "build", "plan", "explore", "general"]) assert.equal(agents[helper]?.disabled, true);
  assert.deepEqual(config.experimental, { policies: [{ action: "tool.use", resource: "*", effect: "deny" }, { action: "integration.use", resource: "*", effect: "deny" },
    { action: "provider.use", resource: "*", effect: "deny" }, { action: "provider.use", resource: "ollama", effect: "allow" }] });
});
it("does not let an operational provider identity become a resource-policy glob", () => {
  for (const model of ["*/model", "open[ai]/model", "ollama", "/model"]) assert.throws(() => buildSessionConfigV2({ agent: "studio-assistant", model }), /literal native policy/);
});
it("keeps ordinary writing configuration and its native helpers on the existing path", () => {
  const config = buildSessionConfigV2({ agent: "scene-writer", model: "ollama/writer" });
  assert.equal(config.experimental, undefined); assert.equal(config.warming, undefined); assert.equal(config.compaction, undefined);
  assert.equal((config.agents as Record<string, unknown>).title, undefined);
  assert(config.permissions && JSON.stringify(config.permissions).includes('"effect":"allow"'));
});
