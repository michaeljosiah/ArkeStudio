import assert from "node:assert/strict";
import { it } from "node:test";
import { ROSTER, confinementFor } from "@arke-studio/contracts";
import { buildSessionConfigV2 } from "@arke-studio/adapter-opencode";
import { assessV2Permission } from "../../../adapter-opencode/src/v2/config.js";
import { sessionPermissionPolicy } from "../../../adapter-opencode/src/permission-policy.js";
import { decideTool, sessionSurface } from "@arke-studio/adapter-claude";
import { captureRootIdentity } from "../../../adapter-codex/src/confined-files.js";
import { ConfinementError, executeTool, resolveRoot, toolsFor, type ToolSession } from "../../../adapter-codex/src/tools.js";
import { scopeSessionInput } from "../../src/harness/session-files.js";
import { tempDir } from "../tmp.js";

it("enforces the operational roles in OpenCode v2, Claude and Codex tool boundaries", async () => {
  const root = await resolveRoot(await tempDir("arke-operational-tools-"));
  for (const name of ["studio-assistant", "diagnostic-specialist"]) {
    const member = ROSTER.find(value => value.name === name)!, confinement = confinementFor(member, { web: true });
    const config = buildSessionConfigV2(scopeSessionInput({ agent: name, researchWeb: true, worldQueryUrl: "http://private.invalid" }));
    assert.equal(config.mcp, undefined);
    const policy = sessionPermissionPolicy(name, { researchWeb: true });
    assert.equal(assessV2Permission(policy, "future_native_writer").status, "denied");
    assert.equal(assessV2Permission(policy, "todo").status, "denied");
    assert.equal(assessV2Permission(sessionPermissionPolicy("world-builder", {}), "future_native_writer").status, "ask", "Ordinary role permission policy remains unchanged");
    const rules = (config.agents as Record<string, { permissions: Array<{ action: string; resource: string; effect: string }> }>)[name]!.permissions;
    assert.deepEqual(rules, [{ action: "*", resource: "*", effect: "deny" }], `${name} denies known and future native tools without later re-allows`);
    assert.equal(sessionSurface(confinement, false).world, false);
    for (const tool of ["Read", "Edit", "Bash", "WebFetch", "Task", "mcp__arke-world__get_entry"]) {
      assert.equal((await decideTool(confinement, tool, { root, input: {} })).allow, false, `${name}/${tool}`);
    }
    const session: ToolSession = { root, rootIdentity: await captureRootIdentity(root), confinement, worldTools: new Map() };
    assert(!toolsFor(session).some(tool => /^(read|write|edit|search|list|arke-world)/.test(tool.name)));
    for (const tool of ["read", "write", "edit", "search", "list", "arke-world_get_entry"]) {
      await assert.rejects(executeTool(session, tool, {}, new AbortController().signal), ConfinementError, `${name}/${tool}`);
    }
  }
});
