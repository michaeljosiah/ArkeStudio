import assert from "node:assert/strict";
import { it } from "node:test";
import { confinementFor, ROSTER } from "@arke-studio/contracts";
import { assessV2Permission, buildSessionConfigV2, sessionRulesV2 } from "../src/v2/config.js";

for (const role of ["studio-assistant", "diagnostic-specialist"]) it(`${role} has an isolated native policy and no automatic helper inference`, () => {
  const config = buildSessionConfigV2({ agent: role, model: "ollama/qualified", researchWeb: true, worldQueryUrl: "http://private.invalid" });
  assert.equal(config.mcp, undefined);
  assert.equal(config.default_agent, role); assert.equal(config.warming, false); assert.equal(config.websearch, false);
  assert.deepEqual(config.compaction, { auto: false }); assert.deepEqual(config.permissions, [{ action: "*", resource: "*", effect: "deny" }]);
  const agents = config.agents as Record<string, { disabled?: boolean; permissions?: unknown }>;
  assert.deepEqual(agents[role]?.permissions, config.permissions);
  assert.equal(agents["world-builder"], undefined); assert.equal(agents["scene-writer"], undefined);
  for (const helper of ["title", "compaction", "summary", "build", "plan", "explore", "general"]) assert.equal(agents[helper]?.disabled, true);
  assert.equal(config.experimental, undefined);
  assert.deepEqual(config.policies, [{ action: "tool.use", resource: "*", effect: "deny" }, { action: "mcp.use", resource: "*", effect: "deny" },
    { action: "skill.use", resource: "*", effect: "deny" }, { action: "plugin.use", resource: "*", effect: "deny" },
    { action: "integration.use", resource: "*", effect: "deny" }, { action: "integration.use", resource: "ollama", effect: "allow" },
    { action: "provider.use", resource: "*", effect: "deny" }, { action: "provider.use", resource: "ollama", effect: "allow" }]);
});
it("does not let an operational provider identity become a resource-policy glob", () => {
  for (const model of ["*/model", "open[ai]/model", "ollama", "/model"]) assert.throws(() => buildSessionConfigV2({ agent: "studio-assistant", model }), /literal native policy/);
});
it("denies the engine's own tools to roster agents and keeps edit under the session directory", () => {
  const agents = buildSessionConfigV2({ model: "ollama/writer" }).agents as Record<string, { permissions: Array<{ action: string; resource: string; effect: string }> }>;
  const writer = agents["sheet-editor"]!.permissions, reader = agents["conversation-namer"]!.permissions;
  for (const rules of [writer, reader]) for (const action of ["shell", "execute", "opencode_*", "experimental_image_generate"]) {
    assert(rules.some(rule => rule.action === action && rule.resource === "*" && rule.effect === "deny"), action);
  }
  // The engine hides a tool only when the last rule naming it has resource `*`, so a reader's
  // edit must stay a single deny, and a writer's path rules must come after its allow.
  assert.deepEqual(reader.filter(rule => rule.action === "edit"), [{ action: "edit", resource: "*", effect: "deny" }]);
  assert.deepEqual(writer.filter(rule => rule.action === "edit").map(rule => [rule.resource, rule.effect]),
    [["*", "allow"], ["..", "deny"], ["../*", "deny"], ["/*", "deny"], ["?:/*", "deny"]]);
  const policy = { confinement: confinementFor(ROSTER.find(member => member.name === "sheet-editor")!, { web: false }) };
  for (const action of ["execute", "opencode_worktree_create", "experimental_image_generate"]) assert.equal(assessV2Permission(policy, action).status, "denied", action);
});
it("repeats a denied skill as the session's own last rule", () => {
  const deny = [{ action: "skill", resource: "*", effect: "deny" }];
  assert.deepEqual(sessionRulesV2("conversation-namer"), deny); assert.deepEqual(sessionRulesV2("studio-assistant"), deny);
  assert.deepEqual(sessionRulesV2("sheet-editor"), []); assert.deepEqual(sessionRulesV2(undefined), []);
});
it("keeps ordinary writing configuration and its native helpers on the existing path", () => {
  const config = buildSessionConfigV2({ agent: "scene-writer", model: "ollama/writer" });
  assert.equal(config.policies, undefined); assert.equal(config.warming, undefined); assert.equal(config.compaction, undefined);
  assert.equal((config.agents as Record<string, unknown>).title, undefined);
  assert(config.permissions && JSON.stringify(config.permissions).includes('"effect":"allow"'));
});

for (const role of ["voice-companion", "voice-worker"]) it(`${role} allows only its captured MCP tools above an unknown-tool deny`, () => {
  const config = buildSessionConfigV2({ agent: role, model: "cloud/chosen", worldQueryUrl: "http://127.0.0.1:1234/mcp/lease" });
  const agent = (config.agents as Record<string, { permissions: unknown }>)[role]!;
  assert.deepEqual(agent.permissions, [{ action: "*", resource: "*", effect: "deny" }, { action: "arke-world_*", resource: "*", effect: "allow" }]);
  assert(config.mcp);
  assert.deepEqual(config.compaction, { auto: false });
  for (const helper of ["title", "compaction", "summary", "build", "plan", "explore", "general"])
    assert.equal((config.agents as Record<string, { disabled?: boolean }>)[helper]?.disabled, true);
  const policy = { confinement: confinementFor(ROSTER.find(member => member.name === role)!) };
  assert.equal(assessV2Permission(policy, "arke-world_search_canon").status, "allowed");
  for (const action of ["read", "edit", "subagent", "future_tool"]) assert.equal(assessV2Permission(policy, action).status, "denied");
});
