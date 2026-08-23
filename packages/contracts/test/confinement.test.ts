import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentPromptFor, confinementFor, permits, ROSTER, ToolIntent } from "../src/index.js";

describe("agent confinement (SPEC-005 R-10, R-17)", () => {
  it("lets an authoring agent edit inside its proposal and read the world", () => {
    const authoring = confinementFor({ readOnly: false });
    for (const intent of ["read", "edit", "search", "list", "todo", "world-query", "skill"] as const) {
      assert.equal(permits(authoring, intent), true, `authoring may ${intent}`);
    }
  });

  it("takes editing away entirely from an agent that answers rather than authors (#70 §8.1)", () => {
    const readOnly = confinementFor({ readOnly: true });
    assert.equal(permits(readOnly, "edit"), false, "its propositions go through the accept gate, not the filesystem");
    assert.equal(permits(readOnly, "read"), true);
    assert.equal(permits(readOnly, "world-query"), true, "it still has to be able to check canon");
  });

  it("gives a read-only agent no skill, because nothing is drafted for one to shape (R-17)", () => {
    assert.equal(permits(confinementFor({ readOnly: true }), "skill"), false);
  });

  it("lets neither role delegate — a deliberate change, not a preserved behaviour", () => {
    // v2 denied `subagent` to read-only agents and never granted it to authoring ones; v1 left
    // `task` unlisted for authoring, so it landed on the harness's ask default. There was no
    // single prior behaviour to keep, and v2's stricter reading wins: a child session escapes
    // the per-prompt agent pinning and was observed burning a live turn's budget for nothing.
    assert.equal(permits(confinementFor({ readOnly: false }), "delegate"), false);
    assert.equal(permits(confinementFor({ readOnly: true }), "delegate"), false);
  });

  it("is an allowlist — nothing outside `allow` is permitted, including intents added later", () => {
    for (const agent of [{ readOnly: true }, { readOnly: false }]) {
      const confinement = confinementFor(agent);
      for (const intent of ToolIntent.options) {
        assert.equal(
          permits(confinement, intent),
          confinement.allow.includes(intent),
          `${intent} is decided by the allowlist alone`,
        );
      }
    }
  });

  /**
   * The gap this closes was not a policy anyone chose. "No network" was written as a permanent
   * NEVER in both OpenCode renderers and as an absence from Claude's table, so asking an agent to
   * go and look something up produced a refusal no confinement had decided and none could undo —
   * while the person who asked saw only an agent that would not do as it was told.
   */
  it("lets both roles research online when Settings permits it, and neither when it does not", () => {
    for (const readOnly of [true, false]) {
      assert.equal(permits(confinementFor({ readOnly }, { web: true }), "web"), true);
      assert.equal(permits(confinementFor({ readOnly }, { web: false }), "web"), false);
      assert.equal(
        permits(confinementFor({ readOnly }), "web"),
        false,
        "and a caller that never read settings grants nothing — off is the setting's own default",
      );
    }
  });

  it("takes nothing else away when research is on", () => {
    // The grant is additive: an earlier draft rebuilt the allowlist and it would have been easy
    // to drop an intent while adding one, silently, since every role still has most of them.
    for (const readOnly of [true, false]) {
      const off = confinementFor({ readOnly });
      const on = confinementFor({ readOnly }, { web: true });
      for (const intent of off.allow) assert.equal(permits(on, intent), true, `${intent} survives`);
    }
  });

  it("tells an agent to cite what it read, exactly when it is the one permitted to read", () => {
    for (const member of ROSTER) {
      const cite = /Say the URL you took a claim from/;
      assert.match(
        agentPromptFor({ ...member, researchWeb: true }),
        cite,
        `${member.name} is told to cite a source it fetched`,
      );
      assert.equal(
        cite.test(agentPromptFor({ ...member, researchWeb: false })),
        false,
        `${member.name} is not offered a tool the gate would refuse`,
      );
      // The shipped roster prompt is the research-off one, because that is the shipped setting.
      assert.equal(cite.test(member.prompt), false, `${member.name}'s default prompt stays offline`);
    }
  });

  it("covers every agent actually on the roster, so none falls through to a default", () => {
    for (const member of ROSTER) {
      const confinement = confinementFor(member);
      assert.ok(confinement.allow.length > 0, `${member.name} has a confinement`);
      assert.equal(
        permits(confinement, "edit"),
        member.readOnly !== true,
        `${member.name}'s editing rights follow its readOnly flag, not its name`,
      );
    }
  });
});
